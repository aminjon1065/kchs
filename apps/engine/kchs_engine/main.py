"""Внутренний HTTP-интерфейс движка и запуск воркеров.

Доступен только внутри сети развёртывания; аутентификация — сервисный токен.
"""

import asyncio
import hmac
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from kchs_engine import __version__
from kchs_engine.config import settings
from kchs_engine.jobs import registered_queues
from kchs_engine.logging import configure_logging, log
from kchs_engine.users_import import build_template
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


XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def require_service_token(token: str | None) -> None:
    """Внутренние маршруты, кроме /health, — только с сервисным токеном api."""
    expected = settings().INTERNAL_SERVICE_TOKEN
    if not expected or not token or not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="недействительный сервисный токен")


class RoleRef(BaseModel):
    key: str = Field(max_length=64)
    name: str = Field(max_length=200)


class UnitRef(BaseModel):
    code: str = Field(max_length=64)
    name: str = Field(max_length=300)
    active: bool = True


class PositionRef(BaseModel):
    name: str = Field(max_length=300)
    unitCode: str | None = Field(default=None, max_length=64)  # noqa: N815 — поле контракта api


class UsersImportTemplateInput(BaseModel):
    roles: list[RoleRef] = Field(default_factory=list, max_length=500)
    units: list[UnitRef] = Field(default_factory=list, max_length=5000)
    positions: list[PositionRef] = Field(default_factory=list, max_length=5000)


@app.post("/templates/users-import")
async def users_import_template(
    body: UsersImportTemplateInput,
    x_kchs_service_token: str | None = Header(default=None),
) -> Response:
    """Шаблон XLSX импорта пользователей со справочниками организации (ADR-0041)."""
    require_service_token(x_kchs_service_token)
    with tempfile.TemporaryDirectory(prefix="kchs-template-") as tmp:
        target = Path(tmp) / "users-import.xlsx"
        await asyncio.to_thread(
            build_template,
            target,
            [role.model_dump() for role in body.roles],
            [unit.model_dump() for unit in body.units],
            [position.model_dump() for position in body.positions],
        )
        content = target.read_bytes()
    return Response(content=content, media_type=XLSX_MIME)
