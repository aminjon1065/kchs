"""Потребление заданий BullMQ теми же очередями, что и у TypeScript-воркера."""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from bullmq import Job, Worker
from bullmq.custom_errors import UnrecoverableError
from pydantic import ValidationError

from kchs_engine.api import JOB_TOKEN, report_failure, report_result, report_started
from kchs_engine.cancel import is_cancelled, run_cancellable
from kchs_engine.config import settings
from kchs_engine.contracts.jobs import ENVELOPE, contract_errors
from kchs_engine.jobs import JOB_HANDLERS, PermanentJobError, registered_queues

# Обработчики регистрируются импортом модулей
from kchs_engine.jobs import columnar as _columnar  # noqa: F401
from kchs_engine.jobs import dataset_import as _dataset_import  # noqa: F401
from kchs_engine.jobs import demo as _demo  # noqa: F401
from kchs_engine.jobs import documents as _documents  # noqa: F401
from kchs_engine.jobs import echo as _echo  # noqa: F401
from kchs_engine.jobs import files as _files  # noqa: F401
from kchs_engine.jobs import media as _media  # noqa: F401
from kchs_engine.jobs import users_import as _users_import  # noqa: F401
from kchs_engine.jobs.registry import JobHandler
from kchs_engine.logging import log
from kchs_engine.render import documents as _documents_render  # noqa: F401
from kchs_engine.render import report as _report  # noqa: F401
from kchs_engine.telemetry import job_span

Processor = Callable[[Job, str], Awaitable[dict[str, Any]]]


def _make_processor(queue: str) -> Processor:
    """Имя очереди известно воркеру, а не заданию, — замыкаем его."""

    async def process(job: Job, _token: str) -> dict[str, Any]:
        key = f"{queue}:{job.name}"
        job_handler = JOB_HANDLERS.get(key)
        if job_handler is None:
            raise RuntimeError(f"Нет обработчика для {key}")

        try:
            envelope = ENVELOPE.validate_python(job.data)
        except ValidationError as error:
            # Задание поставило не api: без записи реестра отчитываться некому (ADR-0190)
            reason = contract_errors(error)
            log.error("job.invalid_envelope", queue=queue, name=job.name, error=reason)
            raise UnrecoverableError(f"задание без конверта api: {reason}") from error
        record_id = envelope["jobRecordId"]
        # Обратные вызовы задания — его токеном из данных задания (ADR-0176)
        reset = JOB_TOKEN.set(envelope.get("callbackToken") or None)
        try:
            # Задание продолжает трассу запроса api, который его поставил (ADR-0167)
            opts = getattr(job, "opts", None)
            with job_span(queue, job.name, record_id, int(job.attemptsMade) + 1, opts):
                return await _run(queue, job, job_handler, record_id)
        finally:
            JOB_TOKEN.reset(reset)

    return process


async def _run(
    queue: str,
    job: Job,
    job_handler: JobHandler,
    record_id: str,
) -> dict[str, Any]:
    # Отменённое в api задание не начинается (ADR-0172); очередь считает его
    # завершённым, повторов не будет
    if await is_cancelled(record_id):
        log.info("job.cancelled", queue=queue, name=job.name, job_id=record_id, stage="start")
        return {"cancelled": True}

    log.info("job.started", queue=queue, name=job.name, job_id=record_id)
    await report_started(record_id)

    try:
        cancelled, result = await run_cancellable(record_id, job_handler(job.data))
    except Exception as error:  # статус задания фиксируется в реестре
        permanent = isinstance(error, PermanentJobError)
        final = permanent or is_final_attempt(job)
        log.error(
            "job.failed",
            queue=queue,
            name=job.name,
            job_id=record_id,
            error=str(error),
            final=final,
        )
        await report_failure(record_id, str(error), final=final)
        if permanent:
            # Повтор не поможет (файл не читается): BullMQ не повторяет такие задания
            raise UnrecoverableError(str(error)) from error
        raise

    if cancelled:
        log.info("job.cancelled", queue=queue, name=job.name, job_id=record_id, stage="running")
        return {"cancelled": True}

    # Исход уходит и отчётом, и результатом задания в очереди: потерянный отчёт
    # api восполнит по событиям очереди (ADR-0172)
    outcome = result if result is not None else {}
    await report_result(record_id, outcome)
    log.info("job.finished", queue=queue, name=job.name, job_id=record_id)
    return outcome


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
