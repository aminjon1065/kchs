"""PAdES для квалифицированной подписи (ADR-0205).

Движок ключей не держит (ADR-0176): подписывает агент удостоверяющего центра (УЦ)
на рабочем месте. Здесь три шага:

1. **Подготовка** — к PDF добавляется поле подписи с видимым штампом (отметка об
   электронной подписи и QR-код страницы проверки) на последнем листе, место под CMS
   резервируется, считается SHA-256 `ByteRange`. Каждая следующая подпись — новая
   ревизия файла (инкрементальное обновление): прошлые подписи остаются верными.
2. **Встраивание** — CMS агента проверяется по форме (одна подпись, `messageDigest`
   совпадает с хэшем `ByteRange`, подписана выбранным сертификатом), к ней добавляется
   штамп времени TSA (`signature-time-stamp`, PAdES-B-T) и она записывается в
   зарезервированное место.
3. **Проверка** — целостность байтов, математика подписи, цепочка до доверенного
   корня УЦ, отзыв (OCSP или CRL) и штамп времени.

Сеть: за OCSP и CRL движок ходит только по сертификатам, цепочка которых уже сошлась
с доверенными корнями без сети, — адреса из сертификата постороннего не становятся
способом постучаться во внутреннюю сеть (17-security.md §5).
"""

import hashlib
import io
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from asn1crypto import cms, pem
from asn1crypto import x509 as asn1_x509
from pyhanko.pdf_utils.font.opentype import GlyphAccumulatorFactory
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.pdf_utils.text import TextBoxStyle
from pyhanko.sign import fields, signers
from pyhanko.sign.signers.pdf_byterange import PreparedByteRangeDigest
from pyhanko.sign.timestamps.api import TimeStamper
from pyhanko.sign.validation import async_add_validation_info, async_validate_pdf_signature
from pyhanko.sign.validation.status import PdfSignatureStatus
from pyhanko.stamp import QRStampStyle
from pyhanko_certvalidator import ValidationContext

#: Шрифт штампа с кириллицей и таджикскими буквами (`fonts-freefont-ttf` образа движка).
#: Нужен шрифт с 1000 единиц на кегль: ширины глифов pyHanko пишет в единицах шрифта,
#: и у шрифта с 2048 (DejaVu, Liberation) буквы штампа разъезжаются вдвое
STAMP_FONT = Path("/usr/share/fonts/truetype/freefont/FreeSans.ttf")
#: Штамп: ширина и высота в пунктах, отступ от края листа, зазор между штампами
STAMP_WIDTH = 280
STAMP_HEIGHT = 92
STAMP_MARGIN = 28
STAMP_GAP = 6
#: Место под CMS: цепочка сертификатов и токен штампа времени помещаются с запасом
BYTES_RESERVED = 32 * 1024

Revocation = Literal["hard-fail", "soft-fail"]


class SignatureRejectedError(Exception):
    """CMS не принята: код причины (`QES_FAILURE_REASONS`) и текст для человека."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass(frozen=True)
class Prepared:
    """Подготовленный PDF: байты с пустым местом под CMS и что подписывать."""

    pdf: bytes
    digest: bytes
    reserved_start: int
    reserved_end: int


@dataclass(frozen=True)
class Policy:
    """Политика проверки: доверенные корни, строгость отзыва, походы в сеть."""

    trust_roots: list[asn1_x509.Certificate]
    revocation: Revocation = "hard-fail"
    fetch: bool = False
    #: Ответы OCSP и списки CRL, известные заранее (проверки без сети, тесты)
    ocsps: list[bytes] = field(default_factory=list)
    crls: list[bytes] = field(default_factory=list)


def load_certificates(pem_or_der: str | bytes) -> list[asn1_x509.Certificate]:
    """Сертификаты из PEM (один или несколько блоков) или DER."""
    data = pem_or_der.encode("ascii") if isinstance(pem_or_der, str) else pem_or_der
    if pem.detect(data):
        return [asn1_x509.Certificate.load(der) for _, _, der in pem.unarmor(data, multiple=True)]
    return [asn1_x509.Certificate.load(data)]


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat()


def certificate_info(cert: asn1_x509.Certificate) -> dict[str, Any]:
    """Сведения о сертификате для карточки, листа подписи и страницы проверки."""
    subject = cert.subject.native
    validity = cert["tbs_certificate"]["validity"]
    return {
        "owner": str(subject.get("common_name") or cert.subject.human_friendly)[:500],
        "organization": (str(subject["organization_name"])[:500])
        if subject.get("organization_name")
        else None,
        "subject": cert.subject.human_friendly[:2000],
        "issuer": cert.issuer.human_friendly[:2000],
        "serial": format(cert.serial_number, "x"),
        "notBefore": _iso(validity["not_before"].native),
        "notAfter": _iso(validity["not_after"].native),
        "fingerprint": hashlib.sha256(cert.dump()).hexdigest(),
    }


def _stamp_box(source: bytes, index: int) -> tuple[int, tuple[int, int, int, int]]:
    """Последний лист и место штампа: правый нижний угол, следующие подписи — выше."""
    reader = PdfFileReader(io.BytesIO(source), strict=False)
    pages = int(reader.root["/Pages"]["/Count"])
    page = reader.root["/Pages"]
    # Последний лист: спускаемся по дереву страниц к последнему листу
    while page.get("/Type") == "/Pages":
        page = page["/Kids"][-1].get_object()
    box = [float(value) for value in page.get("/MediaBox", [0, 0, 595, 842])]
    left, bottom, right, top = box
    width, height = right - left, top - bottom
    column = max(1, int((height - 2 * STAMP_MARGIN) // (STAMP_HEIGHT + STAMP_GAP)))
    row, shift = index % column, index // column
    x2 = left + width - STAMP_MARGIN - shift * (STAMP_WIDTH + STAMP_GAP)
    x1 = max(left + STAMP_MARGIN, x2 - STAMP_WIDTH)
    y1 = bottom + STAMP_MARGIN + row * (STAMP_HEIGHT + STAMP_GAP)
    return pages - 1, (round(x1), round(y1), round(x2), round(y1 + STAMP_HEIGHT))


def signed_fields(data: bytes) -> list[str]:
    """Имена уже подписанных полей файла — по порядку ревизий."""
    reader = PdfFileReader(io.BytesIO(data), strict=False)
    return [signature.field_name for signature in reader.embedded_signatures]


async def prepare(
    source: bytes,
    *,
    field_name: str,
    stamp_lines: list[str],
    url: str,
    font: Path | None = STAMP_FONT,
) -> Prepared:
    """PDF с новым полем подписи и штампом; хэш `ByteRange` — то, что подпишет агент."""
    existing = signed_fields(source)
    if field_name in existing:
        raise SignatureRejectedError("malformed", f"Поле подписи {field_name} уже подписано")
    page, box = _stamp_box(source, len(existing))
    writer = IncrementalPdfFileWriter(io.BytesIO(source), strict=False)
    text_style = (
        TextBoxStyle(font=GlyphAccumulatorFactory(str(font)), font_size=7, leading=8)
        if font is not None and font.exists()
        else TextBoxStyle(font_size=7, leading=8)
    )
    style = QRStampStyle(
        # `%` в ФИО или названии не должен стать подстановкой стиля
        stamp_text="\n".join(line.replace("%", "%%") for line in stamp_lines),
        text_box_style=text_style,
        border_width=1,
        innsep=4,
    )
    meta = signers.PdfSignatureMetadata(
        field_name=field_name,
        md_algorithm="sha256",
        subfilter=fields.SigSeedSubFilter.PADES,
    )
    # Ключа нет: значение подписи — заглушка, CMS пришлёт агент
    external = signers.ExternalSigner(
        signing_cert=None, cert_registry=None, signature_value=bytes(256)
    )
    signer = signers.PdfSigner(
        meta,
        signer=external,
        stamp_style=style,
        new_field_spec=fields.SigFieldSpec(field_name, on_page=page, box=box),
    )
    prepared, _, output = await signer.async_digest_doc_for_signing(
        writer, bytes_reserved=BYTES_RESERVED, appearance_text_params={"url": url}
    )
    output.seek(0)
    return Prepared(
        pdf=output.read(),
        digest=prepared.document_digest,
        reserved_start=prepared.reserved_region_start,
        reserved_end=prepared.reserved_region_end,
    )


def _signer_info(info: cms.ContentInfo) -> tuple[cms.SignerInfo, asn1_x509.Certificate]:
    """Единственная подпись CMS и сертификат, которым она сделана."""
    if info["content_type"].native != "signed_data":
        raise SignatureRejectedError("malformed", "Ожидается CMS SignedData")
    signed = info["content"]
    infos = signed["signer_infos"]
    if len(infos) != 1:
        raise SignatureRejectedError("malformed", "В CMS должна быть ровно одна подпись")
    signer_info = infos[0]
    sid = signer_info["sid"]
    certs = [item.chosen for item in signed["certificates"] or [] if item.name == "certificate"]
    for cert in certs:
        if sid.name == "issuer_and_serial_number":
            if (
                cert.issuer == sid.chosen["issuer"]
                and cert.serial_number == sid.chosen["serial_number"].native
            ):
                return signer_info, cert
        elif cert.key_identifier == sid.chosen.native:
            return signer_info, cert
    raise SignatureRejectedError("malformed", "В CMS нет сертификата подписанта")


def inspect_cms(der: bytes, digest: bytes, certificate_sha256: str | None) -> asn1_x509.Certificate:
    """Форма CMS: хэш `ByteRange` и сертификат те, что ждали. Возвращает сертификат."""
    try:
        info = cms.ContentInfo.load(der)
        signer_info, cert = _signer_info(info)
        attrs = signer_info["signed_attrs"]
        values = [
            attr["values"][0].native for attr in attrs if attr["type"].native == "message_digest"
        ]
    except SignatureRejectedError:
        raise
    except Exception as error:  # недоверенные байты от рабочего места: любой сбой разбора
        raise SignatureRejectedError("malformed", f"CMS не разбирается: {error}") from error
    if not values:
        raise SignatureRejectedError("malformed", "В CMS нет атрибута messageDigest")
    if values[0] != digest:
        raise SignatureRejectedError(
            "digest_mismatch", "CMS подписывает другой хэш, а не этот документ"
        )
    if certificate_sha256 and hashlib.sha256(cert.dump()).hexdigest() != certificate_sha256:
        raise SignatureRejectedError(
            "certificate_mismatch", "CMS подписана не тем сертификатом, что выбран в агенте"
        )
    return cert


async def attach(
    prepared: Prepared,
    der: bytes,
    *,
    certificate_sha256: str | None = None,
    timestamper: TimeStamper | None = None,
) -> bytes:
    """Встроить CMS агента (со штампом времени, если есть TSA) в подготовленный PDF."""
    inspect_cms(der, prepared.digest, certificate_sha256)
    info = cms.ContentInfo.load(der)
    signer_info = info["content"]["signer_infos"][0]
    if timestamper is not None:
        try:
            token = await timestamper.async_timestamp(
                hashlib.sha256(signer_info["signature"].native).digest(), "sha256"
            )
        except Exception as error:  # сеть, отказ TSA, чужой ответ
            raise SignatureRejectedError(
                "timestamp_failed", f"Сервер штампов времени не ответил: {error}"
            ) from error
        unsigned = (
            list(signer_info["unsigned_attrs"]) if signer_info["unsigned_attrs"].native else []
        )
        unsigned.append(cms.CMSAttribute({"type": "signature_time_stamp_token", "values": [token]}))
        signer_info["unsigned_attrs"] = cms.CMSAttributes(unsigned)
    final = info.dump(force=True)
    # Место — шестнадцатеричная строка в угловых скобках
    if len(final) * 2 > prepared.reserved_end - prepared.reserved_start - 2:
        raise SignatureRejectedError("malformed", "CMS не помещается в зарезервированное место")
    stream = io.BytesIO(prepared.pdf)
    PreparedByteRangeDigest(
        document_digest=prepared.digest,
        reserved_region_start=prepared.reserved_start,
        reserved_region_end=prepared.reserved_end,
    ).fill_with_cms(stream, final)
    return stream.getvalue()


def _context(policy: Policy, *, fetch: bool, revocation: Revocation) -> ValidationContext:
    return ValidationContext(
        trust_roots=policy.trust_roots,
        allow_fetching=fetch,
        revocation_mode=revocation,
        ocsps=policy.ocsps,
        crls=policy.crls,
    )


def _problem(status: PdfSignatureStatus, revoked: bool) -> str | None:
    if not status.intact:
        return "Подписанные байты изменены"
    if not status.valid:
        return "Подпись математически неверна"
    if revoked:
        return "Сертификат подписанта отозван"
    if not status.trusted:
        indic = status.trust_problem_indic
        detail = indic.standard_name if indic else "нет пути до корня"
        return f"Цепочка сертификата не доверенная: {detail}"
    return None


async def embed_validation(data: bytes, field_name: str, policy: Policy) -> bytes:
    """PAdES-B-LT: цепочка, списки отзыва и ответы OCSP — в DSS документа (проверка без сети)."""
    reader = PdfFileReader(io.BytesIO(data), strict=False)
    found = [item for item in reader.embedded_signatures if item.field_name == field_name]
    if not found:
        raise SignatureRejectedError("invalid", f"В файле нет подписи {field_name}")
    output = io.BytesIO()
    try:
        await async_add_validation_info(
            found[0],
            _context(policy, fetch=False, revocation=policy.revocation),
            output=output,
        )
    except Exception as error:  # нет данных проверки для звена цепочки
        raise SignatureRejectedError(
            "untrusted", f"Данные проверки не встраиваются: {error}"
        ) from error
    return output.getvalue()


async def validate(data: bytes, field_name: str, policy: Policy) -> dict[str, Any]:
    """Проверка подписи поля: сертификат и итог (`QualifiedValidation`)."""
    reader = PdfFileReader(io.BytesIO(data), strict=False)
    found = [item for item in reader.embedded_signatures if item.field_name == field_name]
    if not found:
        raise SignatureRejectedError("invalid", f"В файле нет подписи {field_name}")
    signature = found[0]
    # Сначала без сети: доходит ли цепочка до доверенного корня по сертификатам из CMS
    offline = await async_validate_pdf_signature(
        signature,
        signer_validation_context=_context(policy, fetch=False, revocation="soft-fail"),
        ts_validation_context=_context(policy, fetch=False, revocation="soft-fail"),
    )
    status = offline
    if offline.intact and offline.valid and offline.trusted:
        status = await async_validate_pdf_signature(
            signature,
            signer_validation_context=_context(
                policy, fetch=policy.fetch, revocation=policy.revocation
            ),
            ts_validation_context=_context(policy, fetch=policy.fetch, revocation="soft-fail"),
        )
    revoked = status.revocation_details is not None
    if revoked:
        revocation = "revoked"
    elif status.trusted and policy.revocation == "hard-fail":
        # Строгий режим пропускает только сертификат с ответом OCSP или CRL «действует»
        revocation = "good"
    else:
        revocation = "unknown"
    stamp = status.timestamp_validity
    timestamp_at = (
        _iso(stamp.timestamp) if stamp is not None and stamp.intact and stamp.valid else None
    )
    return {
        "certificate": certificate_info(signature.signer_cert),
        "validation": {
            "intact": bool(status.intact),
            "valid": bool(status.valid),
            "trusted": bool(status.trusted) and not revoked,
            "revocation": revocation,
            "timestampAt": timestamp_at,
            "coverage": status.coverage.name.lower() if status.coverage else "unknown",
            "modification": status.modification_level.name.lower()
            if status.modification_level
            else "unknown",
            "problem": _problem(status, revoked),
            "checkedAt": _iso(datetime.now(UTC)),
        },
    }
