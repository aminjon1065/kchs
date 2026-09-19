"""Населённые пункты справочника территорий (ADR-0067) — кишлаки демо-мира: файл сида API
совпадает с генератором, коды устойчивы, родитель — район."""

import json
from pathlib import Path

import pytest

from kchs_engine.demo.reference import CITY_DISTRICT, DISTRICTS
from kchs_engine.demo.settlements import settlement_items, transliterate

SEED = Path(__file__).resolve().parents[3] / "apps" / "api" / "src" / "seed" / "settlements.json"


@pytest.mark.skipif(not SEED.exists(), reason="нужен репозиторий целиком, а не только движок")
def test_settlement_seed_matches_generator() -> None:
    assert json.loads(SEED.read_text(encoding="utf-8")) == settlement_items()


def test_settlements_are_villages_of_districts() -> None:
    items = settlement_items()
    assert items == settlement_items()
    codes = [item["code"] for item in items]
    assert len(codes) == len(set(codes))
    kinds = {district.code: district.kind for district in DISTRICTS}
    for item in items:
        assert item["level"] == "settlement"
        assert item["code"].startswith(item["parent"] + "-")
        # В районах Душанбе — микрорайоны и улицы, кишлаков нет
        assert kinds[item["parent"]] != CITY_DISTRICT
        assert item["name"]["en"].isascii()


def test_transliterate() -> None:
    assert transliterate("Калъаи Нав") == "Kal'ai Nav"
    assert transliterate("Чинорзор") == "Chinorzor"
    assert transliterate("Хуҷанд") == "Khujand"
    assert transliterate("Кӯлоб") == "Kulob"
