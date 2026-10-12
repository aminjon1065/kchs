"""Задание `render:document.pdf`: хэш версии документа и PDF-представление (ADR-0080).

Движок скачивает основной файл версии, считает SHA-256 и, если api попросило,
переводит его в PDF под ключом заранее выданного файла (офисные форматы и
изображения). Файл реестра создаёт api по отчёту — движок не пишет в базу.

Для манифеста подписи (ADR-0198) движок считает и SHA-256 приложений версии и
построенного PDF: подпись фиксирует все файлы версии, а не только основной.
"""

import asyncio
import tempfile
from pathlib import Path
from typing import Any

from kchs_engine.api import report_document_pdf
from kchs_engine.files.pdf import sha256_file, to_pdf
from kchs_engine.files.processing import pdf_page_count
from kchs_engine.jobs.registry import handler
from kchs_engine.logging import log
from kchs_engine.storage import download, object_size, upload

# Больше этого не переводим и не хэшируем: разбор занял бы воркер надолго
MAX_DOCUMENT_BYTES = 512 * 1024 * 1024


async def _attachment_hashes(items: list[dict[str, Any]], workdir: Path) -> dict[str, str]:
    """SHA-256 приложений: файл больше предела не хэшируется — манифест тогда неполон,
    и api оставит подписи по прежнему правилу (хэш основного файла)."""
    hashes: dict[str, str] = {}
    for index, item in enumerate(items):
        bucket, key = str(item["bucket"]), str(item["storageKey"])
        if await object_size(bucket, key) > MAX_DOCUMENT_BYTES:
            continue
        path = await download(bucket, key, workdir / f"attachment-{index}")
        hashes[str(item["fileId"])] = await asyncio.to_thread(sha256_file, path)
        path.unlink(missing_ok=True)
    return hashes


def _pages(pdf: Path) -> int | None:
    try:
        return pdf_page_count(pdf)
    except Exception:  # poppler не обязателен для перевода: число страниц — справочно
        return None


@handler("render", "document.pdf")
async def document_pdf(data: dict[str, Any]) -> dict[str, Any]:
    version_id = str(data["versionId"])
    name = str(data.get("name") or "document")
    mime = str(data.get("mime") or "application/octet-stream")
    bucket = str(data["bucket"])
    key = str(data["storageKey"])
    convert = bool(data.get("convert"))
    target: dict[str, Any] | None = data.get("target") or None

    size = await object_size(bucket, key)
    if size > MAX_DOCUMENT_BYTES:
        await report_document_pdf(
            version_id,
            {
                "status": "unsupported" if convert else "skipped",
                "error": f"файл {size} байт больше предела {MAX_DOCUMENT_BYTES}",
            },
        )
        return {"skipped": "too_large", "size": size}

    with tempfile.TemporaryDirectory(prefix="kchs-doc-") as tmp:
        workdir = Path(tmp)
        source = await download(bucket, key, workdir / f"source{Path(name).suffix.lower()}")
        sha256 = await asyncio.to_thread(sha256_file, source)
        attachments = await _attachment_hashes(list(data.get("attachments") or []), workdir)
        if not convert or target is None:
            await report_document_pdf(
                version_id, {"status": "skipped", "sha256": sha256, "attachments": attachments}
            )
            return {"sha256": sha256, "converted": False}

        try:
            # LibreOffice и Pillow блокирующие — в отдельном потоке
            pdf = await asyncio.to_thread(to_pdf, source, mime, name, workdir)
        except Exception as error:  # недоверенный файл: любой сбой перевода — статус failed
            await report_document_pdf(
                version_id,
                {
                    "status": "failed",
                    "sha256": sha256,
                    "attachments": attachments,
                    "error": f"{type(error).__name__}: {error}"[:4000],
                },
            )
            log.warning("document.pdf_failed", version_id=version_id, error=str(error))
            return {"sha256": sha256, "converted": False}

        pdf_key = str(target["storageKey"])
        await upload(str(target["bucket"]), pdf_key, pdf, "application/pdf")
        pages = await asyncio.to_thread(_pages, pdf)
        pdf_size = pdf.stat().st_size
        pdf_sha256 = await asyncio.to_thread(sha256_file, pdf)

    await report_document_pdf(
        version_id,
        {
            "status": "ready",
            "sha256": sha256,
            "pdfFileId": str(target["fileId"]),
            "pdfVersionId": str(target["versionId"]),
            "storageKey": pdf_key,
            "size": pdf_size,
            "pages": pages,
            "attachments": attachments,
            "pdfSha256": pdf_sha256,
        },
    )
    log.info("document.pdf_ready", version_id=version_id, pages=pages, size=pdf_size)
    return {"sha256": sha256, "converted": True, "pages": pages}
