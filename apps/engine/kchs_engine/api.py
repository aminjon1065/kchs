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


async def report_failure(job_id: str, error: str) -> None:
    await _post(f"/api/v1/internal/jobs/{job_id}/status", {"status": "failed", "error": error})
