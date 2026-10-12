"""Квалифицированная подпись PAdES (ADR-0205): подготовка, встраивание, проверка.

Удостоверяющий центр — тестовый: корень, сертификат подписанта и TSA создаются здесь;
OCSP и TSA — заглушки HTTP на 127.0.0.1. Агента УЦ изображает `SimpleSigner` pyHanko:
он подписывает хэш `ByteRange` и возвращает CMS, как агент на рабочем месте.
"""

import base64
import datetime as dt
import hashlib
import io
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from asn1crypto import keys, tsp
from asn1crypto import x509 as asn1_x509
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509 import ocsp
from cryptography.x509.oid import AuthorityInformationAccessOID, ExtendedKeyUsageOID, NameOID
from pyhanko.sign import signers
from pyhanko.sign.timestamps import HTTPTimeStamper
from pyhanko.sign.timestamps.dummy_client import DummyTimeStamper
from pyhanko_certvalidator.registry import SimpleCertificateStore
from pypdf import PdfWriter

from kchs_engine.api import checked_body
from kchs_engine.jobs import signature as signature_job
from kchs_engine.sign import pades

# ─── Тестовый УЦ ─────────────────────────────────────────────────────────────


def _name(common: str, organization: str | None = None) -> x509.Name:
    attrs = [x509.NameAttribute(NameOID.COMMON_NAME, common)]
    if organization:
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATION_NAME, organization))
    attrs.append(x509.NameAttribute(NameOID.COUNTRY_NAME, "TJ"))
    return x509.Name(attrs)


def _key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _cert(
    subject: x509.Name,
    issuer: x509.Name,
    key: rsa.RSAPrivateKey,
    issuer_key: rsa.RSAPrivateKey,
    *,
    ca: bool,
    eku: list[x509.ObjectIdentifier] | None = None,
    ocsp_url: str | None = None,
) -> x509.Certificate:
    now = dt.datetime.now(dt.UTC)
    builder = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                content_commitment=not ca,
                key_encipherment=False,
                data_encipherment=False,
                key_agreement=False,
                key_cert_sign=ca,
                crl_sign=ca,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
    )
    if eku:
        builder = builder.add_extension(x509.ExtendedKeyUsage(eku), critical=True)
    if ocsp_url:
        builder = builder.add_extension(
            x509.AuthorityInformationAccess(
                [
                    x509.AccessDescription(
                        AuthorityInformationAccessOID.OCSP, x509.UniformResourceIdentifier(ocsp_url)
                    )
                ]
            ),
            critical=False,
        )
    return builder.sign(issuer_key, hashes.SHA256())


def _asn1(cert: x509.Certificate) -> asn1_x509.Certificate:
    return asn1_x509.Certificate.load(cert.public_bytes(serialization.Encoding.DER))


def _asn1_key(key: rsa.RSAPrivateKey) -> keys.PrivateKeyInfo:
    return keys.PrivateKeyInfo.load(
        key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )


class _Quiet(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        return


@dataclass
class FakeAuthority:
    """Корень, подписанты и TSA; OCSP и TSA отвечают по HTTP с 127.0.0.1."""

    root_key: rsa.RSAPrivateKey
    root: x509.Certificate
    tsa_key: rsa.RSAPrivateKey
    tsa: x509.Certificate
    ocsp_url: str
    tsa_url: str
    revoked: set[int] = field(default_factory=set)
    ocsp_requests: int = 0
    tsa_requests: int = 0

    def signer(self, name: str = "Саидзода Тахир Раҳимович") -> tuple[x509.Certificate, Any]:
        key = _key()
        cert = _cert(
            _name(name, "Комитет по ЧС и ГО"),
            self.root.subject,
            key,
            self.root_key,
            ca=False,
            ocsp_url=self.ocsp_url,
        )
        return cert, key

    @property
    def root_pem(self) -> str:
        return self.root.public_bytes(serialization.Encoding.PEM).decode("ascii")

    def policy(self, **overrides: Any) -> pades.Policy:
        values: dict[str, Any] = {
            "trust_roots": [_asn1(self.root)],
            "revocation": "hard-fail",
            "fetch": True,
        }
        values.update(overrides)
        return pades.Policy(**values)

    def ocsp_response(self, request: bytes) -> bytes:
        self.ocsp_requests += 1
        parsed = ocsp.load_der_ocsp_request(request)
        now = dt.datetime.now(dt.UTC)
        revoked = parsed.serial_number in self.revoked
        builder = ocsp.OCSPResponseBuilder().add_response_by_hash(
            issuer_name_hash=parsed.issuer_name_hash,
            issuer_key_hash=parsed.issuer_key_hash,
            serial_number=parsed.serial_number,
            algorithm=parsed.hash_algorithm,
            cert_status=ocsp.OCSPCertStatus.REVOKED if revoked else ocsp.OCSPCertStatus.GOOD,
            this_update=now - dt.timedelta(minutes=1),
            next_update=now + dt.timedelta(hours=1),
            revocation_time=now - dt.timedelta(minutes=5) if revoked else None,
            revocation_reason=x509.ReasonFlags.key_compromise if revoked else None,
        )
        response = builder.responder_id(ocsp.OCSPResponderEncoding.HASH, self.root).sign(
            self.root_key, hashes.SHA256()
        )
        return response.public_bytes(serialization.Encoding.DER)

    def tsa_response(self, request: bytes) -> bytes:
        self.tsa_requests += 1
        stamper = DummyTimeStamper(
            tsa_cert=_asn1(self.tsa),
            tsa_key=_asn1_key(self.tsa_key),
            certs_to_embed=SimpleCertificateStore.from_certs([_asn1(self.root)]),
        )
        query = tsp.TimeStampReq.load(request)
        return stamper.request_tsa_response(query).dump()


@pytest.fixture(scope="module")
def ca() -> Iterator[FakeAuthority]:
    holder: dict[str, FakeAuthority] = {}

    class Handler(_Quiet):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers.get("content-length") or 0))
            if self.path.startswith("/ocsp"):
                data, kind = holder["ca"].ocsp_response(body), "application/ocsp-response"
            else:
                data, kind = holder["ca"].tsa_response(body), "application/timestamp-reply"
            self.send_response(200)
            self.send_header("content-type", kind)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    root_key = _key()
    root = _cert(
        _name("Тестовый УЦ Комитета"), _name("Тестовый УЦ Комитета"), root_key, root_key, ca=True
    )
    tsa_key = _key()
    tsa = _cert(
        _name("Тестовая служба штампов времени"),
        root.subject,
        tsa_key,
        root_key,
        ca=False,
        eku=[ExtendedKeyUsageOID.TIME_STAMPING],
    )
    holder["ca"] = FakeAuthority(root_key, root, tsa_key, tsa, f"{base}/ocsp", f"{base}/tsa")
    yield holder["ca"]
    server.shutdown()


def blank_pdf(pages: int = 1) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(595, 842)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


async def agent_sign(digest: bytes, cert: x509.Certificate, key: Any, ca: FakeAuthority) -> bytes:
    """Агент УЦ: CMS detached над хэшем, сертификат подписанта и корень внутри."""
    signer = signers.SimpleSigner(
        signing_cert=_asn1(cert),
        signing_key=_asn1_key(key),
        cert_registry=SimpleCertificateStore.from_certs([_asn1(ca.root)]),
    )
    content = await signer.async_sign(digest, "sha256", use_pades=True)
    return bytes(content.dump())


def fingerprint(cert: x509.Certificate) -> str:
    return hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest()


STAMP = [
    "ДОКУМЕНТ ПОДПИСАН КВАЛИФИЦИРОВАННОЙ ЭЛЕКТРОННОЙ ПОДПИСЬЮ",
    "Сертификат: 4f2a91",
    "Владелец: Саидзода Тахир Раҳимович",
    "Действителен: с 01.01.2026 по 01.01.2027",
]


async def sign_once(
    source: bytes, ca: FakeAuthority, cert: x509.Certificate, key: Any, field_name: str
) -> bytes:
    prepared = await pades.prepare(
        source, field_name=field_name, stamp_lines=STAMP, url="https://kchs.test/api/v1/verify/x"
    )
    der = await agent_sign(prepared.digest, cert, key, ca)
    return await pades.attach(
        prepared,
        der,
        certificate_sha256=fingerprint(cert),
        timestamper=HTTPTimeStamper(ca.tsa_url),
    )


# ─── Подготовка, встраивание, проверка ──────────────────────────────────────


async def test_full_cycle_is_pades_b_t_with_good_revocation(ca: FakeAuthority) -> None:
    cert, key = ca.signer()
    requests = ca.ocsp_requests
    signed = await sign_once(blank_pdf(2), ca, cert, key, "kchs-sig-1")

    checked = await pades.validate(signed, "kchs-sig-1", ca.policy())
    validation = checked["validation"]
    assert validation["intact"] and validation["valid"] and validation["trusted"]
    assert validation["revocation"] == "good"
    assert validation["timestampAt"] is not None
    assert validation["coverage"] == "entire_file"
    assert validation["problem"] is None
    assert ca.ocsp_requests > requests, "отзыв проверен ответом OCSP"
    info = checked["certificate"]
    assert info["owner"] == "Саидзода Тахир Раҳимович"
    assert info["organization"] == "Комитет по ЧС и ГО"
    assert info["fingerprint"] == fingerprint(cert)
    assert info["serial"] == format(cert.serial_number, "x")
    # Штамп нарисован шрифтом с кириллицей: встроено подмножество FreeSans (в образе движка)
    if pades.STAMP_FONT.exists():
        assert b"FreeSans" in signed
    # Отчёт движка проходит контракт обратного вызова
    checked_body(
        "documentSignatureDone",
        {"step": "attach", "status": "ready", "size": len(signed), "sha256": "0" * 64, **checked},
    )


async def test_second_signer_keeps_first_signature_valid(ca: FakeAuthority) -> None:
    first_cert, first_key = ca.signer("Первый Подписант")
    second_cert, second_key = ca.signer("Второй Подписант")
    once = await sign_once(blank_pdf(), ca, first_cert, first_key, "kchs-sig-a")
    twice = await sign_once(once, ca, second_cert, second_key, "kchs-sig-b")

    assert pades.signed_fields(twice) == ["kchs-sig-a", "kchs-sig-b"]
    first = await pades.validate(twice, "kchs-sig-a", ca.policy())
    second = await pades.validate(twice, "kchs-sig-b", ca.policy())
    assert first["validation"]["trusted"] and first["validation"]["intact"]
    assert first["validation"]["coverage"] == "entire_revision"
    assert second["validation"]["trusted"] and second["validation"]["coverage"] == "entire_file"
    assert first["certificate"]["owner"] == "Первый Подписант"
    assert second["certificate"]["owner"] == "Второй Подписант"


async def test_prepare_refuses_already_signed_field(ca: FakeAuthority) -> None:
    cert, key = ca.signer()
    signed = await sign_once(blank_pdf(), ca, cert, key, "kchs-sig-1")
    with pytest.raises(pades.SignatureRejectedError) as error:
        await pades.prepare(signed, field_name="kchs-sig-1", stamp_lines=STAMP, url="x")
    assert error.value.reason == "malformed"


async def test_broken_bytes_are_not_intact(ca: FakeAuthority) -> None:
    cert, key = ca.signer()
    signed = bytearray(await sign_once(blank_pdf(), ca, cert, key, "kchs-sig-1"))
    # Байт в начале файла входит в ByteRange: подпись больше не сходится
    index = signed.index(b"%PDF") + 20
    signed[index] = ord("X") if signed[index] != ord("X") else ord("Y")
    checked = await pades.validate(bytes(signed), "kchs-sig-1", ca.policy())
    assert checked["validation"]["intact"] is False
    assert checked["validation"]["problem"] == "Подписанные байты изменены"


async def test_cms_over_other_digest_is_rejected(ca: FakeAuthority) -> None:
    cert, key = ca.signer()
    prepared = await pades.prepare(blank_pdf(), field_name="kchs-sig-1", stamp_lines=STAMP, url="x")
    der = await agent_sign(hashlib.sha256(b"other document").digest(), cert, key, ca)
    with pytest.raises(pades.SignatureRejectedError) as error:
        await pades.attach(prepared, der, certificate_sha256=fingerprint(cert))
    assert error.value.reason == "digest_mismatch"


async def test_cms_from_other_certificate_is_rejected(ca: FakeAuthority) -> None:
    chosen, _ = ca.signer("Выбранный")
    other, other_key = ca.signer("Другой")
    prepared = await pades.prepare(blank_pdf(), field_name="kchs-sig-1", stamp_lines=STAMP, url="x")
    der = await agent_sign(prepared.digest, other, other_key, ca)
    with pytest.raises(pades.SignatureRejectedError) as error:
        await pades.attach(prepared, der, certificate_sha256=fingerprint(chosen))
    assert error.value.reason == "certificate_mismatch"


async def test_garbage_cms_is_malformed(ca: FakeAuthority) -> None:
    prepared = await pades.prepare(blank_pdf(), field_name="kchs-sig-1", stamp_lines=STAMP, url="x")
    with pytest.raises(pades.SignatureRejectedError) as error:
        await pades.attach(prepared, b"\x30\x03\x02\x01\x01")
    assert error.value.reason == "malformed"


async def test_foreign_ca_is_untrusted_and_nothing_is_fetched(ca: FakeAuthority) -> None:
    rogue_key = _key()
    rogue_root = _cert(_name("Чужой УЦ"), _name("Чужой УЦ"), rogue_key, rogue_key, ca=True)
    key = _key()
    # Адрес OCSP в чужом сертификате — внутренний ресурс: идти по нему нельзя
    cert = _cert(
        _name("Посторонний"),
        rogue_root.subject,
        key,
        rogue_key,
        ca=False,
        ocsp_url=ca.ocsp_url,
    )
    requests = ca.ocsp_requests
    prepared = await pades.prepare(blank_pdf(), field_name="kchs-sig-1", stamp_lines=STAMP, url="x")
    signer = signers.SimpleSigner(
        signing_cert=_asn1(cert),
        signing_key=_asn1_key(key),
        cert_registry=SimpleCertificateStore.from_certs([_asn1(rogue_root)]),
    )
    der = (await signer.async_sign(prepared.digest, "sha256", use_pades=True)).dump()
    signed = await pades.attach(prepared, der, certificate_sha256=fingerprint(cert))
    checked = await pades.validate(signed, "kchs-sig-1", ca.policy())
    assert checked["validation"]["intact"] and checked["validation"]["valid"]
    assert checked["validation"]["trusted"] is False
    assert checked["validation"]["problem"]
    assert ca.ocsp_requests == requests, "по адресам непроверенного сертификата не ходим"


async def test_revoked_certificate_is_not_trusted(ca: FakeAuthority) -> None:
    cert, key = ca.signer("Отозванный")
    ca.revoked.add(cert.serial_number)
    signed = await sign_once(blank_pdf(), ca, cert, key, "kchs-sig-1")
    checked = await pades.validate(signed, "kchs-sig-1", ca.policy())
    assert checked["validation"]["revocation"] == "revoked"
    assert checked["validation"]["trusted"] is False
    assert checked["validation"]["problem"] == "Сертификат подписанта отозван"


async def test_hard_fail_without_revocation_answer_is_untrusted(ca: FakeAuthority) -> None:
    cert, key = ca.signer()
    signed = await sign_once(blank_pdf(), ca, cert, key, "kchs-sig-1")
    strict = await pades.validate(signed, "kchs-sig-1", ca.policy(fetch=False))
    assert strict["validation"]["trusted"] is False
    lenient = await pades.validate(
        signed, "kchs-sig-1", ca.policy(fetch=False, revocation="soft-fail")
    )
    assert lenient["validation"]["trusted"] is True
    assert lenient["validation"]["revocation"] == "unknown"


def test_load_certificates_reads_pem_bundle(ca: FakeAuthority) -> None:
    bundle = ca.root_pem + ca.tsa.public_bytes(serialization.Encoding.PEM).decode("ascii")
    loaded = pades.load_certificates(bundle)
    assert [item.subject.native["common_name"] for item in loaded] == [
        "Тестовый УЦ Комитета",
        "Тестовая служба штампов времени",
    ]


# ─── Задание движка: план api → шаг → отчёт ─────────────────────────────────


async def test_job_runs_prepare_attach_verify(
    ca: FakeAuthority, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cert, key = ca.signer()
    store: dict[str, bytes] = {"spaces/s/files/f/v/version.pdf": blank_pdf()}
    reports: list[dict[str, Any]] = []
    plans: dict[str, dict[str, Any]] = {}

    async def fake_size(_bucket: str, key_: str) -> int:
        return len(store[key_])

    async def fake_download(_bucket: str, key_: str, target: Path) -> Path:
        target.write_bytes(store[key_])
        return target

    async def fake_upload(_bucket: str, key_: str, source: Path, _mime: str) -> None:
        store[key_] = source.read_bytes()

    async def fake_start(_session_id: str, step: str) -> dict[str, Any]:
        return plans[step]

    async def fake_done(_session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        checked_body("documentSignatureDone", payload)
        reports.append(payload)
        return {"ok": True, "stale": False}

    monkeypatch.setattr(signature_job, "object_size", fake_size)
    monkeypatch.setattr(signature_job, "download", fake_download)
    monkeypatch.setattr(signature_job, "upload", fake_upload)
    monkeypatch.setattr(signature_job, "document_signature_start", fake_start)
    monkeypatch.setattr(signature_job, "document_signature_done", fake_done)

    policy = {"trustRootsPem": [ca.root_pem], "revocation": "hard-fail", "fetchRevocation": True}
    plans["prepare"] = {
        "status": "prepare",
        "source": {"bucket": "files", "storageKey": "spaces/s/files/f/v/version.pdf"},
        "target": {"bucket": "files", "storageKey": "spaces/s/files/q/1/prepared.pdf"},
        "fieldName": "kchs-sig-1",
        "stampLines": STAMP,
        "url": "https://kchs.test/api/v1/verify/1",
    }
    session = "00000000-0000-4000-8000-000000000001"
    job = {"sessionId": session, "step": "prepare", "jobRecordId": session}
    assert await signature_job.document_signature(job) == {"step": "prepare", "status": "ready"}
    prepared = reports[-1]
    assert prepared["digest"] and prepared["reservedEnd"] > prepared["reservedStart"]

    der = await agent_sign(bytes.fromhex(prepared["digest"]), cert, key, ca)
    plans["attach"] = {
        "status": "attach",
        "prepared": plans["prepare"]["target"],
        "target": {"bucket": "files", "storageKey": "spaces/s/files/q/2/signed.pdf"},
        "fieldName": "kchs-sig-1",
        "cms": base64.b64encode(der).decode("ascii"),
        "digest": prepared["digest"],
        "reservedStart": prepared["reservedStart"],
        "reservedEnd": prepared["reservedEnd"],
        "certificateSha256": fingerprint(cert),
        "timestamp": {"url": ca.tsa_url, "username": None, "password": None},
        "policy": policy,
    }
    attach = {**job, "step": "attach"}
    assert await signature_job.document_signature(attach) == {"step": "attach", "status": "ready"}
    assert reports[-1]["validation"]["trusted"] is True
    assert (
        reports[-1]["sha256"]
        == hashlib.sha256(store[plans["attach"]["target"]["storageKey"]]).hexdigest()
    )

    plans["verify"] = {
        "status": "verify",
        "file": plans["attach"]["target"],
        "fieldName": "kchs-sig-1",
        "policy": policy,
    }
    verify = {**job, "step": "verify"}
    assert await signature_job.document_signature(verify) == {"step": "verify", "status": "ready"}
    assert reports[-1]["certificate"]["fingerprint"] == fingerprint(cert)


async def test_job_reports_forged_cms_without_writing_file(
    ca: FakeAuthority, monkeypatch: pytest.MonkeyPatch
) -> None:
    cert, key = ca.signer()
    prepared = await pades.prepare(blank_pdf(), field_name="kchs-sig-1", stamp_lines=STAMP, url="x")
    store: dict[str, bytes] = {"prepared.pdf": prepared.pdf}
    reports: list[dict[str, Any]] = []

    async def fake_size(_bucket: str, key_: str) -> int:
        return len(store[key_])

    async def fake_download(_bucket: str, key_: str, target: Path) -> Path:
        target.write_bytes(store[key_])
        return target

    async def fake_upload(_bucket: str, key_: str, source: Path, _mime: str) -> None:
        store[key_] = source.read_bytes()

    der = await agent_sign(hashlib.sha256(b"forged").digest(), cert, key, ca)

    async def fake_start(_session_id: str, _step: str) -> dict[str, Any]:
        return {
            "status": "attach",
            "prepared": {"bucket": "files", "storageKey": "prepared.pdf"},
            "target": {"bucket": "files", "storageKey": "signed.pdf"},
            "fieldName": "kchs-sig-1",
            "cms": base64.b64encode(der).decode("ascii"),
            "digest": prepared.digest.hex(),
            "reservedStart": prepared.reserved_start,
            "reservedEnd": prepared.reserved_end,
            "certificateSha256": fingerprint(cert),
            "timestamp": None,
            "policy": {
                "trustRootsPem": [ca.root_pem],
                "revocation": "soft-fail",
                "fetchRevocation": False,
            },
        }

    async def fake_done(_session_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        checked_body("documentSignatureDone", payload)
        reports.append(payload)
        return {"ok": True, "stale": False}

    monkeypatch.setattr(signature_job, "object_size", fake_size)
    monkeypatch.setattr(signature_job, "download", fake_download)
    monkeypatch.setattr(signature_job, "upload", fake_upload)
    monkeypatch.setattr(signature_job, "document_signature_start", fake_start)
    monkeypatch.setattr(signature_job, "document_signature_done", fake_done)

    job = {"sessionId": "00000000-0000-4000-8000-000000000002", "step": "attach"}
    assert await signature_job.document_signature(job) == {"step": "attach", "status": "invalid"}
    assert reports[-1]["reason"] == "digest_mismatch"
    assert "signed.pdf" not in store


async def test_job_skips_when_api_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_start(_session_id: str, _step: str) -> dict[str, Any]:
        return {"status": "skip", "reason": "сеанс закрыт"}

    monkeypatch.setattr(signature_job, "document_signature_start", fake_start)
    job = {"sessionId": "00000000-0000-4000-8000-000000000003", "step": "prepare"}
    assert await signature_job.document_signature(job) == {"skipped": "сеанс закрыт"}
