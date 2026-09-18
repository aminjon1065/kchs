"""Потребление заданий BullMQ теми же очередями, что и у TypeScript-воркера."""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from bullmq import Job, Worker

from kchs_engine.api import report_failure, report_result, report_started
from kchs_engine.config import settings
from kchs_engine.jobs import JOB_HANDLERS, registered_queues

# Обработчики регистрируются импортом модулей
from kchs_engine.jobs import echo as _echo  # noqa: F401
from kchs_engine.jobs import files as _files  # noqa: F401
from kchs_engine.jobs import users_import as _users_import  # noqa: F401
from kchs_engine.logging import log

Processor = Callable[[Job, str], Awaitable[dict[str, Any]]]


def _make_processor(queue: str) -> Processor:
    """Имя очереди известно воркеру, а не заданию, — замыкаем его."""

    async def process(job: Job, _token: str) -> dict[str, Any]:
        key = f"{queue}:{job.name}"
        job_handler = JOB_HANDLERS.get(key)
        if job_handler is None:
            raise RuntimeError(f"Нет обработчика для {key}")

        record_id = str(job.data.get("jobRecordId") or job.id)
        log.info("job.started", queue=queue, name=job.name, job_id=record_id)
        await report_started(record_id)

        try:
            result = await job_handler(job.data)
        except Exception as error:  # статус задания фиксируется в реестре
            final = is_final_attempt(job)
            log.error(
                "job.failed",
                queue=queue,
                name=job.name,
                job_id=record_id,
                error=str(error),
                final=final,
            )
            await report_failure(record_id, str(error), final=final)
            raise

        await report_result(record_id, result)
        log.info("job.finished", queue=queue, name=job.name, job_id=record_id)
        return result

    return process


def is_final_attempt(job: Job) -> bool:
    """Последняя ли попытка: после неё BullMQ задание больше не повторит."""
    attempts = int(getattr(job, "attempts", 1) or 1)
    return int(job.attemptsMade) + 1 >= attempts


async def run_workers(stop: asyncio.Event) -> None:
    config = settings()
    workers = [
        Worker(
            queue,
            _make_processor(queue),
            {"connection": config.REDIS_URL, "concurrency": config.ENGINE_CONCURRENCY},
        )
        for queue in sorted(registered_queues())
    ]
    log.info("workers.started", queues=sorted(registered_queues()))

    await stop.wait()
    for worker in workers:
        await worker.close()
    log.info("workers.stopped")
