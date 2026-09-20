"""Колоночный tier: копия версии датасета в Parquet и счёт агрегатов DuckDB.

06-analytics-engine.md §19, ADR-0109. Движок делает две вещи:

1. **Сборка копии** — читает строки таблицы датасета ролью только для чтения
   (`kchs_query`, ADR-0048) и пишет Parquet в объектное хранилище. План
   столбцов (физические имена и типы полей) приходит от api: движок не знает
   реестра полей и не решает, что видно пользователю.
2. **Запрос** — выполняет SQL, скомпилированный `packages/query` в диалекте
   DuckDB. Политики строк и столбцов уже внутри этого SQL, как и в
   Postgres-пути: движок не добавляет и не снимает ни одного условия.

Файлы Parquet кэшируются на диске движка: ключ содержит версию датасета,
поэтому новая версия — новый файл, а старый вытесняется по общему объёму.
"""

from __future__ import annotations

import asyncio
import hashlib
import math
import threading
import uuid
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

from kchs_engine import storage
from kchs_engine.config import settings
from kchs_engine.logging import log

PARQUET_CONTENT_TYPE = "application/vnd.apache.parquet"

#: Имя схемы DuckDB, в которой регистрируются копии; совпадает со схемой Postgres,
#: поэтому текст `FROM ds."t_…"` у обоих диалектов одинаковый.
SCHEMA = "ds"

#: Строк в пачке при чтении из Postgres и в группе строк Parquet.
BATCH_ROWS = 100_000

#: Денежные и точные числа: та же ширина, что у диалекта DuckDB компилятора.
DECIMAL_PRECISION = 38
DECIMAL_SCALE = 12

_IDENT_OK = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")

_cache_lock = threading.Lock()


class ColumnarError(RuntimeError):
    """Ошибка данных колоночного tier: повтор её не исправит."""


def ident(name: str) -> str:
    """Проверенный идентификатор в кавычках: имена приходят от api, но не на веру."""
    if not name or name[0].isdigit() or not set(name) <= _IDENT_OK:
        raise ColumnarError(f"недопустимое имя «{name}»")
    return f'"{name}"'


# ─── План столбцов ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Column:
    """Столбец копии: физическое имя и тип поля датасета (контракт `FieldType`)."""

    name: str
    type: str


def _arrow_type(kind: str) -> Any:
    import pyarrow as pa

    match kind:
        case "text" | "long_text" | "select" | "identifier" | "url" | "email" | "phone":
            return pa.string()
        case "integer":
            return pa.int64()
        case "number" | "percent" | "duration":
            return pa.float64()
        case "decimal" | "money":
            return pa.decimal128(DECIMAL_PRECISION, DECIMAL_SCALE)
        case "boolean":
            return pa.bool_()
        case "date":
            return pa.date32()
        case "datetime":
            return pa.timestamp("us", tz="UTC")
        case "time":
            return pa.time64("us")
        case "multi_select":
            return pa.list_(pa.string())
        case "user" | "unit" | "territory" | "object_ref" | "file" | "json":
            return pa.string()
    raise ColumnarError(f"тип поля {kind} не хранится в колоночной копии")


def _select_expr(column: Column) -> str:
    """Выражение чтения столбца из Postgres — значение того вида, что ждёт Parquet."""
    quoted = ident(column.name)
    match column.type:
        case "duration":
            # Компилятор читает длительность минутами — копия хранит уже минуты
            return f"extract(epoch FROM {quoted}) / 60"
        case "decimal" | "money":
            return f"{quoted}::numeric({DECIMAL_PRECISION}, {DECIMAL_SCALE})"
        case "user" | "unit" | "territory" | "object_ref" | "file" | "json":
            # Ссылки и JSON — строками: сравнение канонических идентификаторов
            # посимвольное, лишнего приведения на миллионах строк нет
            return f"{quoted}::text"
        case _:
            return quoted


def _value_for_arrow(value: Any, kind: str) -> Any:
    """Значение psycopg → значение, которое принимает pyarrow."""
    if value is None:
        return None
    if kind in ("decimal", "money"):
        return value if isinstance(value, Decimal) else Decimal(str(value))
    if kind == "datetime" and isinstance(value, datetime):
        return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if kind == "multi_select":
        return [None if item is None else str(item) for item in value]
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, memoryview):
        return bytes(value).decode("utf-8", "replace")
    return value


# ─── Сборка копии ────────────────────────────────────────────────────────────


def _dsn() -> str:
    config = settings()
    dsn = config.DATABASE_QUERY_URL or config.DATABASE_URL
    if not dsn:
        raise ColumnarError("не задан DATABASE_QUERY_URL: колоночную копию собрать нечем")
    return dsn


def _build_copy(
    table: str,
    columns: list[Column],
    target: Path,
    timeout_s: int,
) -> tuple[int, int]:
    """Строки таблицы датасета → Parquet. Возвращает число строк и размер файла."""
    import psycopg
    import pyarrow as pa
    import pyarrow.parquet as pq

    fields = [pa.field(column.name, _arrow_type(column.type)) for column in columns]
    schema = pa.schema(fields)
    projection = ", ".join(f"{_select_expr(column)} AS {ident(column.name)}" for column in columns)
    # Имя таблицы и столбцов проверены `ident`; значений пользователя в тексте нет
    statement = f"SELECT {projection} FROM {SCHEMA}.{ident(table)} WHERE _deleted_at IS NULL"

    rows = 0
    with psycopg.connect(_dsn(), options=f"-c statement_timeout={timeout_s * 1000}") as conn:
        conn.read_only = True
        with (
            conn.cursor(name="kchs_columnar", binary=True) as cursor,
            pq.ParquetWriter(target, schema, compression="zstd") as writer,
        ):
            cursor.itersize = BATCH_ROWS
            cursor.execute(statement)  # type: ignore[arg-type]
            while True:
                batch = cursor.fetchmany(BATCH_ROWS)
                if not batch:
                    break
                arrays = [
                    pa.array(
                        [_value_for_arrow(row[index], column.type) for row in batch],
                        type=fields[index].type,
                    )
                    for index, column in enumerate(columns)
                ]
                writer.write_table(pa.Table.from_arrays(arrays, schema=schema))
                rows += len(batch)
    return rows, target.stat().st_size


async def build(payload: dict[str, Any]) -> dict[str, Any]:
    """Собирает копию версии датасета и кладёт её в хранилище под ключом от api."""
    import tempfile

    table = str(payload["table"])
    bucket = str(payload["bucket"])
    key = str(payload["key"])
    timeout_s = int(payload.get("timeoutS") or settings().ENGINE_COLUMNAR_BUILD_TIMEOUT_S)
    raw_columns = payload.get("columns") or []
    if not raw_columns:
        raise ColumnarError("в плане копии нет ни одного столбца")
    columns = [Column(str(item["name"]), str(item["type"])) for item in raw_columns]

    started = asyncio.get_running_loop().time()
    with tempfile.TemporaryDirectory(prefix="kchs-columnar-") as tmp:
        target = Path(tmp) / "copy.parquet"
        rows, size = await asyncio.to_thread(_build_copy, table, columns, target, timeout_s)
        await storage.upload(bucket, key, target, PARQUET_CONTENT_TYPE)
    build_ms = int((asyncio.get_running_loop().time() - started) * 1000)
    log.info("columnar.built", table=table, key=key, rows=rows, size=size, ms=build_ms)
    return {"rows": rows, "size": size, "buildMs": build_ms, "key": key}


# ─── Кэш файлов на диске движка ──────────────────────────────────────────────


def _cache_dir() -> Path:
    import tempfile

    configured = settings().ENGINE_COLUMNAR_CACHE_DIR.strip()
    folder = Path(configured) if configured else Path(tempfile.gettempdir()) / "kchs-columnar"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _cache_name(bucket: str, key: str) -> str:
    return f"{hashlib.sha256(f'{bucket}/{key}'.encode()).hexdigest()[:32]}.parquet"


def _evict(folder: Path, keep: Path) -> None:
    """Вытеснение по общему объёму: сначала уходят файлы, к которым дольше не обращались."""
    limit = settings().ENGINE_COLUMNAR_CACHE_MB * 1024 * 1024
    files = sorted(folder.glob("*.parquet"), key=lambda item: item.stat().st_atime)
    total = sum(item.stat().st_size for item in files)
    for item in files:
        if total <= limit:
            return
        if item == keep:
            continue
        size = item.stat().st_size
        item.unlink(missing_ok=True)
        total -= size
        log.info("columnar.evicted", file=item.name, size=size)


def _ensure_local(bucket: str, key: str) -> Path:
    """Файл копии на диске движка; отсутствующий — скачивается один раз."""
    folder = _cache_dir()
    target = folder / _cache_name(bucket, key)
    with _cache_lock:
        if target.exists() and target.stat().st_size > 0:
            target.touch()
            return target
        partial = target.with_suffix(".part")
        storage.download_sync(bucket, key, partial)
        partial.replace(target)
        _evict(folder, target)
    log.info("columnar.cached", key=key, size=target.stat().st_size)
    return target


# ─── Запрос ──────────────────────────────────────────────────────────────────


def _json_value(value: Any) -> Any:
    """Значение DuckDB → JSON, как его ждёт api (ISO 8601, числа, списки)."""
    if value is None:
        return None
    if isinstance(value, bool | int | str):
        return value
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else value
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime):
        moment = value.astimezone(timezone.utc) if value.tzinfo else value
        return moment.isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, time):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, list | tuple):
        return [_json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(name): _json_value(item) for name, item in value.items()}
    if isinstance(value, bytes | memoryview):
        return bytes(value).decode("utf-8", "replace")
    return str(value)


def _connect(files: dict[str, Path]) -> Any:
    import duckdb

    config = settings()
    con = duckdb.connect(":memory:")
    try:
        # Пояса (`AT TIME ZONE` компилятора) — расширение icu, оно в сборке Python
        con.execute("LOAD icu")
    except duckdb.Error as error:  # pragma: no cover — зависит от сборки DuckDB
        log.warning("columnar.icu", error=str(error))
    con.execute(f"SET threads={max(1, config.ENGINE_COLUMNAR_THREADS)}")
    con.execute(f"SET memory_limit='{max(256, config.ENGINE_COLUMNAR_MEMORY_MB)}MB'")
    con.execute(f"CREATE SCHEMA IF NOT EXISTS {ident(SCHEMA)}")
    for table, path in files.items():
        # Путь — имя в кэше движка (шестнадцатеричное), не значение из запроса
        literal = str(path).replace("'", "''")
        con.execute(
            f"CREATE OR REPLACE VIEW {ident(SCHEMA)}.{ident(table)} AS "
            f"SELECT * FROM read_parquet('{literal}')"
        )
    return con


def _run(con: Any, sql: str, params: list[Any]) -> tuple[list[str], list[list[Any]]]:
    result = con.execute(sql, params) if params else con.execute(sql)
    names = [column[0] for column in result.description or []]
    rows = [[_json_value(value) for value in row] for row in result.fetchall()]
    return names, rows


def _query(payload: dict[str, Any], files: dict[str, Path]) -> dict[str, Any]:
    con = _connect(files)
    timeout_s = max(1, int(payload.get("timeoutMs") or 30_000) / 1000)
    timer = threading.Timer(timeout_s, con.interrupt)
    timer.start()
    try:
        names, rows = _run(con, str(payload["sql"]), list(payload.get("params") or []))
        total: int | None = None
        count_sql = payload.get("countSql")
        if count_sql:
            _, counted = _run(con, str(count_sql), list(payload.get("countParams") or []))
            total = int(counted[0][0]) if counted and counted[0] and counted[0][0] is not None else 0
    finally:
        timer.cancel()
        con.close()
    return {"columns": names, "rows": rows, "rowCount": total}


async def query(payload: dict[str, Any]) -> dict[str, Any]:
    """Выполняет SQL диалекта DuckDB поверх копий, перечисленных в `sources`."""
    sources = payload.get("sources") or []
    if not sources:
        raise ColumnarError("в запросе не указано ни одной колоночной копии")
    files: dict[str, Path] = {}
    for source in sources:
        table = str(source["table"])
        ident(table)
        files[table] = await asyncio.to_thread(
            _ensure_local, str(source["bucket"]), str(source["key"])
        )
    return await asyncio.to_thread(_query, payload, files)
