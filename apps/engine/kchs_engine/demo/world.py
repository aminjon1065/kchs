"""Мир демо-данных: районы со своими населёнными пунктами.

Происшествия, объекты защиты, зоны риска и гидропосты «привязаны» к одним и
тем же синтетическим населённым пунктам района: точки на карте сгущаются у
кишлаков и микрорайонов, а описание происшествия называет тот пункт, возле
которого стоит точка. Пункты зависят только от seed — одинаковы в любом профиле.
"""

import math
from dataclasses import dataclass

from kchs_engine.demo.reference import (
    CITY,
    CITY_DISTRICT,
    DISTRICTS,
    STREETS,
    VILLAGES,
    DistrictInfo,
)
from kchs_engine.demo.rng import Rng, Weights

KM_PER_DEGREE = 111.32
# Кварталов в городе — не больше
QUARTERS = 40


@dataclass(frozen=True, slots=True)
class Place:
    """Населённый пункт (кишлак), микрорайон или улица города."""

    name: str
    lat: float
    lon: float
    # «в кишлаке Навобод» и «у кишлака Навобод» — для описаний и названий
    at: str
    near: str
    # Кишлак (его имя годится в название объекта), а не микрорайон или улица
    village: bool


@dataclass(frozen=True)
class District:
    info: DistrictInfo
    region: str
    places: tuple[Place, ...]
    place_weights: Weights
    # «в районе Айни», «в городе Куляб»
    where: str

    @property
    def code(self) -> str:
        return self.info.code

    def weight(self, population_power: float, mountain_power: float) -> float:
        """Вес района для выбора: население и горность в заданных степенях."""
        info = self.info
        return float(info.population**population_power * info.mountain**mountain_power)


def offset(lat: float, lon: float, east_km: float, north_km: float) -> tuple[float, float]:
    """Точка, смещённая на east_km к востоку и north_km к северу."""
    lat2 = lat + north_km / KM_PER_DEGREE
    lon2 = lon + east_km / (KM_PER_DEGREE * math.cos(math.radians(lat)))
    return lat2, lon2


def _sample[T](rng: Rng, items: tuple[T, ...], count: int) -> list[T]:
    """`count` разных элементов в случайном порядке (частичная перетасовка Фишера — Йетса)."""
    pool = list(items)
    for index in range(count):
        other = index + rng.below(len(pool) - index)
        pool[index], pool[other] = pool[other], pool[index]
    return pool[:count]


def _places(rng: Rng, info: DistrictInfo) -> list[Place]:
    """Пункты района от крупного к мелкому: у города сначала микрорайоны и улицы
    (ближе к центру), затем кишлаки его джамоатов."""
    count = min(30, max(6, round(4 + math.sqrt(info.population) / 35)))
    if info.kind == CITY_DISTRICT:
        urban = count
    elif info.kind == CITY:
        urban = round(count * 0.4)
    else:
        urban = 0
    places: list[Place] = []
    quarters = _sample(rng, tuple(range(1, QUARTERS + 1)), urban - urban // 2)
    streets = _sample(rng, STREETS, urban // 2)
    for quarter in quarters:
        lat, lon = offset(info.lat, info.lon, *rng.disk(info.radius_km * 0.35))
        text = f"в микрорайоне {quarter}"
        places.append(Place(str(quarter), lat, lon, text, text, village=False))
    for street in streets:
        lat, lon = offset(info.lat, info.lon, *rng.disk(info.radius_km * 0.35))
        text = f"на улице {street}"
        places.append(Place(street, lat, lon, text, text, village=False))
    for village in _sample(rng, VILLAGES, count - urban):
        lat, lon = offset(info.lat, info.lon, *rng.disk(info.radius_km * 0.9))
        at, near = f"в кишлаке {village}", f"у кишлака {village}"
        places.append(Place(village, lat, lon, at, near, village=True))
    return places


def build_districts(seed: int) -> tuple[District, ...]:
    """Районы с населёнными пунктами — одинаковы для одного seed."""
    rng = Rng(seed, "places")
    districts = []
    for info in DISTRICTS:
        places = _places(rng, info)
        # Закон Ципфа: второй пункт вдвое меньше первого и т. д.
        weights = Weights(1.0 / (rank + 1) ** 0.9 for rank in range(len(places)))
        where = f"в городе {info.name}" if info.kind == CITY else f"в районе {info.name}"
        districts.append(District(info, info.code[:5], tuple(places), weights, where))
    return tuple(districts)


def polygon_area_km2(points: list[tuple[float, float]]) -> float:
    """Площадь многоугольника по вершинам в км (восток, север), формула шнурка."""
    total = 0.0
    for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1], strict=True):
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0
