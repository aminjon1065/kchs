"""Задание `render:document.pdf`: хэш версии документа и PDF-представление (ADR-0080).

Движок скачивает основной файл версии, считает SHA-256 и, если api попросило,
переводит его в PDF под ключом заранее выданного файла (офисные форматы и
изображения). Файл реестра создаёт api по отчёту — движок не пишет в базу.
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
        if not convert or target is None:
            await report_document_pdf(version_id, {"status": "skipped", "sha256": sha256})
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
                    "error": f"{type(error).__name__}: {error}"[:4000],
                },
            )
            log.warning("document.pdf_failed", version_id=version_id, error=str(error))
            return {"sha256": sha256, "converted": False}

        pdf_key = str(target["storageKey"])
        await upload(str(target["bucket"]), pdf_key, pdf, "application/pdf")
        pages = await asyncio.to_thread(_pages, pdf)
        pdf_size = pdf.stat().st_size

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
        },
    )
    log.info("document.pdf_ready", version_id=version_id, pages=pages, size=pdf_size)
    return {"sha256": sha256, "converted": True, "pages": pages}
