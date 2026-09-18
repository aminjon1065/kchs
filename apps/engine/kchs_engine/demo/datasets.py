"""Справочники и остальные наборы демо-данных: территории, типы происшествий,
гидропосты, объекты защиты, зоны риска и уровни воды.

«Происшествия» — отдельно (`incidents.py`): это единственный большой файл.
"""

import csv
import io
import json
import math
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from kchs_engine.demo.incidents import period_days, plural
from kchs_engine.demo.reference import (
    ASSESSMENT_METHODS,
    COUNTRY,
    COUNTRY_CENTER,
    COUNTRY_CODE,
    HAZARDS,
    INCIDENT_KINDS,
    OBJECT_CONDITIONS,
    OBJECT_KINDS,
    REGIONS,
    RISK_LEVELS,
    RIVERS,
    River,
)
from kchs_engine.demo.rng import Rng, Weights
from kchs_engine.demo.spec import Column, DatasetSpec, Lookup
from kchs_engine.demo.world import District, offset, polygon_area_km2

LAT = Column("lat", "Широта", "Latitude", "number", "dimension", {"precision": 5})
LON = Column("lon", "Долгота", "Longitude", "number", "dimension", {"precision": 5})
TERRITORY = Column("territory_code", "Территория", "Territory", "text", "territory")
TERRITORY_LOOKUP = Lookup("territory_code", "territories")


def csv_text(rows: Iterable[Iterable[Any]]) -> str:
    """Строки CSV (запятая, кавычки по необходимости, перевод строки \\n)."""
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="\n").writerows(rows)
    return buffer.getvalue()


def coordinate(value: float) -> str:
    # Пять знаков (≈ 1 м): «38.595» с тремя знаками анализ счёл бы неоднозначным (1,234)
    return f"{value:.5f}"


# ─── Территории ──────────────────────────────────────────────────────────────

TERRITORIES = DatasetSpec(
    id="territories",
    file="territories.csv",
    name="Территории",
    kind="reference",
    description=(
        "Справочник территорий: страна, 5 регионов (коды ISO 3166-2:TJ) и 68 районов и "
        "городов областного подчинения (собственные коды демо-данных TJ-SU-01…). Центроиды "
        "приблизительные, население — округлённая оценка для демонстрации, не статистика."
    ),
    format="csv",
    columns=(
        Column("code", "Код", "Code", "identifier", "identifier", required=True),
        Column("name", "Название", "Name", "text", "dimension", required=True),
        Column("name_tg", "Название (тадж.)", "Name (Tajik)", "text", "dimension"),
        Column("name_en", "Название (англ.)", "Name (English)", "text", "dimension"),
        Column("level", "Уровень", "Level", "text", "category", required=True),
        Column("kind", "Вид", "Kind", "text", "category"),
        Column("parent_code", "Код родителя", "Parent code", "text", "category"),
        LAT,
        LON,
        Column("population", "Население", "Population", "integer", "measure", {"thousands": True}),
    ),
    key=("code",),
    geometry="latlon",
    lookups=(Lookup("parent_code", "territories"),),
)


def territory_rows(districts: tuple[District, ...]) -> list[list[Any]]:
    by_region: dict[str, int] = {}
    for district in districts:
        by_region[district.region] = by_region.get(district.region, 0) + district.info.population
    name, name_tg, name_en = COUNTRY
    rows: list[list[Any]] = [
        [COUNTRY_CODE, name, name_tg, name_en, "страна", "республика", "",
         coordinate(COUNTRY_CENTER[0]), coordinate(COUNTRY_CENTER[1]), sum(by_region.values())]
    ]  # fmt: skip
    for region in REGIONS:
        rows.append(
            [region.code, region.name, region.name_tg, region.name_en, "регион", region.kind,
             COUNTRY_CODE, coordinate(region.lat), coordinate(region.lon), by_region[region.code]]
        )  # fmt: skip
    for district in districts:
        info = district.info
        rows.append(
            [info.code, info.name, info.name_tg, info.name_en, "район", info.kind,
             district.region, coordinate(info.lat), coordinate(info.lon), info.population]
        )  # fmt: skip
    rows.sort(key=lambda row: str(row[0]))
    return rows


# ─── Типы происшествий ───────────────────────────────────────────────────────

INCIDENT_TYPES = DatasetSpec(
    id="incident_types",
    file="incident_types.csv",
    name="Типы происшествий",
    kind="reference",
    description="Справочник типов происшествий: код, название и группа "
    "(природные, техногенные, биолого-социальные).",
    format="csv",
    columns=(
        Column("code", "Код", "Code", "identifier", "identifier", required=True),
        Column("name", "Название", "Name", "text", "dimension", required=True),
        Column("group_name", "Группа", "Group", "text", "category", required=True),
    ),
    key=("code",),
)


def incident_type_rows() -> list[list[Any]]:
    return [[kind.code, kind.name, kind.group] for kind in INCIDENT_KINDS]


# ─── Гидропосты и уровни воды ────────────────────────────────────────────────

HYDRO_POSTS = DatasetSpec(
    id="hydro_posts",
    file="hydro_posts.csv",
    name="Гидропосты",
    kind="reference",
    description="Синтетические гидропосты на реках Таджикистана: река, район, координаты "
    "и опасный уровень воды.",
    format="csv",
    columns=(
        Column("code", "Код", "Code", "identifier", "identifier", required=True),
        Column("name", "Название", "Name", "text", "dimension", required=True),
        Column("river", "Река", "River", "text", "category"),
        TERRITORY,
        LAT,
        LON,
        Column("danger_level_cm", "Опасный уровень, см", "Danger level, cm", "integer", "measure"),
    ),
    key=("code",),
    territory_field="territory_code",
    geometry="latlon",
    lookups=(TERRITORY_LOOKUP,),
)

WATER_LEVELS = DatasetSpec(
    id="water_levels",
    file="water_levels.csv",
    name="Уровни воды",
    kind="table",
    description="Синтетический временной ряд: ежесуточные уровень и расход воды на гидропостах "
    "за 2024–2026 годы — пик в мае у рек снегового питания, в июле — ледникового, "
    "паводковые волны и превышения опасного уровня.",
    format="csv",
    columns=(
        Column("observed_on", "Дата", "Date", "date", "time", {"dateFormat": "yyyy-MM-dd"},
               required=True),
        Column("post_code", "Гидропост", "Gauging station", "text", "category", required=True),
        TERRITORY,
        Column("level_cm", "Уровень воды, см", "Water level, cm", "integer", "measure"),
        Column("discharge", "Расход воды, м³/с", "Discharge, m³/s", "number", "measure",
               {"precision": 1}),
        Column("above_danger", "Выше опасного уровня", "Above danger level", "boolean",
               "category"),
    ),
    key=("observed_on", "post_code"),
    time_field="observed_on",
    territory_field="territory_code",
    lookups=(Lookup("post_code", "hydro_posts"), TERRITORY_LOOKUP),
)  # fmt: skip


@dataclass(frozen=True)
class Regime:
    # День года пика половодья, острота пика (степень), амплитуда уровня, см
    peak: float
    sharpness: float
    amplitude: float


REGIMES = {
    "glacier": Regime(200.0, 1.6, 260.0),
    "snow": Regime(130.0, 2.5, 150.0),
    "regulated": Regime(170.0, 1.0, 70.0),
}


@dataclass(frozen=True)
class Post:
    code: str
    name: str
    river: River
    district: District
    lat: float
    lon: float
    danger_cm: int
    base_cm: float
    amplitude_cm: float
    peak_day: float
    sharpness: float
    discharge: float


def build_posts(districts: tuple[District, ...], seed: int) -> tuple[Post, ...]:
    """Гидропосты: по очереди первый пост каждой реки, затем второй… — у малого
    профиля (первые посты) реки разные."""
    rng = Rng(seed, "posts")
    by_name = {district.info.name: district for district in districts}
    order: list[tuple[River, int]] = []
    for position in range(max(len(river.districts) for river in RIVERS)):
        order.extend((river, position) for river in RIVERS if position < len(river.districts))
    posts = []
    for number, (river, position) in enumerate(order, start=1):
        district = by_name[river.districts[position]]
        place = district.places[district.place_weights.index(rng.random())]
        lat, lon = offset(place.lat, place.lon, *rng.disk(0.5))
        regime = REGIMES[river.regime]
        downstream = position / max(len(river.districts) - 1, 1)
        base = rng.uniform(60.0, 140.0) + 60.0 * downstream
        amplitude = regime.amplitude * rng.uniform(0.75, 1.25) * (1.0 + 0.3 * downstream)
        posts.append(
            Post(
                code=f"HP-{number:02d}",
                name=f"{river.name} — {district.info.name}",
                river=river,
                district=district,
                lat=lat,
                lon=lon,
                danger_cm=round((base + amplitude * 1.05) / 10) * 10,
                base_cm=base,
                amplitude_cm=amplitude,
                peak_day=regime.peak + rng.uniform(-10.0, 10.0),
                sharpness=regime.sharpness,
                discharge=river.discharge * (0.4 + 0.6 * downstream) * rng.uniform(0.8, 1.2),
            )
        )
    return tuple(posts)


def post_rows(posts: tuple[Post, ...]) -> list[list[Any]]:
    return [
        [post.code, post.name, post.river.name, post.district.code, coordinate(post.lat),
         coordinate(post.lon), post.danger_cm]
        for post in posts
    ]  # fmt: skip


def water_lines(posts: tuple[Post, ...], seed: int) -> Iterator[str]:
    """Уровни воды по дням: сезонная волна, влажность года, инерционный шум и паводки."""
    rng = Rng(seed, "water")
    days = period_days()
    years = sorted({day.year for day in days})
    wetness = [{year: rng.uniform(0.85, 1.15) for year in years} for _post in posts]
    noise = [0.0] * len(posts)
    flood = [0.0] * len(posts)
    yield WATER_LEVELS.csv_header()
    for day in days:
        day_of_year = day.timetuple().tm_yday
        text = day.isoformat()
        lines = []
        for index, post in enumerate(posts):
            phase = 2.0 * math.pi * (day_of_year - post.peak_day) / 365.25
            season = ((1.0 + math.cos(phase)) / 2.0) ** post.sharpness
            noise[index] = 0.8 * noise[index] + rng.normal() * 0.04 * post.amplitude_cm
            flood[index] *= 0.6
            if rng.random() < 0.012 * season:
                flood[index] += post.amplitude_cm * rng.uniform(0.1, 0.5)
            level = max(
                5,
                round(
                    post.base_cm
                    + post.amplitude_cm * wetness[index][day.year] * season
                    + noise[index]
                    + flood[index]
                ),
            )
            head = max((level - 0.5 * post.base_cm) / 100.0, 0.05)
            discharge = post.discharge * head**1.5
            above = "да" if level >= post.danger_cm else "нет"
            lines.append(
                f"{text},{post.code},{post.district.code},{level},{discharge:.1f},{above}\n"
            )
        yield "".join(lines)


# ─── Объекты защиты ──────────────────────────────────────────────────────────

PROTECTED_OBJECTS = DatasetSpec(
    id="protected_objects",
    file="protected_objects.geojson",
    name="Объекты защиты",
    kind="table",
    description="Синтетические объекты защиты и инфраструктуры: школы, детские сады, "
    "больницы, пункты временного размещения, мосты, дамбы, малые ГЭС, подстанции и др. "
    "с вместимостью, годом постройки, сейсмостойкостью и состоянием.",
    format="geojson",
    columns=(
        Column("code", "Код", "Code", "identifier", "identifier", required=True),
        Column("name", "Название", "Name", "text", "dimension", required=True),
        Column("object_type", "Тип", "Type", "text", "category", required=True),
        TERRITORY,
        Column("capacity", "Вместимость, чел.", "Capacity, people", "integer", "measure"),
        Column("built_year", "Год постройки", "Year built", "integer", "dimension"),
        Column("seismic_rating", "Сейсмостойкость, баллов", "Seismic resistance, points",
               "integer", "dimension"),
        Column("condition", "Состояние", "Condition", "text", "category"),
    ),
    key=("code",),
    territory_field="territory_code",
    geometry="features",
    lookups=(TERRITORY_LOOKUP,),
)  # fmt: skip


def _feature(properties: dict[str, Any], geometry: str) -> str:
    body = json.dumps(properties, ensure_ascii=False, separators=(",", ":"))
    return f'{{"type":"Feature","properties":{body},"geometry":{geometry}}}'


def feature_collection(name: str, features: Iterable[str]) -> Iterator[str]:
    """GeoJSON FeatureCollection: по объекту на строку, без держания всех в памяти."""
    yield f'{{"type":"FeatureCollection","name":{json.dumps(name, ensure_ascii=False)},'
    yield '"features":[\n'
    separator = ""
    for feature in features:
        yield separator + feature
        separator = ",\n"
    yield "\n]}\n"


def _capacity(rng: Rng, bounds: tuple[int, int]) -> int:
    value = rng.log_uniform(bounds[0], bounds[1])
    step = 100 if value >= 2000 else 10 if value >= 100 else 5
    return max(step, round(value / step) * step)


def _built_year(rng: Rng) -> int:
    if rng.chance(0.55):
        return rng.between(1955, 1991)
    # После 1991 года строят всё больше: новые объекты чаще недавние
    return 2025 - int(34 * rng.random() ** 1.6)


def _seismic_rating(rng: Rng, year: int) -> int:
    base = 6 if year < 1970 else 7 if year < 1992 else 8 if year < 2010 else 9
    shift = (1 if rng.chance(0.25) else 0) - (1 if rng.chance(0.15) else 0)
    return min(9, max(6, base + shift))


_CONDITIONS = {
    "old": Weights((0.30, 0.45, 0.25)),
    "middle": Weights((0.57, 0.35, 0.08)),
    "new": Weights((0.89, 0.10, 0.01)),
}


def _condition(rng: Rng, year: int) -> str:
    age = 2026 - year
    weights = _CONDITIONS["old" if age > 50 else "middle" if age > 20 else "new"]
    return OBJECT_CONDITIONS[rng.pick(weights)]


def object_features(districts: tuple[District, ...], count: int, seed: int) -> Iterator[str]:
    rng = Rng(seed, "objects")
    kinds = Weights(kind.share for kind in OBJECT_KINDS)
    placement = [
        Weights(
            district.weight(kind.population_power, kind.mountain_power) for district in districts
        )
        for kind in OBJECT_KINDS
    ]
    numbers: dict[tuple[str, str], int] = {}
    titles: dict[tuple[str, str], int] = {}
    for index in range(count):
        kind_index = rng.pick(kinds)
        kind = OBJECT_KINDS[kind_index]
        district = districts[rng.pick(placement[kind_index])]
        place = district.places[rng.pick(district.place_weights)]
        lat, lon = offset(place.lat, place.lon, *rng.disk(kind.spread_km, 0.7))
        number = numbers.get((district.code, kind.name), 0) + 1
        numbers[district.code, kind.name] = number
        if "{place}" in kind.title and place.village:
            title = kind.title.format(place=place.name)
        else:
            title = kind.title_numbered.format(n=number)
        # Второй «Центр здоровья «Навобод»» в том же районе получает номер
        seen = titles.get((district.code, title), 0) + 1
        titles[district.code, title] = seen
        if seen > 1:
            title = f"{title} № {seen}"
        year = _built_year(rng)
        properties = {
            "Код": f"OBJ-{index + 1:06d}",
            "Название": title,
            "Тип": kind.name,
            "Территория": district.code,
            "Вместимость, чел.": _capacity(rng, kind.capacity) if kind.capacity else None,
            "Год постройки": year,
            "Сейсмостойкость, баллов": _seismic_rating(rng, year),
            "Состояние": _condition(rng, year),
        }
        point = f'{{"type":"Point","coordinates":[{coordinate(lon)},{coordinate(lat)}]}}'
        yield _feature(properties, point)


# ─── Зоны риска ──────────────────────────────────────────────────────────────

RISK_ZONES = DatasetSpec(
    id="risk_zones",
    file="risk_zones.geojson",
    name="Зоны риска",
    kind="table",
    description="Синтетические зоны риска вокруг населённых пунктов районов: подтопление, "
    "сели, оползни, лавины, камнепады и сейсмическая опасность — с уровнем риска, "
    "сезонностью, методом и датой оценки. Контуры условные.",
    format="geojson",
    columns=(
        Column("code", "Код", "Code", "identifier", "identifier", required=True),
        Column("name", "Название", "Name", "text", "dimension", required=True),
        Column("hazard", "Тип угрозы", "Hazard", "text", "category", required=True),
        Column("risk_level", "Уровень риска", "Risk level", "text", "category", required=True),
        TERRITORY,
        Column("season", "Сезонность", "Season", "text", "category"),
        Column("method", "Метод оценки", "Assessment method", "text", "category"),
        Column("area_km2", "Площадь, км²", "Area, km²", "number", "measure", {"precision": 2}),
        Column("assessed_on", "Дата оценки", "Assessment date", "date", "time",
               {"dateFormat": "yyyy-MM-dd"}),
    ),
    key=("code",),
    time_field="assessed_on",
    territory_field="territory_code",
    geometry="features",
    lookups=(TERRITORY_LOOKUP,),
)  # fmt: skip

# Сейсмичность по регионам, баллов (условно: Согд и Хатлон — 8, остальные — 9)
_INTENSITY = {"TJ-DU": 9, "TJ-GB": 9, "TJ-RA": 9, "TJ-KT": 8, "TJ-SU": 8}
_ASSESSED_FROM = date(2023, 1, 1)
_ASSESSED_DAYS = (date(2026, 6, 30) - _ASSESSED_FROM).days + 1


def _ring(
    rng: Rng, lat: float, lon: float, radius_km: float, elongation: float
) -> tuple[list[list[float]], float]:
    """Замкнутое кольцо против часовой стрелки: звёздный многоугольник вокруг центра
    (он всегда простой), растянутый и повёрнутый; площадь, км²."""
    count = rng.between(14, 24)
    phase = rng.uniform(0.0, 2.0 * math.pi)
    turn = rng.uniform(0.0, math.pi)
    stretch = math.sqrt(elongation)
    points: list[tuple[float, float]] = []
    for step in range(count):
        angle = 2.0 * math.pi * step / count
        scale = radius_km * (
            1.0 + 0.18 * math.sin(3.0 * angle + phase) + 0.12 * (rng.random() - 0.5)
        )
        x = scale * math.cos(angle) * stretch
        y = scale * math.sin(angle) / stretch
        points.append(
            (x * math.cos(turn) - y * math.sin(turn), x * math.sin(turn) + y * math.cos(turn))
        )
    ring = []
    for east, north in points:
        point_lat, point_lon = offset(lat, lon, east, north)
        ring.append([round(point_lon, 5), round(point_lat, 5)])
    ring.append(list(ring[0]))
    return ring, polygon_area_km2(points)


def zone_features(districts: tuple[District, ...], seed: int) -> list[str]:
    rng = Rng(seed, "zones")
    river_districts = {name for river in RIVERS for name in river.districts}
    methods = Weights(share for _name, share in ASSESSMENT_METHODS)
    features: list[str] = []
    for district in districts:
        info = district.info
        for hazard in HAZARDS:
            if info.mountain < hazard.min_mountain:
                continue
            if (
                hazard.name == "паводок"
                and info.name not in river_districts
                and info.mountain > 0.5
            ):
                continue
            for _ in range(rng.between(*hazard.zones)):
                if hazard.name == "землетрясение":
                    lat, lon = offset(info.lat, info.lon, *rng.disk(info.radius_km * 0.3))
                    intensity = _INTENSITY[district.region]
                    points = plural(intensity, "балл", "балла", "баллов")
                    title = hazard.title.format(
                        intensity=f"{intensity} {points}", where=district.where
                    )
                else:
                    place = district.places[rng.pick(district.place_weights)]
                    lat, lon = offset(place.lat, place.lon, *rng.disk(1.0))
                    title = hazard.title.format(near=place.near)
                # Зона не больше района: в городских районах Душанбе радиус — 3–4 км
                share = 1.0 if hazard.name == "землетрясение" else 0.4
                radius = min(rng.uniform(*hazard.radius_km), info.radius_km * share)
                ring, area = _ring(rng, lat, lon, radius, rng.uniform(*hazard.elongation))
                danger = min(1.0, info.mountain * hazard.mountain_risk)
                level = Weights(
                    (0.35 - 0.25 * danger, 0.4, 0.17 + 0.15 * danger, 0.08 + 0.1 * danger)
                )
                assessed = _ASSESSED_FROM + timedelta(days=rng.below(_ASSESSED_DAYS))
                properties = {
                    "Код": f"RZ-{len(features) + 1:04d}",
                    "Название": title,
                    "Тип угрозы": hazard.name,
                    "Уровень риска": RISK_LEVELS[rng.pick(level)],
                    "Территория": district.code,
                    "Сезонность": hazard.season,
                    "Метод оценки": ASSESSMENT_METHODS[rng.pick(methods)][0],
                    "Площадь, км²": round(area, 2),
                    "Дата оценки": assessed.isoformat(),
                }
                geometry = json.dumps(
                    {"type": "Polygon", "coordinates": [ring]}, separators=(",", ":")
                )
                features.append(_feature(properties, geometry))
    return features
