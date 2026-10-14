"""Отмена задания движка (ADR-0172).

api ставит флаг `kchs:job:cancel:<id>` в Redis (`cacheKeys.jobCancel`). Движок
проверяет его перед началом задания и, пока обработчик работает, раз в
несколько секунд; отменённый обработчик прерывается в ближайшей точке ожидания.
Вычисление в потоке (`asyncio.to_thread`) и запущенная программа доработают
сами, но их результат не сообщается: запись реестра уже «отменено».
"""

import asyncio
import contextlib
from collections.abc import Coroutine
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import RedisError

from kchs_engine.config import settings
from kchs_engine.logging import log

CANCEL_KEY = "kchs:job:cancel:{job_id}"
POLL_SECONDS = 2.0

_client: Redis | None = None


def _redis() -> Redis:
    global _client
    if _client is None:
        _client = Redis.from_url(settings().REDIS_URL)
    return _client


async def is_cancelled(job_id: str) -> bool:
    """Недоступный Redis задание не роняет: отмена просто не видна."""
    try:
        return bool(await _redis().exists(CANCEL_KEY.format(job_id=job_id)))
    except RedisError as error:
        log.warning("job.cancel_check_failed", job_id=job_id, error=str(error))
        return False


class JobTimeoutError(Exception):
    """Задание не уложилось в предел времени своей очереди (ADR-0220)."""

    def __init__(self, limit_seconds: float) -> None:
        minutes = max(1, round(limit_seconds / 60))
        super().__init__(f"Превышено время выполнения задания: {minutes} мин")
        self.limit_seconds = limit_seconds


async def run_cancellable(
    job_id: str,
    work: Coroutine[Any, Any, dict[str, Any]],
    *,
    poll_seconds: float = POLL_SECONDS,
    timeout_seconds: float | None = None,
) -> tuple[bool, dict[str, Any] | None]:
    """Выполнить обработчик, следя за отменой и пределом времени. (True, None) — задание
    отменено; предел — `JobTimeoutError`, слот воркера освобождается; ошибка обработчика
    поднимается как есть."""
    task = asyncio.ensure_future(work)
    loop = asyncio.get_running_loop()
    deadline = None if timeout_seconds is None else loop.time() + timeout_seconds
    while True:
        wait = poll_seconds
        if deadline is not None:
            wait = max(0.0, min(poll_seconds, deadline - loop.time()))
        done, _ = await asyncio.wait({task}, timeout=wait)
        if done:
            return False, task.result()
        if deadline is not None and loop.time() >= deadline:
            task.cancel()
            # Прерванный по пределу обработчик дочищается; его ошибка — уже не исход задания
            with contextlib.suppress(BaseException):
                await task
            raise JobTimeoutError(timeout_seconds or 0)
        if await is_cancelled(job_id):
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception as error:  # обработчик упал, прерываясь, — задание всё равно отменено
                log.warning("job.cancel_cleanup_failed", job_id=job_id, error=str(error))
            return True, None
