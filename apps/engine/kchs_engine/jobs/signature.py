"""Задание `render:document.signature`: шаг квалифицированной подписи (ADR-0205).

План шага движок берёт у api (`documentSignatureStart`): api отвечает по состоянию
сеанса подписания на этот момент — устаревшее задание получает `skip`. Файлы — под
ключами, которые выдал план; итог — отчёт `documentSignatureDone`, в базу движок не
пишет. Ключей подписи у движка нет: CMS делает агент УЦ на рабочем месте.
"""

import base64
import binascii
import hashlib
import tempfile
from pathlib import Path
from typing import Any

from pyhanko.sign.timestamps import HTTPTimeStamper

from kchs_engine.api import document_signature_done, document_signature_start
from kchs_engine.config import settings
from kchs_engine.jobs.registry import handler
from kchs_engine.logging import log
from kchs_engine.sign import pades
from kchs_engine.storage import download, object_size, upload

# PDF больше этого не подписываем: файл целиком в памяти на каждом шаге
MAX_SIGNED_BYTES = 128 * 1024 * 1024
PDF_MIME = "application/pdf"


def _policy(plan: dict[str, Any]) -> pades.Policy:
    policy = plan["policy"]
    roots = [cert for item in policy["trustRootsPem"] for cert in pades.load_certificates(item)]
    return pades.Policy(
        trust_roots=roots,
        revocation=policy["revocation"],
        fetch=bool(policy["fetchRevocation"]),
        # Готовые данные проверки от api (УЦ Комитета, ADR-0218): отзыв без сети
        crls=[base64.b64decode(item) for item in policy.get("crls") or []],
        ocsps=[base64.b64decode(item) for item in policy.get("ocsps") or []],
    )


def _timestamper(plan: dict[str, Any]) -> HTTPTimeStamper | None:
    server = plan.get("timestamp")
    if not server:
        return None
    username, password = server.get("username"), server.get("password")
    auth = (str(username), str(password or "")) if username else None
    url = str(server["url"])
    # Адрес от «/» — служба штампов самой платформы (ADR-0218): через свой адрес api
    if url.startswith("/"):
        url = settings().KCHS_API_URL.rstrip("/") + url
    return HTTPTimeStamper(url, timeout=15, auth=auth)


async def _read(stored: dict[str, Any], workdir: Path, name: str) -> bytes | None:
    """Файл плана; `None` — больше предела (подписывать такой не будем)."""
    bucket, key = str(stored["bucket"]), str(stored["storageKey"])
    if await object_size(bucket, key) > MAX_SIGNED_BYTES:
        return None
    path = await download(bucket, key, workdir / name)
    return path.read_bytes()


async def _write(stored: dict[str, Any], workdir: Path, name: str, data: bytes) -> None:
    path = workdir / name
    path.write_bytes(data)
    await upload(str(stored["bucket"]), str(stored["storageKey"]), path, PDF_MIME)


# Шаги — над байтами: разбор недоверенного PDF и CMS отделён от хранилища, сбой
# хранилища повторяется заданием, а сбой разбора становится отчётом


async def _prepare(plan: dict[str, Any], source: bytes) -> tuple[dict[str, Any], bytes | None]:
    prepared = await pades.prepare(
        source,
        field_name=str(plan["fieldName"]),
        stamp_lines=[str(line) for line in plan["stampLines"]],
        url=str(plan["url"]),
    )
    report = {
        "status": "ready",
        "digest": prepared.digest.hex(),
        "reservedStart": prepared.reserved_start,
        "reservedEnd": prepared.reserved_end,
        "size": len(prepared.pdf),
        "sha256": hashlib.sha256(prepared.pdf).hexdigest(),
    }
    return report, prepared.pdf


async def _attach(plan: dict[str, Any], pdf: bytes) -> tuple[dict[str, Any], bytes | None]:
    try:
        der = base64.b64decode(str(plan["cms"]), validate=True)
    except (binascii.Error, ValueError) as error:
        raise pades.SignatureRejectedError("malformed", "CMS не в base64") from error
    prepared = pades.Prepared(
        pdf=pdf,
        digest=bytes.fromhex(str(plan["digest"])),
        reserved_start=int(plan["reservedStart"]),
        reserved_end=int(plan["reservedEnd"]),
    )
    signed = await pades.attach(
        prepared,
        der,
        certificate_sha256=str(plan["certificateSha256"]),
        timestamper=_timestamper(plan),
    )
    checked = await pades.validate(signed, str(plan["fieldName"]), _policy(plan))
    validation = checked["validation"]
    if not (validation["intact"] and validation["valid"] and validation["trusted"]):
        if validation["revocation"] == "revoked":
            reason = "revoked"
        elif validation["intact"] and validation["valid"]:
            reason = "untrusted"
        else:
            reason = "invalid"
        return {
            "status": "invalid",
            "reason": reason,
            "error": validation["problem"],
            **checked,
        }, None
    if plan["policy"].get("ltv"):
        # PAdES-B-LT: данные проверки — в документе, подпись проверяется и без сети
        signed = await pades.embed_validation(signed, str(plan["fieldName"]), _policy(plan))
    report = {
        "status": "ready",
        "size": len(signed),
        "sha256": hashlib.sha256(signed).hexdigest(),
        **checked,
    }
    return report, signed


async def _verify(plan: dict[str, Any], data: bytes) -> tuple[dict[str, Any], bytes | None]:
    checked = await pades.validate(data, str(plan["fieldName"]), _policy(plan))
    return {"status": "ready", **checked}, None


#: Шаг → (файл плана на входе, файл плана на выходе, работа над байтами)
STEPS = {
    "prepare": ("source", "target", _prepare),
    "attach": ("prepared", "target", _attach),
    "verify": ("file", None, _verify),
}


@handler("render", "document.signature")
async def document_signature(data: dict[str, Any]) -> dict[str, Any]:
    session_id = str(data["sessionId"])
    step = str(data["step"])
    plan = await document_signature_start(session_id, step)
    if plan["status"] == "skip":
        return {"skipped": str(plan["reason"])}
    if plan["status"] != step:
        return {"skipped": f"план {plan['status']} не для шага {step}"}

    source_key, target_key, work = STEPS[step]
    with tempfile.TemporaryDirectory(prefix="kchs-sign-") as tmp:
        workdir = Path(tmp)
        data_in = await _read(plan[source_key], workdir, "source.pdf")
        output: bytes | None = None
        if data_in is None:
            report: dict[str, Any] = {
                "status": "invalid",
                "reason": "malformed",
                "error": f"PDF больше предела {MAX_SIGNED_BYTES} байт",
            }
        else:
            try:
                report, output = await work(plan, data_in)
            except pades.SignatureRejectedError as error:
                report = {"status": "invalid", "reason": error.reason, "error": str(error)[:4000]}
            except Exception as error:  # недоверенный PDF или CMS: сбой разбора — отчёт
                log.warning(
                    "signature.step_failed", session_id=session_id, step=step, error=str(error)
                )
                report = {
                    "status": "failed",
                    "reason": "engine_failed",
                    "error": f"{type(error).__name__}: {error}"[:4000],
                }
        if output is not None and target_key is not None:
            await _write(plan[target_key], workdir, "result.pdf", output)
    await document_signature_done(session_id, {"step": step, **report})
    log.info("signature.step_done", session_id=session_id, step=step, status=report["status"])
    return {"step": step, "status": report["status"]}
