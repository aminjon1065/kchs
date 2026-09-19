"""Системы координат и проверка геометрий через PROJ и GEOS (07-gis-engine.md §8, ADR-0068).

Геометрия датасета — EWKT в EPSG:4326 (`NORMALIZED_VALUE_FORMATS`). Координаты
в другой системе (UTM, Пулково 1942, Web Mercator) пересчитываются pyproj;
некорректная геометрия (самопересечение, петля кольца) исправляется
`make_valid` GEOS. Геометрия, которую не удалось пересчитать или исправить, и
координаты вне диапазона широты и долготы — ошибка строки `invalid_geometry`.

shapely и pyproj (необязательная группа `gis`) импортируются при первом
обращении: табличные форматы в EPSG:4326 работают и без них.
"""

import json
import math
import re
from collections import Counter
from collections.abc import Sequence
from functools import lru_cache
from typing import Any

from kchs_engine.data.geometry import (
    SRID,
    BadGeometry,
    GeometryError,
    ReadyGeometry,
    any_to_ewkt,
    geojson_to_ewkt,
    point_ewkt,
)
from kchs_engine.data.readers import ImportFileError

WGS84 = f"EPSG:{SRID}"
# Знаков после запятой в градусах: 1e-9° — десятая доля миллиметра
DEGREE_DIGITS = 9
# Длина текста исходной геометрии в файле ошибок
ERROR_WKT_CHARS = 500

_SRID_PREFIX = re.compile(r"\s*SRID\s*=\s*(\d+)\s*;", re.I)
_DIMENSION = re.compile(r"\s+(Z|M|ZM)$")


def _libraries() -> tuple[Any, Any, Any]:
    try:
        import numpy
        import pyproj
        import shapely
    except ImportError as error:  # pragma: no cover — образ движка ставит группу gis
        raise ImportFileError(
            "unsupported", "геоформаты недоступны: движок собран без библиотек GDAL и PROJ"
        ) from error
    return numpy, shapely, pyproj


# ─── Система координат ───────────────────────────────────────────────────────


@lru_cache(maxsize=64)
def parse_crs(text: str) -> Any:
    """Система координат по коду EPSG, WKT или PROJJSON; неизвестная — ошибка файла."""
    _numpy, _shapely, pyproj = _libraries()
    try:
        return pyproj.CRS.from_user_input(text)
    except pyproj.exceptions.CRSError as error:
        shown = text if len(text) <= 60 else text[:59] + "…"
        raise ImportFileError("unsupported", f"система координат {shown} не найдена") from error


def crs_code(crs: Any) -> str | None:
    """«EPSG:32642», если систему можно отождествить с кодом EPSG."""
    try:
        code = crs.to_epsg(min_confidence=70)
    except Exception:  # pyproj бросает разные ошибки на экзотических WKT
        return None
    return f"EPSG:{code}" if code else None


def is_wgs84(crs: Any) -> bool:
    if crs_code(crs) == WGS84:
        return True
    _numpy, _shapely, pyproj = _libraries()
    return bool(crs.equals(pyproj.CRS.from_epsg(SRID), ignore_axis_order=True))


def is_geographic(code: str | None) -> bool:
    """Координаты системы — градусы (WGS 84, Пулково 1942 без проекции)."""
    if code is None:
        return True
    return bool(parse_crs(code).is_geographic)


def crs_name(code: str) -> str | None:
    try:
        return str(parse_crs(code).name)
    except ImportFileError:
        return None


def geometry_type_name(name: str | None) -> str | None:
    """Тип геометрии без измерений Z и M (они отбрасываются при загрузке)."""
    if not name or name in ("Unknown", "None"):
        return None
    return _DIMENSION.sub("", name.replace("3D ", ""))


def within_degrees(bounds: Sequence[float]) -> bool:
    """Охват — широта и долгота: похоже на градусы WGS 84."""
    west, south, east, north = bounds
    values = (west, south, east, north)
    return all(math.isfinite(value) for value in values) and (
        -180 <= west <= 180 and -180 <= east <= 180 and -90 <= south <= 90 and -90 <= north <= 90
    )


# ─── Геометрии пачкой ────────────────────────────────────────────────────────


class GeometryPipeline:
    """Геометрии shapely пачкой → ячейки нормализованного файла.

    Z и M отбрасываются, координаты пересчитываются в EPSG:4326, некорректная
    геометрия исправляется. Ячейка — `ReadyGeometry` (EWKT), `BadGeometry`
    (причина и исходная геометрия для файла ошибок) или None (пустая).
    Счётчики и охват копятся — для анализа по выборке.
    """

    def __init__(self, source: Any | None) -> None:
        numpy, shapely, pyproj = _libraries()
        self._np = numpy
        self._shapely = shapely
        self.transformer = (
            None
            if source is None or is_wgs84(source)
            else pyproj.Transformer.from_crs(source, pyproj.CRS.from_epsg(SRID), always_xy=True)
        )
        self.fixed = 0
        self.invalid = 0
        self.types: Counter[str] = Counter()
        self._bounds = [math.inf, math.inf, -math.inf, -math.inf]

    @property
    def bbox(self) -> list[float] | None:
        if not math.isfinite(self._bounds[0]):
            return None
        return [round(value, 6) for value in self._bounds]

    def _project(self, coordinates: Any) -> Any:
        assert self.transformer is not None
        x, y = self.transformer.transform(coordinates[:, 0], coordinates[:, 1])
        return self._np.column_stack((x, y))

    def _source_text(self, geometry: Any) -> str | None:
        if geometry is None:
            return None
        try:
            text = str(self._shapely.to_wkt(geometry, rounding_precision=6, trim=True))
        except Exception:  # только для файла ошибок
            return None
        return text if len(text) <= ERROR_WKT_CHARS else text[: ERROR_WKT_CHARS - 1] + "…"

    def cells(self, geometries: Sequence[Any]) -> list[Any]:
        """Ячейки геометрии для пачки объектов shapely (None — нет геометрии)."""
        np, shapely = self._np, self._shapely
        source = np.asarray(geometries, dtype=object)
        cells: list[Any] = [None] * len(source)
        present = ~shapely.is_missing(source)
        present &= ~shapely.is_empty(source)
        indexes = np.flatnonzero(present)
        if indexes.size == 0:
            return cells
        work = shapely.force_2d(source[indexes])
        if self.transformer is not None:
            try:
                work = shapely.transform(work, self._project)
            except Exception:  # пересчёт пачкой не удался, по одной ниже
                work = np.array([self._transform_one(item) for item in work], dtype=object)
        failed: dict[int, str] = {}
        missing = shapely.is_missing(work)
        boxes = shapely.bounds(work)
        for position in range(len(work)):
            if missing[position]:
                failed[position] = "координаты не пересчитываются в WGS 84"
            elif not within_degrees(boxes[position]):
                failed[position] = (
                    "координаты вне диапазона широты и долготы — проверьте систему координат"
                )
        for position in np.flatnonzero(~shapely.is_valid(work)):
            if int(position) in failed:
                continue
            repaired = self._repair(work[position])
            if repaired is None:
                failed[int(position)] = "геометрия некорректна и не исправляется"
            else:
                work[position] = repaired
                self.fixed += 1
        good = [position for position in range(len(work)) if position not in failed]
        if good:
            texts = shapely.to_wkt(
                work[good], rounding_precision=DEGREE_DIGITS, trim=True, output_dimension=2
            )
            kinds = shapely.get_type_id(work[good])
            for position, text, kind, box in zip(
                good, texts, kinds, shapely.bounds(work[good]), strict=True
            ):
                cells[int(indexes[position])] = ReadyGeometry(f"SRID={SRID};{text}")
                self.types[_TYPE_NAMES.get(int(kind), "Geometry")] += 1
                self._bounds[0] = min(self._bounds[0], float(box[0]))
                self._bounds[1] = min(self._bounds[1], float(box[1]))
                self._bounds[2] = max(self._bounds[2], float(box[2]))
                self._bounds[3] = max(self._bounds[3], float(box[3]))
        for position, reason in failed.items():
            self.invalid += 1
            cells[int(indexes[position])] = BadGeometry(
                self._source_text(source[indexes[position]]), reason
            )
        return cells

    def _transform_one(self, geometry: Any) -> Any:
        try:
            return self._shapely.transform(geometry, self._project)
        except Exception:  # геометрию не пересчитать: ошибка строки
            return None

    def _repair(self, geometry: Any) -> Any:
        """Исправленная геометрия (самопересечения, петли колец) или None — не исправить."""
        shapely = self._shapely
        try:
            repaired = shapely.make_valid(geometry, method="structure", keep_collapsed=False)
        except Exception:  # GEOS не справился: ошибка строки
            return None
        if repaired is None or shapely.is_empty(repaired) or not shapely.is_valid(repaired):
            return None
        return repaired

    def one(self, geometry: Any) -> str:
        """Одна геометрия → EWKT; ошибка — GeometryError с причиной."""
        cell = self.cells([geometry])[0]
        if cell is None:
            raise GeometryError("геометрия пуста")
        if isinstance(cell, BadGeometry):
            raise GeometryError(cell.reason)
        return str(cell)

    def geometry_type(self) -> str | None:
        """Тип геометрии выборки: один на всех — его имя, разные — None."""
        if len(self.types) != 1:
            return None
        return next(iter(self.types))


_TYPE_NAMES = {
    0: "Point",
    1: "LineString",
    2: "LinearRing",
    3: "Polygon",
    4: "MultiPoint",
    5: "MultiLineString",
    6: "MultiPolygon",
    7: "GeometryCollection",
}


# ─── Значения ячеек ──────────────────────────────────────────────────────────


def _available() -> bool:
    try:
        _libraries()
    except ImportFileError:  # pragma: no cover — образ движка ставит группу gis
        return False
    return True


class GeometryReader:
    """Геометрия из ячеек (WKT/EWKT, GeoJSON, пара координат) → EWKT в EPSG:4326.

    В WGS 84 значения разбирает строгий разборщик `geometry.py` (диапазоны,
    замкнутые кольца), полигоны затем проверяет GEOS и исправляет при
    необходимости; в другой системе координат — shapely с пересчётом. EWKT с
    `SRID=` пересчитывается из своей системы.
    """

    def __init__(self, source: str | None = None) -> None:
        self.source = source if source and source != WGS84 else None
        self._pipelines: dict[str, GeometryPipeline] = {}
        self._validate = _available()
        # Полигонов в EPSG:4326, исправленных при чтении (у пересчитанных — в конвейере)
        self._fixed = 0

    @property
    def fixed(self) -> int:
        return self._fixed + sum(pipeline.fixed for pipeline in self._pipelines.values())

    def pipeline(self, crs: str) -> GeometryPipeline:
        found = self._pipelines.get(crs)
        if found is None:
            found = GeometryPipeline(parse_crs(crs))
            self._pipelines[crs] = found
        return found

    def value(self, raw: Any) -> str:
        """Ячейка геометрии → EWKT; не читается — GeometryError."""
        if isinstance(raw, ReadyGeometry):
            return str(raw)
        if isinstance(raw, dict):
            if self.source is None:
                return self._checked(geojson_to_ewkt(raw))
            return self._shapely_value(raw, self.source)
        text = str(raw).strip()
        prefix = _SRID_PREFIX.match(text)
        crs = f"EPSG:{int(prefix.group(1))}" if prefix else self.source
        if crs is None or crs == WGS84:
            return self._checked(any_to_ewkt(text))
        return self._shapely_value(text[prefix.end() :] if prefix else text, crs)

    def _checked(self, ewkt: str) -> str:
        """Полигон проверяется GEOS: некорректный исправляется, корректный остаётся как есть."""
        if not self._validate or "POLYGON" not in ewkt[:40]:
            return ewkt
        _numpy, shapely, _pyproj = _libraries()
        body = ewkt.split(";", 1)[1]
        geometry = shapely.from_wkt(body)
        if shapely.is_valid(geometry):
            return ewkt
        try:
            repaired = shapely.make_valid(geometry, method="structure", keep_collapsed=False)
        except shapely.errors.GEOSException as error:
            raise GeometryError("геометрия некорректна и не исправляется") from error
        if repaired is None or shapely.is_empty(repaired) or not shapely.is_valid(repaired):
            raise GeometryError("геометрия некорректна и не исправляется")
        self._fixed += 1
        text = shapely.to_wkt(repaired, rounding_precision=DEGREE_DIGITS, trim=True)
        return f"SRID={SRID};{text}"

    def _shapely_value(self, raw: Any, crs: str) -> str:
        _numpy, shapely, _pyproj = _libraries()
        pipeline = self.pipeline(crs)
        try:
            if isinstance(raw, dict):
                geometry = shapely.from_geojson(json.dumps(raw))
            elif raw.lstrip().startswith("{"):
                geometry = shapely.from_geojson(raw)
            else:
                geometry = shapely.from_wkt(raw)
        except (shapely.errors.GEOSException, ValueError, TypeError) as error:
            raise GeometryError("геометрия не читается") from error
        return pipeline.one(geometry)

    def point(self, lon: str, lat: str) -> str:
        """Точка из пары координат: x (долгота, восток) и y (широта, север)."""
        if self.source is None:
            return point_ewkt(lon, lat)
        _numpy, shapely, _pyproj = _libraries()
        return self.pipeline(self.source).one(shapely.Point(float(lon), float(lat)))


def geometry_summary(ewkts: Sequence[str]) -> tuple[str | None, list[float] | None]:
    """Тип геометрии (один на всех или None) и охват [запад, юг, восток, север] выборки."""
    if not ewkts or not _available():
        return None, None
    _numpy, shapely, _pyproj = _libraries()
    geometries = shapely.from_wkt([text.split(";", 1)[-1] for text in ewkts], on_invalid="ignore")
    kinds = {_TYPE_NAMES.get(int(kind), "Geometry") for kind in shapely.get_type_id(geometries)}
    kinds.discard("Geometry")
    west, south, east, north = shapely.total_bounds(geometries)
    bbox = [round(float(value), 6) for value in (west, south, east, north)]
    return (next(iter(kinds)) if len(kinds) == 1 else None), (
        bbox if within_degrees(bbox) else None
    )
