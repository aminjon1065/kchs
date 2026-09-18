"""Задание `imports:users.parse`: разбор XLSX импорта пользователей (ADR-0041).

Движок скачивает версию файла, читает строки и отдаёт их API внутренним
маршрутом; проверку и создание пользователей ставит в очередь API. Ошибка
формата файла — не сбой задания, а замечание в отчёте: повтор её не исправит.
"""

import asyncio
import tempfile
from pathlib import Path
from typing import Any

from kchs_engine.api import report_progress, report_users_import_parsed
from kchs_engine.contracts import users_import_contract
from kchs_engine.jobs.registry import handler
from kchs_engine.logging import log
from kchs_engine.storage import download, object_size
from kchs_engine.users_import import ParseResult, parse_workbook


@handler("imports", "users.parse")
async def users_parse(data: dict[str, Any]) -> dict[str, Any]:
    job_id = str(data["jobRecordId"])
    bucket = str(data["bucket"])
    key = str(data["storageKey"])
    max_bytes = int(users_import_contract()["maxBytes"])

    size = await object_size(bucket, key)
    if size > max_bytes:
        result = ParseResult(
            file_error={"code": "unreadable", "field": None, "params": {"reason": "size"}}
        )
    else:
        with tempfile.TemporaryDirectory(prefix="kchs-users-import-") as tmp:
            source = await download(bucket, key, Path(tmp) / "import.xlsx")
            await report_progress(job_id, 0.3)
            # openpyxl блокирующий — в отдельном потоке
            result = await asyncio.to_thread(parse_workbook, source)

    await report_progress(job_id, 0.8)
    reply = await report_users_import_parsed(job_id, result.payload())
    log.info(
        "users_import.parsed",
        job_id=job_id,
        rows=result.total_rows,
        file_error=(result.file_error or {}).get("code"),
    )
    return {
        "rows": result.total_rows,
        "fileError": (result.file_error or {}).get("code"),
        "applyJobId": reply.get("applyJobId"),
    }
