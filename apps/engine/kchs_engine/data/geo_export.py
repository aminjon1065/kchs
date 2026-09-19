"""Геоэкспорт датасета: GeoJSONSeq воркера → GeoPackage, Shapefile (zip), KML (ADR-0068).

Строки с политиками запросившего выгружает задание экспорта TypeScript-воркера
(ADR-0056) — объекты GeoJSON построчно (RFC 8142), свойства по ключам полей.
Движок только меняет формат: читает файл пачками, строит столбцы Arrow по
типам полей схемы и пишет их GDAL потоком (pyogrio `write_arrow`).

Shapefile хранит один тип геометрии на файл и имена полей до 10 символов:
точки, линии и полигоны раскладываются по отдельным файлам архива, коллекции
геометрий — по частям, имена полей укорачиваются, а соответствие имени DBF
ключу и подписи поля записывается в `fields.csv` архива.
"""

import csv
import io
import json
import re
import zipfile
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from kchs_engine.data.readers import ImportFileError

BATCH_SIZE = 5000
# Имя поля DBF — не длиннее 10 байт ASCII
DBF_NAME_LENGTH = 10
_INTEGER = frozenset({"integer"})
_REAL = frozenset({"number", "decimal", "money", "percent"})
_TEXTUAL = ("text", "identifier", "select", "long_text")
# Семейства геометрий Shapefile: тип файла и суффикс имени
_FAMILIES = {
    "points": ("Point", "MultiPoint"),
    "lines": ("LineString", "MultiLineString"),
    "polygons": ("Polygon", "MultiPolygon"),
}
_TRANSLIT = str.maketrans(
    {
        "а": "a", "б": "b", "в": "v", "г": "g", "ғ": "gh", "д": "d", "е": "e", "ё": "yo",
        "ж": "zh", "з": "z", "и": "i", "ӣ": "i", "й": "y", "к": "k", "қ": "q", "л": "l",
        "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
        "ӯ": "u", "ф": "f", "х": "kh", "ҳ": "h", "ц": "ts", "ч": "ch", "ҷ": "j", "ш": "sh",
        "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    }
)  # fmt: skip


@dataclass(frozen=True)
class ExportField:
    """Поле выгрузки: ключ (свойство GeoJSON), подпись и тип поля датасета."""

    name: str
    label: str
    type: str


def _libraries() -> tuple[Any, Any, Any]:
    try:
        import pyarrow
        import pyogrio
        import shapely
    except ImportError as error:  # pragma: no cover — образ движка ставит группы data и gis
        raise ImportFileError(
            "unsupported", "геоэкспорт недоступен: движок собран без GDAL и Arrow"
        ) from error
    return pyarrow, pyogrio, shapely


def ascii_name(text: str, fallback: str = "layer") -> str:
    """Латинское имя файла из названия датасета: транслитерация и подчёркивания."""
    latin = text.lower().translate(_TRANSLIT)
    clean = re.sub(r"[^a-z0-9]+", "_", latin).strip("_")
    return clean[:48] or fallback


def dbf_names(names: Sequence[str]) -> list[str]:
    """Имена полей DBF: ASCII до 10 символов, без повторов (code, code_1…)."""
    result: list[str] = []
    used: set[str] = set()
    for name in names:
        base = re.sub(r"[^A-Za-z0-9_]", "_", name)[:DBF_NAME_LENGTH] or "field"
        candidate, number = base, 1
        while candidate.lower() in used:
            suffix = f"_{number}"
            candidate = base[: DBF_NAME_LENGTH - len(suffix)] + suffix
            number += 1
        used.add(candidate.lower())
        result.append(candidate)
    return result


# ─── Чтение выгрузки ─────────────────────────────────────────────────────────


def _features(path: Path) -> Iterator[list[tuple[Any, dict[str, Any]]]]:
    """Объекты GeoJSONSeq пачками: (геометрия GeoJSON или None, свойства)."""
    batch: list[tuple[Any, dict[str, Any]]] = []
    with path.open("r", encoding="utf-8") as stream:
        for number, line in enumerate(stream, start=1):
            text = line.strip().lstrip("\x1e")
            if not text:
                continue
            try:
                feature = json.loads(text)
            except ValueError as error:
                raise ImportFileError(
                    "unreadable", f"строка выгрузки {number} — не JSON"
                ) from error
            properties = feature.get("properties") if isinstance(feature, dict) else None
            geometry = feature.get("geometry") if isinstance(feature, dict) else None
            batch.append((geometry, properties if isinstance(properties, dict) else {}))
            if len(batch) >= BATCH_SIZE:
                yield batch
                batch = []
    if batch:
        yield batch


def _text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, list) and all(not isinstance(item, dict | list) for item in value):
        return ", ".join("" if item is None else str(item) for item in value)
    if isinstance(value, dict | list):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _integer(value: Any) -> int | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number) if number.is_integer() and abs(number) < 2**63 else None


def _real(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _date(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


class _Columns:
    """Типы Arrow по типам полей датасета и приведение значений."""

    def __init__(self, fields: Sequence[ExportField], names: Sequence[str]) -> None:
        pyarrow, _pyogrio, _shapely = _libraries()
        self.pa = pyarrow
        self.fields = list(fields)
        converters: list[Any] = []
        schema = []
        for field, name in zip(self.fields, names, strict=True):
            if field.type in _INTEGER:
                arrow, convert = pyarrow.int64(), _integer
            elif field.type in _REAL:
                arrow, convert = pyarrow.float64(), _real
            elif field.type == "boolean":
                arrow, convert = pyarrow.bool_(), _boolean
            elif field.type == "date":
                arrow, convert = pyarrow.date32(), _date
            elif field.type == "datetime":
                arrow, convert = pyarrow.timestamp("ms", tz="UTC"), _datetime
            else:
                arrow, convert = pyarrow.string(), _text
            schema.append(pyarrow.field(name, arrow))
            converters.append(convert)
        # Столбец геометрии: «geom», если так не называется поле
        taken = {name.lower() for name in names}
        self.geometry = "geom"
        while self.geometry in taken:
            self.geometry += "_"
        schema.append(
            pyarrow.field(
                self.geometry,
                pyarrow.binary(),
                metadata={b"ARROW:extension:name": b"geoarrow.wkb"},
            )
        )
        self.schema = pyarrow.schema(schema)
        self.converters = converters

    def batch(self, rows: Sequence[dict[str, Any]], wkb: Sequence[bytes | None]) -> Any:
        arrays = [
            self.pa.array(
                [convert(row.get(field.name)) for row in rows], type=self.schema.field(index).type
            )
            for index, (field, convert) in enumerate(zip(self.fields, self.converters, strict=True))
        ]
        arrays.append(self.pa.array(list(wkb), type=self.pa.binary()))
        return self.pa.record_batch(arrays, schema=self.schema)


def _boolean(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _geometries(shapely: Any, batch: list[tuple[Any, dict[str, Any]]]) -> list[Any]:
    texts = [None if geometry is None else json.dumps(geometry) for geometry, _ in batch]
    return list(shapely.from_geojson(texts, on_invalid="ignore"))


# ─── Запись ──────────────────────────────────────────────────────────────────


def _write(
    target: Path,
    driver: str,
    layer: str,
    columns: _Columns,
    batches: Iterator[Any],
    geometry_type: str,
    **options: Any,
) -> None:
    pyarrow, pyogrio, _shapely = _libraries()
    reader = pyarrow.RecordBatchReader.from_batches(columns.schema, batches)
    pyogrio.raw.write_arrow(
        reader,
        str(target),
        layer=layer,
        driver=driver,
        geometry_name=columns.geometry,
        geometry_type=geometry_type,
        crs="EPSG:4326",
        **options,
    )


def _single_layer(
    source: Path, target: Path, fmt: str, layer: str, fields: Sequence[ExportField]
) -> int:
    """GeoPackage и KML: один слой, типы геометрии вперемешку."""
    _pyarrow, _pyogrio, shapely = _libraries()
    columns = _Columns(fields, [field.name for field in fields])
    count = 0

    def batches() -> Iterator[Any]:
        nonlocal count
        for batch in _features(source):
            geometries = _geometries(shapely, batch)
            wkb = [None if item is None else shapely.to_wkb(item) for item in geometries]
            count += len(batch)
            yield columns.batch([properties for _geometry, properties in batch], wkb)

    if fmt == "gpkg":
        _write(target, "GPKG", layer, columns, batches(), "Unknown")
    else:
        name_field = next((field.name for field in fields if field.type in _TEXTUAL), None)
        _write(
            target,
            "KML",
            layer,
            columns,
            batches(),
            "Unknown",
            dataset_options={"NameField": name_field} if name_field else None,
        )
    return count


def _family(shapely: Any, geometry: Any) -> dict[str, Any]:
    """Части геометрии по семействам Shapefile (коллекция делится на части)."""
    if geometry is None or shapely.is_empty(geometry):
        return {}
    kind = geometry.geom_type
    if kind in ("Point", "MultiPoint"):
        return {"points": geometry}
    if kind in ("LineString", "MultiLineString", "LinearRing"):
        return {"lines": geometry}
    if kind in ("Polygon", "MultiPolygon"):
        return {"polygons": geometry}
    parts: dict[str, list[Any]] = {}
    for part in shapely.get_parts(geometry):
        for family, item in _family(shapely, part).items():
            parts.setdefault(family, []).extend(shapely.get_parts(item))
    builders = {
        "points": shapely.multipoints,
        "lines": shapely.multilinestrings,
        "polygons": shapely.multipolygons,
    }
    return {family: builders[family](items) for family, items in parts.items()}


def _shapefile(source: Path, target: Path, layer: str, fields: Sequence[ExportField]) -> int:
    """Shapefile в zip: по файлу на семейство геометрий, fields.csv с подписями полей."""
    _pyarrow, _pyogrio, shapely = _libraries()
    names = dbf_names([field.name for field in fields])
    columns = _Columns(fields, names)
    base = ascii_name(layer)

    # Первый проход: какие семейства есть и нужен ли MultiPoint
    present: dict[str, bool] = {}
    count = 0
    for batch in _features(source):
        count += len(batch)
        for geometry in _geometries(shapely, batch):
            for family, item in _family(shapely, geometry).items():
                multi = present.get(family, False) or item.geom_type == "MultiPoint"
                present[family] = multi
    families = [family for family in _FAMILIES if family in present] or ["points"]
    # Строки без геометрии — в первый файл (null shape допустим в любом типе)
    carrier = families[0]

    folder = target.parent / f"{target.stem}-shp"
    folder.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for family in families:
        single, multi = _FAMILIES[family]
        promote = family == "points" and present.get(family, False)

        def batches(family: str = family, promote: bool = promote) -> Iterator[Any]:
            for batch in _features(source):
                rows: list[dict[str, Any]] = []
                wkb: list[bytes | None] = []
                for geometry, (_raw, properties) in zip(
                    _geometries(shapely, batch), batch, strict=True
                ):
                    item = _family(shapely, geometry).get(family)
                    if item is None:
                        if geometry is not None or family != carrier:
                            continue
                        rows.append(properties)
                        wkb.append(None)
                        continue
                    if promote and item.geom_type == "Point":
                        item = shapely.multipoints([item])
                    rows.append(properties)
                    wkb.append(shapely.to_wkb(item))
                if rows:
                    yield columns.batch(rows, wkb)

        name = base if len(families) == 1 else f"{base}_{family}"
        path = folder / f"{name}.shp"
        _write(
            path,
            "ESRI Shapefile",
            name,
            columns,
            batches(),
            multi if promote or family != "points" else single,
            layer_options={"ENCODING": "UTF-8"},
        )
        written.extend(sorted(folder.glob(f"{name}.*")))

    legend = io.StringIO()
    writer = csv.writer(legend, lineterminator="\r\n")
    writer.writerow(["dbf", "key", "label"])
    for name, field in zip(names, fields, strict=True):
        writer.writerow([name, field.name, field.label])
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in written:
            archive.write(path, path.name)
        archive.writestr("fields.csv", "\ufeff" + legend.getvalue())
    return count


def convert_features(
    source: Path, target: Path, fmt: str, layer: str, fields: Sequence[ExportField]
) -> int:
    """Выгрузка GeoJSONSeq → файл формата `fmt` (gpkg, shp, kml); число объектов."""
    if fmt == "shp":
        return _shapefile(source, target, layer, fields)
    if fmt in ("gpkg", "kml"):
        return _single_layer(source, target, fmt, layer, fields)
    raise ImportFileError("unsupported", f"формат геоэкспорта {fmt} не поддерживается")
