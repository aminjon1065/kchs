"""Границы районов справочника территорий для сида API (ADR-0067).

Источник — geoBoundaries gbOpen TJK, уровни ADM1 и ADM2 сборки `RELEASE` (данные
OpenStreetMap в выгрузке Wambacher, 2023). Лицензия — ODbL 1.0: файл сида — производная
база и остаётся под ODbL, атрибуция «© участники OpenStreetMap, geoBoundaries»
(`seeds/README.md`).

- 58 районов ADM2 сопоставлены кодам справочника по названиям (`ADM2_CODES`, с учётом
  переименований 2016–2018 гг.).
- Душанбе — граница ADM1 `TJ-DU`, вырезанная из окружающих районов; четыре района города —
  ячейки Вороного вокруг их центров (условные границы).
- Города, которых в ADM2 нет отдельно (Худжанд, Бустон, Гулистон, Истиклол, Бохтар, Хорог), —
  круги с радиусом по населению вокруг центра, вырезанные из районов своего региона
  (условные границы).
- Покрытие упрощается с сохранением общих границ (`shapely.coverage_simplify`), координаты
  лежат на сетке `GRID`. Регионы и страну API собирает объединением районов при загрузке.

Нужен shapely (extra `gis`, есть в образе движка). Запуск из `apps/engine`:
`python -m kchs_engine.demo.boundaries --out ../api/src/seed/territory-boundaries.json`,
затем `pnpm exec biome format --write apps/api/src/seed/territory-boundaries.json`.
"""

import argparse
import json
import math
import sys
import urllib.request
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path
from typing import Any

import shapely
from shapely.geometry import MultiPoint, MultiPolygon, Point, Polygon, shape

from kchs_engine.demo.reference import CITY, CITY_DISTRICT, DISTRICTS, DistrictInfo
from kchs_engine.demo.world import offset

RELEASE = "9469f09"
SOURCE_URL = (
    "https://github.com/wmgeolab/geoBoundaries/raw/{release}/releaseData/gbOpen/TJK/{level}/"
    "geoBoundaries-TJK-{level}.geojson"
)
SOURCE = f"geoBoundaries gbOpen TJK ADM1/ADM2 {RELEASE} (OpenStreetMap, Wambacher)"
LICENSE = "ODbL-1.0"
ATTRIBUTION = "© участники OpenStreetMap, geoBoundaries"

# Сетка координат, градусы (≈ 10 м): узлы покрытия и вывод
GRID = 1e-4
# Упрощение покрытия: корень из площади удаляемых треугольников, градусы
TOLERANCE = 0.0005
CIRCLE_SEGMENTS = 48

DUSHANBE = "TJ-DU"

# Способ построения границы — в атрибуты единицы
OSM = "osm"
CIRCLE = "circle"
VORONOI = "voronoi"

# Районы ADM2 (shapeName) → коды справочника; в комментарии — нынешнее название
ADM2_CODES = {
    # Согдийская область
    "Asht District": "TJ-SU-10",
    "Ayni District": "TJ-SU-09",
    "Ghafurov District": "TJ-SU-11",  # Бободжон Гафуров
    "Ghonchi District": "TJ-SU-13",  # Деваштич (2016)
    "Isfara District": "TJ-SU-06",
    "Istaravshan District": "TJ-SU-04",
    "Jabbor Rasulov District": "TJ-SU-14",
    "Konibodom District": "TJ-SU-07",
    "Kuhistoni Mastchoh District": "TJ-SU-12",
    "Mastchoh District": "TJ-SU-16",
    "Panjakent District": "TJ-SU-08",
    "Shahriston District": "TJ-SU-18",
    "Spitamen District": "TJ-SU-17",
    "Zafarobod District": "TJ-SU-15",
    # Хатлонская область
    "Baljuvon District": "TJ-KT-06",
    "Bokhtar District": "TJ-KT-14",  # Кушониён (2018)
    "Danghara District": "TJ-KT-09",
    "Dzhami District": "TJ-KT-05",  # Абдурахмони Джоми
    "Farkhor District": "TJ-KT-19",
    "Hamadoni District": "TJ-KT-20",
    "Jilikul District": "TJ-KT-12",  # Дусти (2016)
    "Khovaling District": "TJ-KT-21",
    "Khuroson District": "TJ-KT-22",
    "Kulob District": "TJ-KT-02",
    "Muminobod District": "TJ-KT-15",
    "Norak District": "TJ-KT-04",
    "Nosiri Khusrav District": "TJ-KT-16",
    "Panj District": "TJ-KT-17",
    "Qabodiyon District": "TJ-KT-13",
    "Qumsangir District": "TJ-KT-10",  # Джайхун (2016)
    "Rumi District": "TJ-KT-11",  # Джалолиддини Балхи (2016)
    "Sarband District": "TJ-KT-03",  # Левакант (2018)
    "Shahrtuz District": "TJ-KT-24",
    "Shuro-obod District": "TJ-KT-23",  # Шамсиддин Шохин (2016)
    "Temurmalik District": "TJ-KT-18",
    "Vakhsh District": "TJ-KT-07",
    "Vose' District": "TJ-KT-08",
    "Yovon District": "TJ-KT-25",
    # Горно-Бадахшанская автономная область
    "Darvoz District": "TJ-GB-03",
    "Ishkoshim District": "TJ-GB-04",
    "Murghob District": "TJ-GB-05",
    "Roshtqal'a District": "TJ-GB-06",
    "Rushon District": "TJ-GB-07",
    "Shughnon District": "TJ-GB-08",
    "Vanj District": "TJ-GB-02",
    # Районы республиканского подчинения
    "Faizobod District": "TJ-RA-12",
    "Hisor District": "TJ-RA-02",
    "Jirgatol District": "TJ-RA-06",  # Лахш (2016)
    "Nurobod District": "TJ-RA-07",
    "Rasht District": "TJ-RA-08",
    "Roghun District": "TJ-RA-03",
    "Rudaki District": "TJ-RA-09",
    "Sharinav District": "TJ-RA-13",
    "Tavildara District": "TJ-RA-10",  # Сангвор (2016)
    "Tojikobod District": "TJ-RA-11",
    "Tursunzoda District": "TJ-RA-04",
    "Vahdat District": "TJ-RA-01",
    "Varzob District": "TJ-RA-05",
}

Geometry = Polygon | MultiPolygon
Owner = Callable[[Polygon], str | None]


def region_of(code: str) -> str:
    return code[:5]


def city_radius_km(population: int) -> float:
    """Радиус условной границы города: растёт как корень из населения, от 2,5 до 8 км."""
    return min(8.0, max(2.5, 1.1 * math.sqrt(population / 10_000)))


def circle(info: DistrictInfo) -> Polygon:
    radius = city_radius_km(info.population)
    points = []
    for index in range(CIRCLE_SEGMENTS):
        angle = 2 * math.pi * index / CIRCLE_SEGMENTS
        lat, lon = offset(info.lat, info.lon, radius * math.cos(angle), radius * math.sin(angle))
        points.append((lon, lat))
    return Polygon(points)


def read_features(source: str) -> list[dict[str, Any]]:
    if source.startswith(("http://", "https://")):
        with urllib.request.urlopen(source, timeout=300) as response:
            data = json.load(response)
    else:
        data = json.loads(Path(source).read_text(encoding="utf-8"))
    return list(data["features"])


def faces(lines: Iterable[shapely.Geometry]) -> list[Polygon]:
    """Грани планарного разбиения: линии узлуются на сетке и собираются в многоугольники."""
    noded = shapely.union_all(list(lines), grid_size=GRID)
    return list(shapely.get_parts(shapely.polygonize(shapely.get_parts(noded))))


def dissolve(pieces: Sequence[Polygon], owner: Owner) -> dict[str, Geometry]:
    """Грани → единицы: грань отходит владельцу, грани одной единицы сливаются."""
    groups: dict[str, list[Polygon]] = {}
    for piece in pieces:
        code = owner(piece)
        if code is not None:
            groups.setdefault(code, []).append(piece)
    return {code: shapely.union_all(parts, grid_size=GRID) for code, parts in groups.items()}


def overlap_owner(units: dict[str, Geometry]) -> Callable[[Polygon], str | None]:
    """Владелец грани — единица, которая покрывает больше половины её площади."""
    codes = list(units)
    tree = shapely.STRtree([units[code] for code in codes])

    def owner(piece: Polygon) -> str | None:
        best, best_area = None, 0.0
        for index in tree.query(piece):
            area = piece.intersection(units[codes[index]]).area
            if area > best_area:
                best, best_area = codes[index], area
        return best if best_area > piece.area / 2 else None

    return owner


def as_multi(geometry: shapely.Geometry) -> MultiPolygon:
    polygons = [part for part in shapely.get_parts(geometry) if isinstance(part, Polygon)]
    return shapely.orient_polygons(MultiPolygon(polygons))


def build(
    adm1: list[dict[str, Any]], adm2: list[dict[str, Any]], tolerance: float = TOLERANCE
) -> dict[str, tuple[str, MultiPolygon]]:
    """Код района → (способ, граница) для всех районов справочника."""
    districts = {ADM2_CODES[f["properties"]["shapeName"]]: shape(f["geometry"]) for f in adm2}
    if len(districts) != len(ADM2_CODES):
        raise ValueError("в ADM2 не все районы из ADM2_CODES")
    capital = next(shape(f["geometry"]) for f in adm1 if f["properties"]["shapeISO"] == DUSHANBE)

    # 1. Районы ADM2 и граница Душанбе — одно покрытие: город вырезан из районов вокруг
    units: dict[str, Geometry] = {**districts, DUSHANBE: capital}
    capital_owner = overlap_owner({DUSHANBE: capital})
    district_owner = overlap_owner(districts)
    base = dissolve(
        faces(geometry.boundary for geometry in units.values()),
        lambda piece: capital_owner(piece) or district_owner(piece),
    )

    # 2. Упрощение покрытия: общие границы соседей упрощаются одинаково
    codes = sorted(base)
    simplified_parts = shapely.coverage_simplify([base[code] for code in codes], tolerance)
    simplified = dict(zip(codes, simplified_parts, strict=True))

    # 3. Районы Душанбе (ячейки Вороного) и города-круги внутри своего региона
    city_districts = [info for info in DISTRICTS if info.kind == CITY_DISTRICT]
    cities = [
        info
        for info in DISTRICTS
        if info.code not in simplified and info.kind == CITY and region_of(info.code) != DUSHANBE
    ]
    centers = MultiPoint([(info.lon, info.lat) for info in city_districts])
    cells = shapely.voronoi_polygons(centers, extend_to=simplified[DUSHANBE].envelope)
    cell_edges = shapely.union_all([cell.boundary for cell in shapely.get_parts(cells)])
    circles = {info.code: circle(info) for info in cities}
    lines: list[shapely.Geometry] = [geometry.boundary for geometry in simplified.values()]
    lines.append(shapely.intersection(cell_edges, simplified[DUSHANBE]))
    lines.extend(geometry.boundary for geometry in circles.values())
    base_owner = overlap_owner(simplified)

    def nearest(candidates: list[DistrictInfo], point: Point) -> str:
        return min(candidates, key=lambda info: Point(info.lon, info.lat).distance(point)).code

    def owner(piece: Polygon) -> str | None:
        host = base_owner(piece)
        if host is None:
            return None
        point = piece.point_on_surface()
        if host == DUSHANBE:
            return nearest(city_districts, point)
        inside = [
            info
            for info in cities
            if region_of(info.code) == region_of(host) and circles[info.code].contains(point)
        ]
        return nearest(inside, point) if inside else host

    final = dissolve(faces(lines), owner)
    missing = sorted({info.code for info in DISTRICTS} - set(final))
    if missing:
        raise ValueError(f"нет границ у районов: {missing}")
    methods = {info.code: VORONOI for info in city_districts} | dict.fromkeys(circles, CIRCLE)
    return {code: (methods.get(code, OSM), as_multi(final[code])) for code in sorted(final)}


def coordinates(geometry: MultiPolygon) -> list[list[list[list[float]]]]:
    return [
        [
            [[round(x, 4), round(y, 4)] for x, y in ring.coords]
            for ring in (polygon.exterior, *polygon.interiors)
        ]
        for polygon in geometry.geoms
    ]


def document(units: dict[str, tuple[str, MultiPolygon]]) -> dict[str, Any]:
    return {
        "source": SOURCE,
        "license": LICENSE,
        "attribution": ATTRIBUTION,
        "units": [
            {
                "code": code,
                "method": method,
                "geometry": {"type": "MultiPolygon", "coordinates": coordinates(geometry)},
            }
            for code, (method, geometry) in sorted(units.items())
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m kchs_engine.demo.boundaries",
        description="Границы районов справочника территорий для сида API (ADR-0067).",
    )
    parser.add_argument("--out", required=True, help="apps/api/src/seed/territory-boundaries.json")
    parser.add_argument("--adm1", default=SOURCE_URL.format(release=RELEASE, level="ADM1"))
    parser.add_argument("--adm2", default=SOURCE_URL.format(release=RELEASE, level="ADM2"))
    parser.add_argument("--tolerance", type=float, default=TOLERANCE)
    args = parser.parse_args(argv)
    units = build(read_features(args.adm1), read_features(args.adm2), args.tolerance)
    text = json.dumps(document(units), ensure_ascii=False, separators=(",", ":"))
    Path(args.out).write_text(text + "\n", encoding="utf-8")
    vertices = sum(shapely.get_num_coordinates(geometry) for _, geometry in units.values())
    print(f"{len(units)} районов, {vertices} вершин → {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
