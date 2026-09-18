"""Внутренний HTTP-интерфейс движка и запуск воркеров.

Доступен только внутри сети развёртывания; аутентификация — сервисный токен.
"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from kchs_engine import __version__
from kchs_engine.config import settings
from kchs_engine.jobs import registered_queues
from kchs_engine.logging import configure_logging, log
from kchs_engine.worker import run_workers


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    configure_logging(settings().LOG_LEVEL)
    stop = asyncio.Event()
    task = asyncio.create_task(run_workers(stop))
    log.info("engine.started", version=__version__)
    try:
        yield
    finally:
        stop.set()
        await task
        log.info("engine.stopped")


app = FastAPI(title="kchs engine", version=__version__, lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, object]:
    return {"status": "ok", "version": __version__, "queues": sorted(registered_queues())}
