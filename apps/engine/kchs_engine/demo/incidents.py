"""«Происшествия»: CSV в хронологическом порядке, по дням, потоком.

Число происшествий за день следует сезонности типов (паводки и сели — весной,
природные пожары и происшествия на воде — летом, лавины, пожары в домах и
взрывы газа — зимой) и медленному росту от года к году; тип — по месяцу,
район — по населению и горности, место — у одного из населённых пунктов
района. Ущерб — логнормальный, пострадавшие и погибшие — редкие события с
геометрическим хвостом. В памяти — только происшествия одного дня.
"""

import math
import string
from collections.abc import Callable, Iterator
from datetime import date, timedelta

from kchs_engine.demo.reference import HOURS, INCIDENT_KINDS, IncidentKind
from kchs_engine.demo.rng import Rng, Weights
from kchs_engine.demo.spec import Column, DatasetSpec, Lookup
from kchs_engine.demo.world import KM_PER_DEGREE, District, Place

PERIOD_START = date(2024, 1, 1)
PERIOD_END = date(2026, 12, 31)
# Рост числа происшествий от года к году — «сравнение с прошлым периодом» не нулевое
YEAR_TREND = {2024: 1.0, 2025: 1.04, 2026: 1.08}
# Ущерб больше — опечатка в донесении, а не происшествие: такое значение разыгрывается заново
DAMAGE_LIMIT = 20_000_000.0

SPEC = DatasetSpec(
    id="incidents",
    file="incidents.csv",
    name="Происшествия",
    kind="table",
    description=(
        "Синтетический журнал происшествий 2024–2026 годов: время (пояс Asia/Dushanbe), "
        "тип, район, координаты, ущерб, пострадавшие и погибшие. Сезонность и "
        "распределение по районам правдоподобны, сами события вымышлены."
    ),
    format="csv",
    columns=(
        Column("code", "Номер", "Number", "identifier", "identifier", required=True),
        Column("occurred_at", "Дата и время", "Date and time", "datetime", "time",
               {"dateFormat": "yyyy-MM-dd HH:mm"}, required=True),
        Column("type_code", "Тип", "Type", "text", "category", required=True),
        Column("territory_code", "Территория", "Territory", "text", "territory", required=True),
        Column("lat", "Широта", "Latitude", "number", "dimension", {"precision": 5}),
        Column("lon", "Долгота", "Longitude", "number", "dimension", {"precision": 5}),
        Column("damage", "Ущерб, сомони", "Damage, TJS", "money", "measure",
               {"precision": 2, "currency": "TJS", "thousands": True}),
        Column("injured", "Пострадавшие", "Injured", "integer", "measure"),
        Column("deaths", "Погибшие", "Deaths", "integer", "measure"),
        Column("description", "Описание", "Description", "text", "text"),
    ),
    key=("code",),
    time_field="occurred_at",
    territory_field="territory_code",
    geometry="latlon",
    lookups=(Lookup("type_code", "incident_types"), Lookup("territory_code", "territories")),
)  # fmt: skip


def plural(count: int, one: str, few: str, many: str) -> str:
    """Согласование с числом: 1 дом, 2 дома, 5 домов."""
    tail = count % 100
    if 11 <= tail <= 14:
        return many
    if count % 10 == 1:
        return one
    if 2 <= count % 10 <= 4:
        return few
    return many


# ─── Описание ────────────────────────────────────────────────────────────────


class Slots(dict[str, str]):
    """Подстановки шаблона описания; значение считается при первом обращении."""

    __slots__ = ("district", "injured", "place", "rng")

    def __init__(self, rng: Rng, district: District, place: Place, injured: int) -> None:
        super().__init__()
        self.rng = rng
        self.district = district
        self.place = place
        self.injured = injured

    def __missing__(self, key: str) -> str:
        value = SLOTS[key](self)
        self[key] = value
        return value


def _count(low: int, high: int, one: str, few: str, many: str) -> Callable[[Slots], str]:
    def make(slots: Slots) -> str:
        value = slots.rng.between(low, high)
        return f"{value} {plural(value, one, few, many)}"

    return make


def _number(low: int, high: int, unit: str, step: int = 1) -> Callable[[Slots], str]:
    def make(slots: Slots) -> str:
        return f"{slots.rng.between(low, high) * step} {unit}".rstrip()

    return make


def _magnitude(slots: Slots) -> str:
    return f"{slots.rng.uniform(3.5, 6.2):.1f}".replace(".", ",")


def _sick(slots: Slots) -> str:
    return f"{slots.injured} {plural(slots.injured, 'человек', 'человека', 'человек')}"


SLOTS: dict[str, Callable[[Slots], str]] = {
    "place": lambda slots: slots.place.at,
    "near": lambda slots: slots.place.near,
    "where": lambda slots: slots.district.where,
    # Родительный падеж («кровли 5 домов») — числа 2…20, где «домов» верно всегда
    "houses": _count(2, 20, "дом", "дома", "домов"),
    "houses_gen": _number(2, 20, "домов"),
    "people": _count(5, 250, "человек", "человека", "человек"),
    "ha": _number(1, 300, "га"),
    "area": _number(10, 900, "м²"),
    "road": _number(2, 80, "м", step=10),
    "cars": _count(2, 4, "автомобиль", "автомобиля", "автомобилей"),
    "cars_gen": _number(2, 4, "автомобилей"),
    "cattle": _count(3, 150, "голова", "головы", "голов"),
    "intensity": _count(3, 7, "балл", "балла", "баллов"),
    "magnitude": _magnitude,
    "count": _number(2, 40, ""),
    "wind": _number(18, 35, "м/с"),
    "sick": _sick,
    "tourists": _number(2, 8, "туристов"),
}


def template_slots(template: str) -> set[str]:
    return {name for _text, name, _spec, _conv in string.Formatter().parse(template) if name}


# ─── Генерация ───────────────────────────────────────────────────────────────


def period_days() -> list[date]:
    days = (PERIOD_END - PERIOD_START).days + 1
    return [PERIOD_START + timedelta(days=offset) for offset in range(days)]


def day_plan(rng: Rng, rows: int) -> list[tuple[date, int]]:
    """Число происшествий по дням: сезонность, тренд по годам и шум, в сумме ровно `rows`."""
    days = period_days()
    monthly = [
        sum(kind.share * kind.season[month] for kind in INCIDENT_KINDS) for month in range(12)
    ]
    weights = [
        monthly[day.month - 1] * YEAR_TREND[day.year] * (0.8 + 0.4 * rng.random()) for day in days
    ]
    total = math.fsum(weights)
    plan: list[tuple[date, int]] = []
    running = 0.0
    placed = 0
    for day, weight in zip(days, weights, strict=True):
        running += weight
        target = min(rows, round(rows * running / total))
        plan.append((day, target - placed))
        placed = target
    last_day, last_count = plan[-1]
    plan[-1] = (last_day, last_count + rows - placed)
    return plan


class _Kind:
    """Тип происшествия с заранее посчитанными весами районов и часов."""

    __slots__ = ("districts", "hours", "info", "spread", "templates")

    def __init__(self, info: IncidentKind, districts: tuple[District, ...]) -> None:
        self.info = info
        self.districts = Weights(
            district.weight(info.population_power, info.mountain_power) for district in districts
        )
        self.hours = Weights(HOURS[info.hours])
        self.spread = info.spread_km
        self.templates = info.templates


def incident_lines(districts: tuple[District, ...], rows: int, seed: int) -> Iterator[str]:
    """Строки CSV (заголовок и по куску на день) — одинаковые для одного seed."""
    rng = Rng(seed, "incidents")
    random = rng.random
    kinds = [_Kind(info, districts) for info in INCIDENT_KINDS]
    by_month = [
        Weights(kind.share * kind.season[month] for kind in INCIDENT_KINDS) for month in range(12)
    ]
    yield SPEC.csv_header()

    cos = math.cos
    sin = math.sin
    two_pi = 2.0 * math.pi
    sequence = 0
    year = PERIOD_START.year
    for day, count in day_plan(rng, rows):
        if count == 0:
            continue
        if day.year != year:
            year, sequence = day.year, 0
        month = by_month[day.month - 1]
        events: list[tuple[int, int]] = []
        for _ in range(count):
            index = month.index(random())
            minute = kinds[index].hours.index(random()) * 60 + int(random() * 60)
            events.append((minute, index))
        events.sort()
        prefix = f"INC-{year}-"
        day_text = day.isoformat()
        lines: list[str] = []
        for minute, index in events:
            kind = kinds[index]
            info = kind.info
            district = districts[kind.districts.index(random())]
            place = district.places[district.place_weights.index(random())]
            # Точка — у населённого пункта, гуще к нему самому
            distance = kind.spread * random() ** 0.7
            angle = two_pi * random()
            lat = place.lat + distance * sin(angle) / KM_PER_DEGREE
            lon = place.lon + distance * cos(angle) / (KM_PER_DEGREE * cos(math.radians(place.lat)))
            if info.damage_known and random() < info.damage_known:
                value = rng.lognormal(info.damage_median, info.damage_sigma)
                while value > DAMAGE_LIMIT:
                    value = rng.lognormal(info.damage_median, info.damage_sigma)
                damage = f"{value:.2f}"
            else:
                damage = ""
            if random() < info.injured_chance:
                floor = info.injured_min - 1
                injured = min(floor + rng.geometric(info.injured_mean - floor), 999)
            else:
                injured = 0
            deaths = rng.geometric(info.deaths_mean) if random() < info.deaths_chance else 0
            template = kind.templates[int(random() * len(kind.templates))]
            description = template.format_map(Slots(rng, district, place, injured))
            sequence += 1
            lines.append(
                f"{prefix}{sequence:07d},{day_text} {minute // 60:02d}:{minute % 60:02d},"
                f"{info.code},{district.code},{lat:.5f},{lon:.5f},{damage},{injured},{deaths},"
                f'"{description}"\n'
            )
        yield "".join(lines)
