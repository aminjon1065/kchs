"""Задание `render:file.process`: превью и текст версии файла (09-files.md §3–4).

Движок скачивает версию из хранилища, строит превью и извлекает текст,
выгружает превью в бакет превью под префиксом версии и сообщает результат
api — метаданные и текст записывает ядро (движок не пишет в базу).
"""

import asyncio
import tempfile
from pathlib import Path
from typing import Any

from kchs_engine.api import report_file_processed
from kchs_engine.files.processing import Preview, process
from kchs_engine.jobs.registry import handler
from kchs_engine.logging import log
from kchs_engine.storage import download, object_size, upload

# Больше этого превью не строим: разбор занял бы воркер надолго
MAX_PROCESS_BYTES = 512 * 1024 * 1024


def preview_key(prefix: str, preview: Preview) -> str:
    name = preview.kind if preview.page is None else f"{preview.kind}-{preview.page}"
    return f"{prefix}{name}.webp"


@handler("render", "file.process")
async def file_process(data: dict[str, Any]) -> dict[str, Any]:
    file_id = str(data["fileId"])
    version_id = str(data["versionId"])
    name = str(data.get("name") or "file")
    mime = str(data.get("mime") or "application/octet-stream")
    bucket = str(data["bucket"])
    key = str(data["storageKey"])
    preview_bucket = str(data["previewBucket"])
    prefix = str(data["previewPrefix"])

    size = await object_size(bucket, key)
    if size > MAX_PROCESS_BYTES:
        payload = {
            "versionId": version_id,
            "previewStatus": "unsupported",
            "textStatus": "unsupported",
            "error": f"файл {size} байт больше предела обработки {MAX_PROCESS_BYTES}",
        }
        await report_file_processed(file_id, payload)
        return {"skipped": "too_large", "size": size}

    with tempfile.TemporaryDirectory(prefix="kchs-file-") as tmp:
        workdir = Path(tmp)
        source = await download(bucket, key, workdir / f"source{Path(name).suffix.lower()}")
        # Разбор блокирующий (poppler, LibreOffice, Pillow) — в отдельном потоке
        result = await asyncio.to_thread(process, source, mime, name, workdir)

        uploaded: list[dict[str, Any]] = []
        for preview in result.previews:
            target = preview_key(prefix, preview)
            await upload(preview_bucket, target, preview.path, preview.mime)
            uploaded.append(
                {
                    "kind": preview.kind,
                    "page": preview.page,
                    "storageKey": target,
                    "width": preview.width,
                    "height": preview.height,
                    "mime": preview.mime,
                }
            )

    await report_file_processed(
        file_id,
        {
            "versionId": version_id,
            "previewStatus": result.preview_status,
            "textStatus": result.text_status,
            "pages": result.pages,
            "previews": uploaded,
            "text": result.text,
            "lang": result.lang,
            "error": result.error,
        },
    )
    log.info(
        "file.processed",
        file_id=file_id,
        previews=len(uploaded),
        text_chars=len(result.text or ""),
        preview_status=result.preview_status,
        text_status=result.text_status,
    )
    return {
        "previews": len(uploaded),
        "textChars": len(result.text or ""),
        "previewStatus": result.preview_status,
        "textStatus": result.text_status,
    }
