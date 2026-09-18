"""Справочник территорий seed API совпадает с территориями генератора демо-данных.

Демо-наборы ссылаются на коды территорий (`territory_code`), а API загружает
справочник из `apps/api/src/seed/territories.json` (ADR-0057): коды, названия,
иерархия и центроиды должны быть одними и теми же.
"""

import json
from pathlib import Path

import pytest

from kchs_engine.demo.reference import COUNTRY, COUNTRY_CENTER, COUNTRY_CODE, DISTRICTS, REGIONS

SEED = Path(__file__).resolve().parents[3] / "apps" / "api" / "src" / "seed" / "territories.json"


@pytest.mark.skipif(not SEED.exists(), reason="нужен репозиторий целиком, а не только движок")
def test_territory_seed_matches_reference() -> None:
    items = {item["code"]: item for item in json.loads(SEED.read_text(encoding="utf-8"))}
    expected = {COUNTRY_CODE, *(region.code for region in REGIONS)}
    expected |= {district.code for district in DISTRICTS}
    assert set(items) == expected

    country = items[COUNTRY_CODE]
    assert country["parent"] is None
    assert country["level"] == "country"
    assert country["name"] == dict(zip(("ru", "tg", "en"), COUNTRY, strict=True))
    assert country["centroid"] == [COUNTRY_CENTER[1], COUNTRY_CENTER[0]]

    population: dict[str, int] = {}
    for district in DISTRICTS:
        region = district.code.rsplit("-", 1)[0]
        population[region] = population.get(region, 0) + district.population
        item = items[district.code]
        assert item["parent"] == region
        assert item["level"] == "district"
        assert item["kind"] == district.kind
        assert item["name"] == {"ru": district.name, "tg": district.name_tg, "en": district.name_en}
        assert item["centroid"] == [district.lon, district.lat]
        assert item["population"] == district.population

    for region in REGIONS:
        item = items[region.code]
        assert item["parent"] == COUNTRY_CODE
        assert item["level"] == "region"
        assert item["kind"] == region.kind
        assert item["name"] == {"ru": region.name, "tg": region.name_tg, "en": region.name_en}
        assert item["centroid"] == [region.lon, region.lat]
        assert item["population"] == population[region.code]
    assert country["population"] == sum(population.values())
