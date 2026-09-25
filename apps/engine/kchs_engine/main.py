"""Внутренний HTTP-интерфейс движка и запуск воркеров.

Доступен только внутри сети развёртывания; аутентификация — сервисный токен.
"""

import asyncio
import hmac
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

from botocore.exceptions import ClientError
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

from kchs_engine import __version__
from kchs_engine.ai.embed import embed, embeddings_enabled
from kchs_engine.config import settings
from kchs_engine.contracts import data_export_contract
from kchs_engine.data.analyze import analyze_object
from kchs_engine.data.columnar import ColumnarError
from kchs_engine.data.columnar import query as columnar_query
from kchs_engine.data.geo_export import ExportField, convert_features
from kchs_engine.data.readers import ImportFileError
from kchs_engine.jobs import registered_queues
from kchs_engine.logging import configure_logging, log
from kchs_engine.render.report import close_browser
from kchs_engine.storage import download, upload
from kchs_engine.telemetry import configure_tracing
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
        await close_browser()
        log.info("engine.stopped")


app = FastAPI(title="kchs engine", version=__version__, lifespan=lifespan)
# Трассы — только с адресом коллектора (OTEL_EXPORTER_OTLP_ENDPOINT), ADR-0167
configure_tracing(app)


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


class ImportOptionsInput(BaseModel):
    """`ImportOptions` контракта импорта (packages/contracts/src/data/import.ts)."""

    model_config = ConfigDict(extra="ignore")

    format: (
        Literal[
            "csv",
            "tsv",
            "xlsx",
            "xls",
            "json",
            "ndjson",
            "geojson",
            "shp",
            "gpkg",
            "kml",
            "kmz",
            "gpx",
        ]
        | None
    ) = None
    encoding: str | None = Field(default=None, max_length=40)
    delimiter: str | None = Field(default=None, min_length=1, max_length=1)
    sheet: str | None = Field(default=None, max_length=200)
    skipRows: int | None = Field(default=None, ge=0, le=1000)  # noqa: N815 — поле контракта
    headerRows: int | None = Field(default=None, ge=0, le=5)  # noqa: N815 — поле контракта
    decimal: Literal[".", ","] | None = None
    thousands: Literal["", " ", ",", ".", "'"] | None = None
    dateOrder: Literal["dmy", "mdy", "ymd"] | None = None  # noqa: N815 — поле контракта
    layer: str | None = Field(default=None, max_length=200)
    crs: str | None = Field(default=None, pattern=r"^EPSG:\d{4,6}$")


class DataAnalyzeInput(BaseModel):
    bucket: str = Field(min_length=1, max_length=200)
    key: str = Field(min_length=1, max_length=1024)
    fileName: str = Field(default="", max_length=500)  # noqa: N815 — поле контракта api
    options: ImportOptionsInput = Field(default_factory=ImportOptionsInput)


@app.post("/data/analyze")
async def data_analyze(
    body: DataAnalyzeInput,
    x_kchs_service_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Анализ файла импорта датасета по выборке (06-analytics-engine.md §2, ADR-0046).

    Ответ — `ImportAnalysis`; файл, который не читается, — 422 с причиной в `detail`.
    """
    require_service_token(x_kchs_service_token)
    options = body.options.model_dump(exclude_none=True)
    try:
        return await analyze_object(body.bucket, body.key, body.fileName, options)
    except ImportFileError as error:
        raise HTTPException(status_code=422, detail=_sentence(error.message)) from error
    except TimeoutError as error:
        raise HTTPException(
            status_code=422,
            detail="Анализ файла не уложился в отведённое время — "
            "укажите формат, кодировку и лист вручную или уменьшите файл",
        ) from error
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        if code in ("NoSuchKey", "404", "NotFound"):
            raise HTTPException(status_code=404, detail="Файл не найден в хранилище") from error
        raise


def _sentence(message: str) -> str:
    return message[:1].upper() + message[1:]


class GeoExportField(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    label: str = Field(default="", max_length=300)
    type: str = Field(min_length=1, max_length=40)


class GeoExportInput(BaseModel):
    """Выгрузка воркера (GeoJSONSeq) → файл геоформата в том же бакете (ADR-0068)."""

    bucket: str = Field(min_length=1, max_length=200)
    sourceKey: str = Field(min_length=1, max_length=1024)  # noqa: N815 — поле контракта api
    targetKey: str = Field(min_length=1, max_length=1024)  # noqa: N815 — поле контракта api
    format: str = Field(min_length=1, max_length=20)
    layer: str = Field(min_length=1, max_length=200)
    contentType: str = Field(min_length=1, max_length=200)  # noqa: N815 — поле контракта api
    fields: list[GeoExportField] = Field(default_factory=list, max_length=500)


@app.post("/data/geo-export")
async def data_geo_export(
    body: GeoExportInput,
    x_kchs_service_token: str | None = Header(default=None),
) -> dict[str, int]:
    """GeoPackage, Shapefile (zip) или KML из выгрузки задания экспорта (ADR-0056, ADR-0068).

    Права и политики строк и столбцов уже применил воркер; ответ — объекты и размер файла.
    """
    require_service_token(x_kchs_service_token)
    if body.format not in data_export_contract()["engineFormats"]:
        raise HTTPException(status_code=422, detail=f"Формат {body.format} движок не собирает")
    fields = [ExportField(item.name, item.label, item.type) for item in body.fields]
    try:
        with tempfile.TemporaryDirectory(prefix="kchs-geo-export-") as tmp:
            folder = Path(tmp)
            source = await download(body.bucket, body.sourceKey, folder / "source.geojsonl")
            target = folder / ("export.zip" if body.format == "shp" else f"export.{body.format}")
            rows = await asyncio.to_thread(
                convert_features, source, target, body.format, body.layer, fields
            )
            size = target.stat().st_size
            await upload(body.bucket, body.targetKey, target, body.contentType)
    except ImportFileError as error:
        raise HTTPException(status_code=422, detail=_sentence(error.message)) from error
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        if code in ("NoSuchKey", "404", "NotFound"):
            raise HTTPException(
                status_code=404, detail="Выгрузка не найдена в хранилище"
            ) from error
        raise
    log.info("geo_export.done", format=body.format, rows=rows, size=size)
    return {"rows": rows, "size": size}


class ColumnarSource(BaseModel):
    """Колоночная копия датасета: имя таблицы в SQL и файл в хранилище."""

    table: str = Field(min_length=1, max_length=80)
    bucket: str = Field(min_length=1, max_length=200)
    key: str = Field(min_length=1, max_length=1024)


class ColumnarQueryInput(BaseModel):
    """Запрос компилятора в диалекте DuckDB поверх копий (ADR-0109).

    Политики строк и столбцов уже внутри `sql`: движок его не разбирает и не
    меняет, значения приходят только параметрами.
    """

    sql: str = Field(min_length=1, max_length=1_000_000)
    params: list[Any] = Field(default_factory=list, max_length=2000)
    countSql: str | None = Field(default=None, max_length=1_000_000)  # noqa: N815 — поле контракта
    countParams: list[Any] = Field(default_factory=list, max_length=2000)  # noqa: N815
    sources: list[ColumnarSource] = Field(min_length=1, max_length=20)
    timeoutMs: int = Field(default=30_000, ge=100, le=600_000)  # noqa: N815 — поле контракта


@app.post("/data/columnar/query")
async def data_columnar_query(
    body: ColumnarQueryInput,
    x_kchs_service_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Счёт агрегата DuckDB поверх Parquet колоночной копии (06-analytics-engine.md §19)."""
    require_service_token(x_kchs_service_token)
    try:
        return await columnar_query(body.model_dump())
    except ColumnarError as error:
        raise HTTPException(status_code=422, detail=_sentence(str(error))) from error
    except TimeoutError as error:
        raise HTTPException(
            status_code=504, detail="Запрос по колоночной копии выполнялся слишком долго"
        ) from error
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        if code in ("NoSuchKey", "404", "NotFound"):
            raise HTTPException(status_code=404, detail="Колоночная копия не найдена") from error
        raise


class EmbedInput(BaseModel):
    """Тексты для векторизации: запрос поиска или куски объекта (ADR-0099)."""

    texts: list[str] = Field(min_length=1, max_length=64)


@app.post("/ai/embed")
async def ai_embed(
    body: EmbedInput,
    x_kchs_service_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Векторы текстов для поиска по смыслу.

    Без настроенной модели — 503: api переходит на словесный поиск и не считает
    это сбоем установки.
    """
    require_service_token(x_kchs_service_token)
    if not embeddings_enabled():
        raise HTTPException(status_code=503, detail="Модель векторов не настроена")
    timeout = settings().ENGINE_EMBEDDING_TIMEOUT_S
    try:
        result = await asyncio.wait_for(asyncio.to_thread(embed, body.texts), timeout=timeout)
    except TimeoutError as error:
        raise HTTPException(
            status_code=504, detail=f"Векторы не посчитались за {timeout} с"
        ) from error
    log.info("embed.done", texts=len(body.texts), dim=result.dim)
    return result.as_payload()
