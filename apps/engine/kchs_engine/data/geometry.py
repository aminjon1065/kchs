"""Геометрия для нормализованного CSV: EWKT в SRID 4326 (ADR-0046).

Источники: пара широта/долгота, WKT (с `SRID=4326;` или без), GeoJSON-объект
геометрии. Координаты — долгота/широта WGS 84; столбец таблицы датасета
двумерный (`geometry(Geometry, 4326)`), поэтому Z и M отбрасываются.
Кольца полигонов должны быть замкнуты — иначе PostGIS отвергнет строку при
загрузке, и ошибка потеряла бы номер строки файла.
"""

import json
import re
from collections.abc import Sequence
from typing import Any

SRID = 4326


class GeometryError(ValueError):
    """Геометрия не распознана или некорректна; текст — причина по-русски."""


Coordinate = tuple[str, str]

_TOKEN = re.compile(r"\s*(?:([A-Za-z]+)|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)|([(),]))")
_TYPES = {
    "POINT",
    "LINESTRING",
    "POLYGON",
    "MULTIPOINT",
    "MULTILINESTRING",
    "MULTIPOLYGON",
    "GEOMETRYCOLLECTION",
}
_SRID_PREFIX = re.compile(r"\s*SRID\s*=\s*(\d+)\s*;", re.I)


def _number(text: str) -> str:
    """Координата канонически: без лишнего «+», с ведущим нулём."""
    value = float(text)
    if value != value or value in (float("inf"), float("-inf")):
        raise GeometryError("координата не число")
    if value.is_integer() and abs(value) < 1e15:
        return str(int(value))
    return repr(value)


def _check_lonlat(lon: str, lat: str) -> None:
    if not -180 <= float(lon) <= 180:
        raise GeometryError(f"долгота {lon} вне диапазона −180…180")
    if not -90 <= float(lat) <= 90:
        raise GeometryError(f"широта {lat} вне диапазона −90…90")


class _WktParser:
    def __init__(self, text: str) -> None:
        self.tokens: list[tuple[str, str]] = []
        position = 0
        while position < len(text):
            match = _TOKEN.match(text, position)
            if not match or match.end() == position:
                if text[position:].strip() == "":
                    break
                raise GeometryError(f"непонятный символ в WKT: «{text[position : position + 10]}»")
            word, number, punct = match.groups()
            if word:
                self.tokens.append(("word", word.upper()))
            elif number:
                self.tokens.append(("number", number))
            elif punct:
                self.tokens.append((punct, punct))
            position = match.end()
        self.index = 0

    def peek(self) -> tuple[str, str] | None:
        return self.tokens[self.index] if self.index < len(self.tokens) else None

    def take(self, kind: str) -> str:
        token = self.peek()
        if token is None or token[0] != kind:
            expected = {"(": "«(»", ")": "«)»", ",": "«,»", "number": "число", "word": "тип"}
            raise GeometryError(f"в WKT ожидается {expected.get(kind, kind)}")
        self.index += 1
        return token[1]

    def optional(self, kind: str) -> bool:
        token = self.peek()
        if token is not None and token[0] == kind:
            self.index += 1
            return True
        return False

    def geometry(self) -> str:
        kind = self.take("word")
        if kind not in _TYPES:
            raise GeometryError(f"неизвестный тип геометрии {kind}")
        token = self.peek()
        if token and token[0] == "word" and token[1] in ("Z", "M", "ZM"):
            self.index += 1
        token = self.peek()
        if token and token == ("word", "EMPTY"):
            self.index += 1
            return f"{kind} EMPTY"
        return kind + self.body(kind)

    def coordinate(self) -> Coordinate:
        x = self.take("number")
        y = self.take("number")
        # Третья и четвёртая координаты (Z, M) — отбрасываются
        token = self.peek()
        while token is not None and token[0] == "number":
            self.index += 1
            token = self.peek()
        lon, lat = _number(x), _number(y)
        _check_lonlat(lon, lat)
        return lon, lat

    def coordinates(self, minimum: int) -> list[Coordinate]:
        self.take("(")
        points = [self.coordinate()]
        while self.optional(","):
            points.append(self.coordinate())
        self.take(")")
        if len(points) < minimum:
            raise GeometryError(f"в линии нужно не меньше {minimum} точек")
        return points

    def ring(self) -> list[Coordinate]:
        points = self.coordinates(4)
        if points[0] != points[-1]:
            raise GeometryError("кольцо полигона не замкнуто")
        return points

    def body(self, kind: str) -> str:
        if kind == "POINT":
            self.take("(")
            point = self.coordinate()
            self.take(")")
            return f"({point[0]} {point[1]})"
        if kind == "LINESTRING":
            return _line(self.coordinates(2))
        if kind == "POLYGON":
            return self.polygon()
        if kind == "MULTIPOINT":
            self.take("(")
            points = [self.multipoint_member()]
            while self.optional(","):
                points.append(self.multipoint_member())
            self.take(")")
            return "(" + ",".join(f"({x} {y})" for x, y in points) + ")"
        if kind == "MULTILINESTRING":
            self.take("(")
            lines = [_line(self.coordinates(2))]
            while self.optional(","):
                lines.append(_line(self.coordinates(2)))
            self.take(")")
            return "(" + ",".join(lines) + ")"
        if kind == "MULTIPOLYGON":
            self.take("(")
            polygons = [self.polygon()]
            while self.optional(","):
                polygons.append(self.polygon())
            self.take(")")
            return "(" + ",".join(polygons) + ")"
        # GEOMETRYCOLLECTION
        self.take("(")
        members = [self.geometry()]
        while self.optional(","):
            members.append(self.geometry())
        self.take(")")
        return "(" + ",".join(members) + ")"

    def multipoint_member(self) -> Coordinate:
        # MULTIPOINT((1 2),(3 4)) и MULTIPOINT(1 2, 3 4) — обе записи допустимы
        if self.optional("("):
            point = self.coordinate()
            self.take(")")
            return point
        return self.coordinate()

    def polygon(self) -> str:
        self.take("(")
        rings = [self.ring()]
        while self.optional(","):
            rings.append(self.ring())
        self.take(")")
        return "(" + ",".join(_line(ring) for ring in rings) + ")"


def _line(points: Sequence[Coordinate]) -> str:
    return "(" + ",".join(f"{x} {y}" for x, y in points) + ")"


def wkt_to_ewkt(text: str) -> str:
    """WKT/EWKT → канонический EWKT `SRID=4326;…`. Другая система координат — ошибка."""
    source = text.strip()
    prefix = _SRID_PREFIX.match(source)
    if prefix:
        srid = int(prefix.group(1))
        if srid != SRID:
            raise GeometryError(
                f"система координат EPSG:{srid} не поддерживается — нужна EPSG:4326 (WGS 84)"
            )
        source = source[prefix.end() :]
    parser = _WktParser(source)
    geometry = parser.geometry()
    if parser.peek() is not None:
        raise GeometryError("лишние символы после геометрии")
    return f"SRID={SRID};{geometry}"


# ─── GeoJSON ─────────────────────────────────────────────────────────────────


def _position(value: Any) -> Coordinate:
    if not isinstance(value, list | tuple) or len(value) < 2:
        raise GeometryError("координата GeoJSON — массив [долгота, широта]")
    x, y = value[0], value[1]
    if isinstance(x, bool) or isinstance(y, bool):
        raise GeometryError("координата не число")
    if not isinstance(x, int | float) or not isinstance(y, int | float):
        raise GeometryError("координата не число")
    lon, lat = _number(str(x)), _number(str(y))
    _check_lonlat(lon, lat)
    return lon, lat


def _positions(value: Any, minimum: int) -> list[Coordinate]:
    if not isinstance(value, list):
        raise GeometryError("координаты GeoJSON — массив")
    points = [_position(item) for item in value]
    if len(points) < minimum:
        raise GeometryError(f"в линии нужно не меньше {minimum} точек")
    return points


def _rings(value: Any) -> str:
    if not isinstance(value, list) or not value:
        raise GeometryError("полигон GeoJSON — массив колец")
    rings = []
    for ring in value:
        points = _positions(ring, 4)
        if points[0] != points[-1]:
            raise GeometryError("кольцо полигона не замкнуто")
        rings.append(_line(points))
    return "(" + ",".join(rings) + ")"


def geojson_to_wkt(value: Any) -> str:
    if not isinstance(value, dict):
        raise GeometryError("геометрия GeoJSON — объект")
    kind = value.get("type")
    coordinates = value.get("coordinates")
    if kind == "Point":
        x, y = _position(coordinates)
        return f"POINT({x} {y})"
    if kind == "MultiPoint":
        points = _positions(coordinates, 1)
        return "MULTIPOINT(" + ",".join(f"({x} {y})" for x, y in points) + ")"
    if kind == "LineString":
        return "LINESTRING" + _line(_positions(coordinates, 2))
    if kind == "MultiLineString":
        if not isinstance(coordinates, list) or not coordinates:
            raise GeometryError("мультилиния GeoJSON — массив линий")
        return (
            "MULTILINESTRING(" + ",".join(_line(_positions(line, 2)) for line in coordinates) + ")"
        )
    if kind == "Polygon":
        return "POLYGON" + _rings(coordinates)
    if kind == "MultiPolygon":
        if not isinstance(coordinates, list) or not coordinates:
            raise GeometryError("мультиполигон GeoJSON — массив полигонов")
        return "MULTIPOLYGON(" + ",".join(_rings(polygon) for polygon in coordinates) + ")"
    if kind == "GeometryCollection":
        members = value.get("geometries")
        if not isinstance(members, list) or not members:
            raise GeometryError("коллекция геометрий пуста")
        return "GEOMETRYCOLLECTION(" + ",".join(geojson_to_wkt(item) for item in members) + ")"
    raise GeometryError(f"неизвестный тип геометрии GeoJSON: {kind}")


def geojson_to_ewkt(value: Any) -> str:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError as error:
            raise GeometryError("геометрия не читается как JSON") from error
    return f"SRID={SRID};{geojson_to_wkt(value)}"


def point_ewkt(lon: str, lat: str) -> str:
    """Точка из долготы и широты (канонические числовые записи)."""
    x, y = _number(lon), _number(lat)
    _check_lonlat(x, y)
    return f"SRID={SRID};POINT({x} {y})"


GEOJSON_GEOMETRY_TYPES = frozenset(
    {
        "Point",
        "MultiPoint",
        "LineString",
        "MultiLineString",
        "Polygon",
        "MultiPolygon",
        "GeometryCollection",
    }
)

_WKT_START = re.compile(
    r"\s*(?:SRID\s*=\s*\d+\s*;)?\s*(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|"
    r"MULTIPOLYGON|GEOMETRYCOLLECTION)\b",
    re.I,
)


def looks_like_wkt(text: str) -> bool:
    return bool(_WKT_START.match(text))


def looks_like_geojson_geometry(text: str) -> bool:
    stripped = text.lstrip()
    if not stripped.startswith("{"):
        return False
    if '"coordinates"' not in stripped and '"geometries"' not in stripped:
        return False
    try:
        value = json.loads(stripped)
    except ValueError:
        return False
    return isinstance(value, dict) and value.get("type") in GEOJSON_GEOMETRY_TYPES


def any_to_ewkt(value: Any) -> str:
    """Ячейка столбца-геометрии: WKT/EWKT-текст или GeoJSON (объект или текст)."""
    if isinstance(value, dict):
        return geojson_to_ewkt(value)
    text = str(value).strip()
    if text.startswith("{"):
        return geojson_to_ewkt(text)
    return wkt_to_ewkt(text)
