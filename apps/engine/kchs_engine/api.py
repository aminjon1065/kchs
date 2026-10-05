"""Обратная связь с api: движок не пишет метаданные напрямую в базу.

Реестр заданий ведёт ядро (02-platform-kernel.md §9), поэтому статус, прогресс
и результат сообщаются внутренним маршрутом. Каждый вызов несёт токен своего
задания (ADR-0176): его api кладёт в данные задания при передаче в очередь, и он
открывает только маршруты этого задания и его ресурса. Общий сервисный токен
внутренние маршруты api не принимают — им движок только проверяет вызовы api.
"""

import asyncio
from contextvars import ContextVar
from typing import Any

import httpx

from kchs_engine.config import settings
from kchs_engine.logging import log

_TIMEOUT = httpx.Timeout(10.0)

JOB_TOKEN_HEADER = "x-kchs-job-token"
# Токен выполняемого задания: воркер ставит его на время обработчика, задачи
# asyncio и потоки `to_thread` получают его вместе с контекстом
JOB_TOKEN: ContextVar[str | None] = ContextVar("kchs_job_token", default=None)
# Задержки повторов отчёта о статусе, с: api перезапускается, сеть моргнула.
# Исчерпанные попытки — не сбой задания: исход api возьмёт из очереди (ADR-0172)
_RETRY_DELAYS: tuple[float, ...] = (0.5, 1.0, 2.0, 4.0)


async def _post(path: str, payload: dict[str, Any], *, retry: bool = True) -> bool:
    """Отчёт о статусе задания. Сбой сети и ответ 5xx повторяются с задержкой,
    4xx — нет: повтор того же запроса не поможет. Истина — api принял отчёт."""
    config = settings()
    token = JOB_TOKEN.get()
    if not token:
        log.debug("api.skip", path=path, reason="нет токена задания")
        return False
    delays = _RETRY_DELAYS if retry else ()
    for attempt in range(len(delays) + 1):
        try:
            async with httpx.AsyncClient(base_url=config.KCHS_API_URL, timeout=_TIMEOUT) as client:
                response = await client.post(path, json=payload, headers={JOB_TOKEN_HEADER: token})
            if response.status_code < 400:
                return True
            log.warning(
                "api.error",
                path=path,
                status=response.status_code,
                body=response.text[:500],
                attempt=attempt + 1,
            )
            if response.status_code < 500:
                return False
        except httpx.HTTPError as error:
            log.warning("api.unreachable", path=path, error=str(error), attempt=attempt + 1)
        if attempt < len(delays):
            await asyncio.sleep(delays[attempt])
    return False


async def report_started(job_id: str) -> None:
    await _post(f"/api/v1/internal/jobs/{job_id}/status", {"status": "running"})


async def report_progress(job_id: str, progress: float, message: str | None = None) -> None:
    # Прогресс не повторяется: следующий отчёт всё равно новее
    await _post(
        f"/api/v1/internal/jobs/{job_id}/status",
        {"status": "running", "progress": progress, "message": message},
        retry=False,
    )


async def report_result(job_id: str, result: dict[str, Any]) -> None:
    await _post(f"/api/v1/internal/jobs/{job_id}/status", {"status": "succeeded", "result": result})


async def report_failure(job_id: str, error: str, *, final: bool = True) -> None:
    """`final=False` — BullMQ ещё повторит задание; реестр вернёт его в очередь."""
    await _post(
        f"/api/v1/internal/jobs/{job_id}/status",
        {"status": "failed", "error": error[:4000], "final": final},
    )


async def _post_strict(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Отчёт, без которого задание не завершено: ошибка api → повтор задания."""
    config = settings()
    token = JOB_TOKEN.get()
    if not token:
        raise RuntimeError("у задания нет токена обратного вызова: результат не сообщить")
    timeout = httpx.Timeout(60.0)
    async with httpx.AsyncClient(base_url=config.KCHS_API_URL, timeout=timeout) as client:
        response = await client.post(path, json=payload, headers={JOB_TOKEN_HEADER: token})
    if response.status_code >= 400:
        raise RuntimeError(f"api {path}: {response.status_code} {response.text[:500]}")
    data: dict[str, Any] = response.json()
    return data


async def report_file_processed(file_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return await _post_strict(f"/api/v1/internal/files/{file_id}/processed", payload)


async def report_document_pdf(version_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Хэш версии документа и её PDF-представление; файл реестра создаёт api (ADR-0080)."""
    return await _post_strict(f"/api/v1/internal/documents/versions/{version_id}/pdf", payload)


async def report_transcript(recording_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Сегменты расшифровки записи встречи; хранит их модуль встреч (ADR-0092)."""
    path = f"/api/v1/internal/meetings/recordings/{recording_id}/transcript"
    return await _post_strict(path, payload)


async def report_users_import_parsed(job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Строки файла импорта пользователей; API ставит проверку и создание (ADR-0041)."""
    return await _post_strict(f"/api/v1/internal/users-import/{job_id}/parsed", payload)


async def report_dataset_normalized(import_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Итог нормализации файла импорта; API ставит воркеру загрузку в датасет (ADR-0046)."""
    return await _post_strict(f"/api/v1/internal/data/imports/{import_id}/normalized", payload)


async def report_render_start(run_id: str) -> dict[str, Any]:
    """Служебный токен страницы печати и параметры рендера отчёта (ADR-0078).

    Номер попытки api считает сам: повтор BullMQ приходит тем же запросом.
    """
    return await _post_strict(f"/api/v1/internal/reports/runs/{run_id}/start", {})


async def report_rendered(run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Файлы отчёта в бакете экспортов: api отмечает запуск и рассылает (ADR-0078)."""
    return await _post_strict(f"/api/v1/internal/reports/runs/{run_id}/rendered", payload)


async def document_render_start(render_id: str) -> dict[str, Any]:
    """План рендера модуля документов с правами заказчика на этот момент (ADR-0085)."""
    return await _post_strict(f"/api/v1/internal/documents/renders/{render_id}/start", {})


async def document_render_done(render_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Результат рендера: файл под выданным ключом, плейсхолдеры шаблона или причина сбоя."""
    return await _post_strict(f"/api/v1/internal/documents/renders/{render_id}/done", payload)
