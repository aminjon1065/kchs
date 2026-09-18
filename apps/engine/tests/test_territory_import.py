"""Поле-территория в импорте (ADR-0057): код, название на любом языке или
идентификатор → идентификатор справочника; неизвестное и неоднозначное — ошибки строк."""

from pathlib import Path

import pytest
from import_helpers import normalize

from kchs_engine.data.normalize import ImportSpecError, territory_key

KT = "0198a0b6-0000-7000-8000-000000000001"
KT01 = "0198a0b6-0000-7000-8000-000000000002"

# Как передаёт API: ключи сопоставления → идентификатор, "" — неоднозначное название
TERRITORIES = {
    "tj-kt": KT,
    "хатлонская область": KT,
    "khatlon region": KT,
    "tj-kt-01": KT01,
    "бохтар": KT01,
    KT: KT,
    KT01: KT01,
    "сино": "",
}

MAPPING = [
    {"column": 0, "fieldKey": "code", "type": "identifier"},
    {"column": 1, "fieldKey": "place", "type": "territory"},
]


def test_ключ_сопоставления_как_в_api() -> None:
    assert territory_key("  Хатлонская   ОБЛАСТЬ ") == "хатлонская область"
    assert territory_key("Ёвон") == "евон"


def test_код_название_и_идентификатор_дают_идентификатор(tmp_path: Path) -> None:
    source = tmp_path / "places.csv"
    source.write_text(
        "Номер,Район\n"
        "A-1,TJ-KT-01\n"
        "A-2,  бохтар \n"
        "A-3,Khatlon Region\n"
        f"A-4,{KT01}\n"
        "A-5,\n"
        "A-6,Атлантида\n"
        "A-7,Сино\n",
        encoding="utf-8",
    )
    result = normalize(source, MAPPING, territories=TERRITORIES)
    # Нормализованный файл без заголовка: номер строки, затем поля сопоставления
    places = [row[2] for row in result.rows]
    # Строки с ошибками не попадают в нормализованный файл (onError решает загрузчик)
    assert places == [KT01, KT01, KT, KT01, None]
    assert [(item["field"], item["value"], item["code"]) for item in result.errors] == [
        ("place", "Атлантида", "unknown_territory"),
        ("place", "Сино", "ambiguous_territory"),
    ]


def test_без_справочника_поле_территория_недопустимо(tmp_path: Path) -> None:
    source = tmp_path / "places.csv"
    source.write_text("Номер,Район\nA-1,TJ-KT\n", encoding="utf-8")
    with pytest.raises(ImportSpecError):
        normalize(source, MAPPING)
