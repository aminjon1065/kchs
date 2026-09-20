"""Колоночный tier (ADR-0109): схема Parquet, DuckDB поверх копии, ответ api.

Здесь проверяется семантика SQL, который пишет диалект DuckDB компилятора
(`packages/query/test/duckdb.test.ts`): политики строк и столбцов, маски,
пояса, списки и агрегаты должны давать те же значения, что и Postgres-путь.
"""

import datetime as dt
import decimal
import math
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from kchs_engine.data import columnar

TERR_MINE = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1"
TERR_OTHER = "cccccccc-cccc-4ccc-8ccc-ccccccccccc4"
NOW = dt.datetime(2026, 9, 18, 7, 30, tzinfo=dt.timezone.utc)
ROWS = 120

#: Столбцы фикстуры — как их строит план копии для датасета «Происшествия».
PLAN = [
    ("_id", "integer"),
    ("_ver", "integer"),
    ("_created_at", "datetime"),
    ("_updated_at", "datetime"),
    ("_created_by", "user"),
    ("_updated_by", "user"),
    ("_deleted_at", "datetime"),
    ("c_1", "text"),
    ("c_2", "select"),
    ("c_3", "money"),
    ("c_4", "integer"),
    ("c_5", "datetime"),
    ("c_6", "date"),
    ("c_7", "territory"),
    ("c_10", "multi_select"),
    ("c_12", "duration"),
    ("c_14", "phone"),
    ("c_15", "time"),
    ("c_16", "json"),
]


def _values(name: str, kind: str) -> list[object]:
    if name == "_id":
        return list(range(1, ROWS + 1))
    if name == "_ver":
        return [1] * ROWS
    if name in ("_created_at", "_updated_at"):
        return [NOW] * ROWS
    if name in ("_deleted_at", "_created_by", "_updated_by"):
        return [None] * ROWS
    match name:
        case "c_1":
            return [f"Авария {i}" for i in range(ROWS)]
        case "c_2":
            return [["fire", "flood", "other"][i % 3] for i in range(ROWS)]
        case "c_3":
            return [decimal.Decimal(f"{1000 + i}.123456789012") for i in range(ROWS)]
        case "c_4":
            return [i % 11 for i in range(ROWS)]
        case "c_5":
            return [NOW - dt.timedelta(days=i * 3) for i in range(ROWS)]
        case "c_6":
            return [(NOW - dt.timedelta(days=i * 3)).date() for i in range(ROWS)]
        case "c_7":
            return [TERR_MINE if i % 2 == 0 else TERR_OTHER for i in range(ROWS)]
        case "c_10":
            return [["крупное", "ночное"] if i % 2 else ["мелкое"] for i in range(ROWS)]
        case "c_12":
            return [float(10 + i % 50) for i in range(ROWS)]
        case "c_14":
            return [f"+9925512345{i % 10}" for i in range(ROWS)]
        case "c_15":
            return [dt.time(10, i % 60) for i in range(ROWS)]
        case "c_16":
            return ['{"a":1}'] * ROWS
    raise AssertionError(kind)


@pytest.fixture(scope="module")
def copy_file(tmp_path_factory: pytest.TempPathFactory) -> Path:
    schema = pa.schema(
        [pa.field(name, columnar._arrow_type(kind)) for name, kind in PLAN]  # noqa: SLF001
    )
    table = pa.table(
        {
            name: pa.array(_values(name, kind), type=columnar._arrow_type(kind))  # noqa: SLF001
            for name, kind in PLAN
        },
        schema=schema,
    )
    target = tmp_path_factory.mktemp("columnar") / "incidents.parquet"
    pq.write_table(table, target, compression="zstd")
    return target


@pytest.fixture
def con(copy_file: Path):
    connection = columnar._connect({"t_incidents": copy_file})  # noqa: SLF001
    yield connection
    connection.close()


def run(con, sql: str, params: list[object] | None = None) -> list[tuple]:
    return con.execute(sql, params or []).fetchall()


TABLE = '"ds"."t_incidents"'
TZ = "'Asia/Dushanbe'"


def test_copy_reads_as_table(con) -> None:
    assert run(con, f"SELECT count(*) FROM {TABLE}")[0][0] == ROWS


def test_row_policy_limits_rows(con) -> None:
    """Политика строк в подзапросе с барьером — как её пишет компилятор."""
    sql = f"""
      WITH "q0" AS (
        SELECT "c_1" AS "title", "c_7" AS "territory_id"
        FROM {TABLE}
        WHERE "_deleted_at" IS NULL AND list_contains(CAST($1 AS VARCHAR[]), "c_7")
        OFFSET 0
      )
      SELECT count(*) FROM "q0"
    """
    assert run(con, sql, [[TERR_MINE]])[0][0] == ROWS // 2
    assert run(con, sql, [[TERR_OTHER]])[0][0] == ROWS // 2
    assert run(con, sql, [[]])[0][0] == 0


def test_column_masks_match_postgres(con) -> None:
    """Маски политики столбцов: телефон, деньги, дата-время, длительность."""
    row = run(
        con,
        f"""
        SELECT
          (CASE WHEN "c_14" IS NULL THEN NULL
                WHEN length("c_14") >= 8 THEN '***' || right("c_14", 4)
                ELSE '***' END),
          CAST((CASE WHEN "c_3" IS NULL OR "c_3" = 0 THEN "c_3"
                ELSE round(CAST(("c_3") AS DOUBLE),
                           CAST((1 - floor(log(abs(CAST(("c_3") AS DOUBLE))))) AS INTEGER))
                END) AS DECIMAL(38,12)),
          ((date_trunc('year', "c_5" AT TIME ZONE {TZ})) AT TIME ZONE {TZ}),
          CAST(date_trunc('year', "c_6") AS DATE)
        FROM {TABLE} WHERE "_id" = 1
        """,
    )[0]
    assert row[0] == "***3450"
    assert row[1] == decimal.Decimal("1000.000000000000")
    assert row[2].year == 2026 and row[2].month == 1
    assert row[3] == dt.date(2026, 1, 1)


def test_aggregate_with_time_bucket(con) -> None:
    rows = run(
        con,
        f"""
        SELECT "c_2" AS "kind",
               CAST(date_trunc('month', CAST("c_5" AT TIME ZONE {TZ} AS DATE)) AS DATE) AS "month",
               count(*) AS "n",
               sum("c_3") AS "total",
               avg("c_4") AS "mean",
               percentile_cont(0.95) WITHIN GROUP (ORDER BY CAST("c_12" AS DOUBLE)) AS "p95",
               count(DISTINCT "c_7") AS "territories"
        FROM {TABLE}
        WHERE "_deleted_at" IS NULL
        GROUP BY 1, 2
        ORDER BY 3 DESC, 1, 2
        """,
    )
    assert rows
    assert sum(row[2] for row in rows) == ROWS
    assert all(isinstance(row[1], dt.date) for row in rows)


def test_list_and_text_operators(con) -> None:
    sql = f"""
      SELECT count(*) FROM {TABLE}
      WHERE list_has_any("c_10", CAST($1 AS VARCHAR[]))
        AND "c_1" ILIKE CAST($2 AS VARCHAR) ESCAPE '\\'
        AND regexp_matches("c_2", CAST($3 AS VARCHAR), 'i')
        AND len("c_10") > 0
    """
    assert run(con, sql, [["ночное"], "%Ава%", "^F"])[0][0] > 0


def test_interval_and_date_math(con) -> None:
    row = run(
        con,
        f"""
        SELECT ("c_6" + to_months(CAST((3) AS INTEGER)))::date,
               (CAST($1 AS DATE) - "c_6"),
               CAST(extract(isodow FROM "c_6") AS INTEGER)
        FROM {TABLE} WHERE "_id" = 1
        """,
        ["2026-09-18"],
    )[0]
    assert row[0].month == 12
    assert row[1] == 0
    assert 1 <= row[2] <= 7


def test_json_value_conversions() -> None:
    convert = columnar._json_value  # noqa: SLF001
    assert convert(None) is None
    assert convert(True) is True
    assert convert(decimal.Decimal("1.50")) == "1.50"
    assert convert(dt.datetime(2026, 1, 2, 3, 4, tzinfo=dt.timezone.utc)) == "2026-01-02T03:04:00Z"
    assert convert(dt.date(2026, 1, 2)) == "2026-01-02"
    assert convert(dt.time(10, 30)) == "10:30:00"
    assert convert(["a", None]) == ["a", None]
    assert convert(float("nan")) is None
    assert convert(math.inf) is None


def test_identifiers_are_checked() -> None:
    assert columnar.ident("t_abc") == '"t_abc"'
    for bad in ('t"; DROP TABLE x', "1abc", "", "t abc", "ds.t"):
        with pytest.raises(columnar.ColumnarError):
            columnar.ident(bad)


def test_plan_rejects_geometry() -> None:
    with pytest.raises(columnar.ColumnarError):
        columnar._arrow_type("geometry")  # noqa: SLF001


def test_select_expression_per_type() -> None:
    expr = columnar._select_expr  # noqa: SLF001
    assert expr(columnar.Column("c_1", "text")) == '"c_1"'
    assert "extract(epoch" in expr(columnar.Column("c_12", "duration"))
    assert "::numeric(38, 12)" in expr(columnar.Column("c_3", "money"))
    assert expr(columnar.Column("c_7", "territory")) == '"c_7"::text'
