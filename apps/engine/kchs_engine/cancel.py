"""Отмена задания движка (ADR-0172).

api ставит флаг `kchs:job:cancel:<id>` в Redis (`cacheKeys.jobCancel`). Движок
проверяет его перед началом задания и, пока обработчик работает, раз в
несколько секунд; отменённый обработчик прерывается в ближайшей точке ожидания.
Вычисление в потоке (`asyncio.to_thread`) и запущенная программа доработают
сами, но их результат не сообщается: запись реестра уже «отменено».
"""

import asyncio
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


async def run_cancellable(
    job_id: str,
    work: Coroutine[Any, Any, dict[str, Any]],
    *,
    poll_seconds: float = POLL_SECONDS,
) -> tuple[bool, dict[str, Any] | None]:
    """Выполнить обработчик, следя за отменой. (True, None) — задание отменено;
    ошибка обработчика поднимается как есть."""
    task = asyncio.ensure_future(work)
    while True:
        done, _ = await asyncio.wait({task}, timeout=poll_seconds)
        if done:
            return False, task.result()
        if await is_cancelled(job_id):
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception as error:  # обработчик упал, прерываясь, — задание всё равно отменено
                log.warning("job.cancel_cleanup_failed", job_id=job_id, error=str(error))
            return True, None
