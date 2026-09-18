"""Задание `imports:dataset.normalize`: нормализация файла импорта датасета (ADR-0046).

Движок скачивает файл, читает его целиком потоком по параметрам анализа,
пишет в хранилище нормализованный CSV и CSV ошибок и сообщает итог
внутренним маршрутом API; загрузку в таблицу датасета API ставит воркеру
(`data:dataset.load`). Файл, который не читается, — окончательный сбой без
повторов: причину увидит пользователь.
"""

import asyncio
import tempfile
from pathlib import Path
from typing import Any

from kchs_engine.api import report_dataset_normalized, report_progress
from kchs_engine.config import settings
from kchs_engine.contracts import data_import_contract
from kchs_engine.data.normalize import ImportSpecError, NormalizeResult, normalize_file
from kchs_engine.data.readers import ImportFileError
from kchs_engine.jobs.registry import PermanentJobError, handler
from kchs_engine.logging import log
from kchs_engine.storage import download, object_size, upload

# Как часто сообщать о ходе нормализации, секунд
PROGRESS_INTERVAL = 2.0
CSV_MIME = "text/csv; charset=utf-8"


class _Progress:
    """Ход нормализации из потока разбора: доля файла и число строк."""

    def __init__(self) -> None:
        self.share = 0.0
        self.rows = 0

    def update(self, share: float, rows: int) -> None:
        self.share, self.rows = share, rows


@handler("imports", "dataset.normalize")
async def dataset_normalize(data: dict[str, Any]) -> dict[str, Any]:
    job_id = str(data["jobRecordId"])
    import_id = str(data["importId"])
    bucket = str(data["bucket"])
    key = str(data["storageKey"])
    file_name = str(data.get("fileName") or key.rsplit("/", 1)[-1])
    options = dict(data.get("options") or {})
    mapping = list(data.get("mapping") or [])
    geometry = data.get("geometry") or None
    geometry_field = data.get("geometryField") or None
    output = data["output"]
    output_bucket = str(output["bucket"])
    normalized_key = str(output["normalizedKey"])
    errors_key = str(output["errorsKey"])

    size = await object_size(bucket, key)
    if size > int(data_import_contract()["limits"]["maxFileBytes"]):
        raise PermanentJobError("Файл больше 2 ГБ — импорт невозможен")

    with tempfile.TemporaryDirectory(prefix="kchs-dataset-import-") as tmp:
        folder = Path(tmp)
        source = await download(bucket, key, folder / "source")
        await report_progress(job_id, 0.05, "Файл получен, идёт разбор")
        normalized = folder / "normalized.csv"
        errors = folder / "errors.csv"
        progress = _Progress()
        work = asyncio.create_task(
            asyncio.to_thread(
                normalize_file,
                source,
                file_name,
                options,
                mapping,
                geometry,
                geometry_field,
                normalized,
                errors,
                zone=settings().TZ,
                progress=progress.update,
            )
        )
        while not work.done():
            await asyncio.wait({work}, timeout=PROGRESS_INTERVAL)
            if not work.done():
                await report_progress(
                    job_id,
                    round(0.05 + 0.85 * progress.share, 4),
                    f"Обработано строк: {progress.rows}",
                )
        try:
            result: NormalizeResult = work.result()
        except ImportFileError as error:
            raise PermanentJobError(f"Не удалось прочитать файл: {error.message}") from error
        except ImportSpecError as error:
            # Сопоставление или геометрия не подходят к файлу — повтор не поможет
            raise PermanentJobError(f"Неверные параметры импорта: {error}") from error

        await upload(output_bucket, normalized_key, normalized, CSV_MIME)
        if result.errors:
            await upload(output_bucket, errors_key, errors, CSV_MIME)

    await report_progress(job_id, 0.95, "Файл нормализован")
    reply = await report_dataset_normalized(
        import_id,
        {
            "jobRecordId": job_id,
            "rows": result.rows,
            "errors": result.errors,
            "normalizedKey": normalized_key,
            "errorsKey": errors_key if result.errors else None,
            "errorSample": result.error_sample,
        },
    )
    log.info(
        "dataset_import.normalized",
        job_id=job_id,
        import_id=import_id,
        format=result.format,
        rows=result.rows,
        errors=result.errors,
    )
    return {
        "rows": result.rows,
        "errors": result.errors,
        "normalizedKey": normalized_key,
        "errorsKey": errors_key if result.errors else None,
        "loadJobId": reply.get("loadJobId"),
    }
