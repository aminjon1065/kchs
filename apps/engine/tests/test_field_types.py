"""Реестр хранения полей и слова «да/нет» (ADR-0190).

Источник — `packages/contracts` (`FIELD_STORAGE`, `BOOLEAN_WORDS`); движок читает
сгенерированный `field_types.json`. Прежде одно и то же соответствие жило в пяти
местах на двух языках и расходилось: импорт файла не понимал `on`, `off`, `-`,
а вставка в таблицу — `t`, `вкл`, `ха`, `✔`.
"""

import pyarrow as pa
import pytest

from kchs_engine.contracts import field_storage, field_types_contract, fields_of_export_family
from kchs_engine.data import columnar, geo_export
from kchs_engine.data.values import parse_boolean

# Ожидаемые типы Arrow колоночной копии — как было до реестра
EXPECTED_ARROW = {
    "text": pa.string(),
    "long_text": pa.string(),
    "select": pa.string(),
    "identifier": pa.string(),
    "url": pa.string(),
    "email": pa.string(),
    "phone": pa.string(),
    "integer": pa.int64(),
    "number": pa.float64(),
    "percent": pa.float64(),
    "duration": pa.float64(),
    "decimal": pa.decimal128(38, 12),
    "money": pa.decimal128(38, 12),
    "boolean": pa.bool_(),
    "date": pa.date32(),
    "datetime": pa.timestamp("us", tz="UTC"),
    "time": pa.time64("us"),
    "multi_select": pa.list_(pa.string()),
    "user": pa.string(),
    "unit": pa.string(),
    "territory": pa.string(),
    "object_ref": pa.string(),
    "file": pa.string(),
    "json": pa.string(),
}


def test_registry_covers_every_stored_type() -> None:
    storage = field_types_contract()["storage"]
    assert set(storage) == {*EXPECTED_ARROW, "geometry"}
    for kind, item in storage.items():
        assert item["exportFamily"] in field_types_contract()["exportFamilies"], kind
        assert item["arrow"] is None or item["arrow"] in field_types_contract()["arrowTypes"], kind


@pytest.mark.parametrize("kind", sorted(EXPECTED_ARROW))
def test_columnar_arrow_types_follow_registry(kind: str) -> None:
    assert columnar._arrow_type(kind) == EXPECTED_ARROW[kind]


def test_geometry_is_not_in_columnar_copy() -> None:
    assert field_storage("geometry")["arrow"] is None
    with pytest.raises(columnar.ColumnarError):
        columnar._arrow_type("geometry")
    with pytest.raises(columnar.ColumnarError):
        columnar._arrow_type("formula")


def test_columnar_decimal_and_duration_from_registry() -> None:
    contract = field_types_contract()
    assert (
        contract["columnarDecimal"]["precision"],
        contract["columnarDecimal"]["scale"],
    ) == (columnar.DECIMAL_PRECISION, columnar.DECIMAL_SCALE)
    assert contract["durationUnit"] == "minute"
    assert "/ 60" in columnar._select_expr(columnar.Column("c_1", "duration"))
    assert columnar._select_expr(columnar.Column("c_2", "json")) == '"c_2"::text'
    assert columnar._select_expr(columnar.Column("c_3", "multi_select")) == '"c_3"'


def test_geo_export_families_follow_registry() -> None:
    assert geo_export._INTEGER == fields_of_export_family("integer") == {"integer"}
    assert {"number", "decimal", "money", "percent"} == geo_export._REAL
    assert {"boolean"} == geo_export._BOOLEAN
    assert {"date"} == geo_export._DATE
    assert {"datetime"} == geo_export._DATETIME


def test_boolean_words_are_one_set_for_paste_and_import() -> None:
    words = field_types_contract()["booleanWords"]
    for word in words["true"]:
        assert parse_boolean(word) == "true", word
    for word in words["false"]:
        assert parse_boolean(word) == "false", word
    # Слова, которые прежде понимала только одна сторона
    for word in ("on", "t", "вкл", "ха", "✔", " ВКЛ "):
        assert parse_boolean(word) == "true", word
    for word in ("off", "-", "f", "выкл"):
        assert parse_boolean(word) == "false", word
    assert parse_boolean("может быть") is None
