"""Границы районов в сиде API (ADR-0067): все районы справочника, замкнутые кольца в
пределах страны, покрытие без наложений и правдоподобная площадь страны.

Файл строит `kchs_engine.demo.boundaries` из geoBoundaries (нужны shapely и исходники);
здесь проверяется результат, который загружает API.
"""

import json
import math
from pathlib import Path
from typing import Any

import pytest

from kchs_engine.demo.reference import CITY, CITY_DISTRICT, DISTRICTS

SEED = Path(__file__).resolve().parents[3] / "apps" / "api" / "src" / "seed"
BOUNDARIES = SEED / "territory-boundaries.json"
# Прямоугольник Таджикистана с запасом: запад, юг, восток, север
EXTENT = (67.3, 36.6, 75.2, 41.1)
KM_PER_DEGREE = 111.32

pytestmark = pytest.mark.skipif(
    not BOUNDARIES.exists(), reason="нужен репозиторий целиком, а не только движок"
)


def load() -> dict[str, Any]:
    return dict(json.loads(BOUNDARIES.read_text(encoding="utf-8")))


def test_every_district_has_a_boundary() -> None:
    document = load()
    assert document["license"] == "ODbL-1.0"
    assert "OpenStreetMap" in document["attribution"]
    methods = {unit["code"]: unit["method"] for unit in document["units"]}
    assert set(methods) == {district.code for district in DISTRICTS}
    for district in DISTRICTS:
        method = methods[district.code]
        if district.kind == CITY_DISTRICT:
            assert method == "voronoi"
        elif method == "circle":
            assert district.kind == CITY
        else:
            assert method == "osm"
    assert list(methods.values()).count("osm") == 58


def test_rings_are_closed_and_inside_the_country() -> None:
    for unit in load()["units"]:
        geometry = unit["geometry"]
        assert geometry["type"] == "MultiPolygon"
        for polygon in geometry["coordinates"]:
            for ring in polygon:
                assert len(ring) >= 4
                assert ring[0] == ring[-1]
                for lon, lat in ring:
                    assert EXTENT[0] <= lon <= EXTENT[2]
                    assert EXTENT[1] <= lat <= EXTENT[3]
                    assert round(lon, 4) == lon and round(lat, 4) == lat


def test_districts_form_a_valid_coverage() -> None:
    shapely = pytest.importorskip("shapely")
    from shapely.geometry import shape

    geometries = [shape(unit["geometry"]) for unit in load()["units"]]
    assert all(geometry.is_valid for geometry in geometries)
    assert shapely.coverage_is_valid(geometries)
    union = shapely.union_all(geometries)
    # Без наложений: сумма площадей равна площади объединения
    assert sum(geometry.area for geometry in geometries) == pytest.approx(union.area, rel=1e-9)
    # Площадь страны (≈ 141–143 тыс. км²) в равнопромежуточном приближении по широте
    area = sum(
        part.area * KM_PER_DEGREE**2 * math.cos(math.radians(part.centroid.y))
        for geometry in geometries
        for part in geometry.geoms
    )
    assert 138_000 < area < 146_000
