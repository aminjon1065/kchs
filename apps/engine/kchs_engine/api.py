"""Обратная связь с api: движок не пишет метаданные напрямую в базу.

Реестр заданий ведёт ядро (02-platform-kernel.md §9), поэтому статус, прогресс
и результат сообщаются внутренним маршрутом с сервисным токеном.
"""

from typing import Any

import httpx

from kchs_engine.config import settings
from kchs_engine.logging import log

_TIMEOUT = httpx.Timeout(10.0)


async def _post(path: str, payload: dict[str, Any]) -> None:
    config = settings()
    if not config.INTERNAL_SERVICE_TOKEN:
        log.debug("api.skip", path=path, reason="нет INTERNAL_SERVICE_TOKEN")
        return
    try:
        async with httpx.AsyncClient(base_url=config.KCHS_API_URL, timeout=_TIMEOUT) as client:
            response = await client.post(
                path,
                json=payload,
                headers={"x-kchs-service-token": config.INTERNAL_SERVICE_TOKEN},
            )
            if response.status_code >= 400:
                log.warning("api.error", path=path, status=response.status_code, body=response.text)
    except httpx.HTTPError as error:
        log.warning("api.unreachable", path=path, error=str(error))


async def report_started(job_id: str) -> None:
    await _post(f"/api/v1/internal/jobs/{job_id}/status", {"status": "running"})


async def report_progress(job_id: str, progress: float, message: str | None = None) -> None:
    await _post(
        f"/api/v1/internal/jobs/{job_id}/status",
        {"status": "running", "progress": progress, "message": message},
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
    if not config.INTERNAL_SERVICE_TOKEN:
        raise RuntimeError("INTERNAL_SERVICE_TOKEN не задан: движок не может сообщить результат")
    timeout = httpx.Timeout(60.0)
    async with httpx.AsyncClient(base_url=config.KCHS_API_URL, timeout=timeout) as client:
        response = await client.post(
            path,
            json=payload,
            headers={"x-kchs-service-token": config.INTERNAL_SERVICE_TOKEN},
        )
    if response.status_code >= 400:
        raise RuntimeError(f"api {path}: {response.status_code} {response.text[:500]}")
    data: dict[str, Any] = response.json()
    return data


async def report_file_processed(file_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return await _post_strict(f"/api/v1/internal/files/{file_id}/processed", payload)


async def report_users_import_parsed(job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Строки файла импорта пользователей; API ставит проверку и создание (ADR-0041)."""
    return await _post_strict(f"/api/v1/internal/users-import/{job_id}/parsed", payload)
