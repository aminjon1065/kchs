"""Геоформаты через GDAL (pyogrio): Shapefile в zip, GeoPackage, KML/KMZ, GPX (ADR-0068).

Слой читается потоком пачками Arrow. Строка — поля слоя в порядке схемы и
геометрия последней ячейкой (`geometry_index`, как у GeoJSON): EWKT в EPSG:4326,
пересчитанный из системы координат слоя (.prj, слой GeoPackage) или указанной
пользователем, с исправленной геометрией, — или `BadGeometry` с причиной.
Номер строки — номер объекта слоя с 1 (как номер объекта GeoJSON).

Кодировка атрибутов Shapefile: указанная пользователем, иначе `.cpg` или код
языка DBF (их понимает GDAL), иначе — по содержимому DBF; старые файлы без
этих сведений почти всегда в Windows-1251.
"""

import codecs
import os
import shutil
import struct
import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from kchs_engine.data.crs import (
    GeometryPipeline,
    crs_code,
    geometry_type_name,
    parse_crs,
    within_degrees,
)
from kchs_engine.data.readers import ImportFileError, Row, Source, detect_encoding

# Объектов в пачке Arrow
BATCH_SIZE = 2000
# Байт записей DBF для распознавания кодировки
DBF_SAMPLE_BYTES = 512 * 1024
# Служебные поля LIBKML: оформление метки, а не атрибуты объекта
KML_SERVICE_FIELDS = frozenset(
    {"altitudeMode", "tessellate", "extrude", "visibility", "drawOrder", "icon"}
)
# Порядок слоёв GPX по умолчанию: точки интереса, треки, маршруты, затем их точки
GPX_LAYER_ORDER = ("waypoints", "tracks", "routes", "track_points", "route_points")
# Код языка DBF (байт 29) → кодировка: кириллические страницы, которые GDAL понимает сам
_DBF_LANGUAGE = {0x26: "cp866", 0x65: "cp866", 0xC9: "cp1251"}
# «.cpg» пишут по-разному: «1251», «CP1251», «ANSI 1251», «UTF-8», «65001»
_CPG_ALIASES = {"65001": "utf-8", "utf8": "utf-8", "866": "cp866", "1251": "cp1251"}


def _libraries() -> Any:
    try:
        import pyogrio
    except ImportError as error:  # pragma: no cover — образ движка ставит группу gis
        raise ImportFileError(
            "unsupported", "геоформаты недоступны: движок собран без библиотек GDAL"
        ) from error
    return pyogrio


# ─── Архивы и пути GDAL ──────────────────────────────────────────────────────


def zip_members(path: Path) -> list[str]:
    """Файлы архива без каталогов и служебных папок macOS."""
    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
    except (zipfile.BadZipFile, OSError) as error:
        raise ImportFileError("unreadable", "архив zip повреждён") from error
    return [
        name
        for name in names
        if not name.endswith("/") and not name.startswith("__MACOSX/") and "/._" not in name
    ]


def zip_format(path: Path) -> str | None:
    """Что лежит в архиве: Shapefile, KMZ, GeoPackage, книга Excel — или None."""
    members = zip_members(path)
    suffixes = {PurePosixPath(name).suffix.lower() for name in members}
    if "[Content_Types].xml" in members or any(name.startswith("xl/") for name in members):
        return "xlsx"
    if ".shp" in suffixes:
        return "shp"
    if ".kml" in suffixes:
        return "kmz"
    if ".gpkg" in suffixes:
        return "gpkg"
    return None


def _vsizip(path: Path, member: str) -> str:
    """Путь GDAL к файлу в архиве: имя архива в фигурных скобках — без расширения .zip."""
    return f"/vsizip/{{{path}}}/{member}"


def _with_suffix(path: Path, suffix: str) -> Path:
    """Тот же файл с расширением: драйвер LIBKML узнаёт KML и KMZ по нему."""
    if path.suffix.lower() == suffix:
        return path
    alias = path.with_name(f"{path.name}{suffix}")
    if not alias.exists():
        try:
            os.link(path, alias)
        except OSError:
            shutil.copyfile(path, alias)
    return alias


# ─── Кодировка Shapefile ─────────────────────────────────────────────────────


def _codec(name: str) -> str | None:
    text = name.strip().lower().replace("ansi", "").strip()
    text = _CPG_ALIASES.get(text, text)
    try:
        return codecs.lookup(text).name
    except LookupError:
        return None


@dataclass(frozen=True)
class _Encoding:
    # Кодировка для pyogrio (None — GDAL определит сам по .cpg или коду языка DBF)
    read: str | None
    # Что показать пользователю
    shown: str
    warning: str | None = None


def _dbf_sample(data: bytes) -> tuple[int, bytes]:
    """Код языка DBF и начало записей (без заголовка с именами полей)."""
    if len(data) < 32:
        return 0, b""
    header = struct.unpack("<H", data[8:10])[0]
    return data[29], data[header : header + DBF_SAMPLE_BYTES]


def _shapefile_encoding(option: str | None, cpg: bytes | None, dbf_head: bytes) -> _Encoding:
    if option:
        codec = _codec(option)
        if codec is None:
            raise ImportFileError("unsupported", f"кодировка {option} не поддерживается")
        return _Encoding(codec, codec)
    if cpg is not None:
        codec = _codec(cpg.decode("ascii", errors="ignore"))
        if codec is not None:
            return _Encoding(None, codec)
    language, sample = _dbf_sample(dbf_head)
    if language in _DBF_LANGUAGE:
        return _Encoding(None, _DBF_LANGUAGE[language])
    if not any(byte >= 0x80 for byte in sample):
        return _Encoding("utf-8", "utf-8")
    detected = detect_encoding(sample)
    if detected in ("utf-8", "cp1251", "koi8_r", "cp866"):
        codec = codecs.lookup(detected).name
        return _Encoding(codec, codec)
    return _Encoding(
        "cp1251",
        "cp1251",
        "Кодировку атрибутов определить не удалось (нет файла .cpg) — принята Windows-1251, "
        "обычная для старых Shapefile; если текст выглядит неверно, выберите кодировку",
    )


# ─── Слои ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Layer:
    name: str
    # Путь GDAL к набору данных и имя слоя в нём (у Shapefile — единственный слой файла)
    dataset: str
    layer: str | None
    rows: int
    geometry_type: str | None
    # Файл .shp в архиве — для .cpg и .dbf рядом
    member: str | None = None


def _info(pyogrio: Any, dataset: str, layer: str | None, **options: Any) -> dict[str, Any]:
    try:
        info: dict[str, Any] = pyogrio.read_info(dataset, layer=layer, **options)
    except Exception as error:  # pyogrio бросает свои ошибки GDAL
        raise ImportFileError("unreadable", f"слой не читается: {error}") from error
    return info


def _layer_count(info: dict[str, Any]) -> int:
    features = int(info.get("features") or 0)
    return max(features, 0)


def _shapefile_layers(pyogrio: Any, path: Path) -> list[Layer]:
    names = zip_members(path)
    lowered = {name.lower() for name in names}
    members = [name for name in names if name.lower().endswith(".shp")]
    stems = [PurePosixPath(name).stem for name in members]
    layers = []
    for member, stem in zip(members, stems, strict=True):
        if str(PurePosixPath(member).with_suffix(".dbf")).lower() not in lowered:
            raise ImportFileError(
                "unreadable",
                f"в архиве нет файла атрибутов {stem}.dbf рядом с {PurePosixPath(member).name}",
            )
        name = stem if stems.count(stem) == 1 else str(PurePosixPath(member).with_suffix(""))
        dataset = _vsizip(path, member)
        info = _info(pyogrio, dataset, None, force_feature_count=True)
        layers.append(
            Layer(
                name,
                dataset,
                None,
                _layer_count(info),
                geometry_type_name(info.get("geometry_type")),
                member,
            )
        )
    return layers


def _dataset_layers(pyogrio: Any, dataset: str) -> list[Layer]:
    try:
        listed = pyogrio.list_layers(dataset)
    except Exception as error:
        raise ImportFileError("unreadable", f"файл не читается: {error}") from error
    layers = []
    for name, geometry_type in listed:
        info = _info(pyogrio, dataset, str(name), force_feature_count=True)
        layers.append(
            Layer(
                str(name),
                dataset,
                str(name),
                _layer_count(info),
                geometry_type_name(str(geometry_type)),
            )
        )
    return layers


def list_layers(path: Path, fmt: str) -> list[Layer]:
    """Слои файла геоформата в порядке файла (у GPX — точки, треки, маршруты)."""
    pyogrio = _libraries()
    if fmt == "shp":
        layers = _shapefile_layers(pyogrio, path)
    elif fmt == "gpkg":
        member = None
        if zipfile.is_zipfile(path):
            member = next(
                (name for name in zip_members(path) if name.lower().endswith(".gpkg")), None
            )
        dataset = _vsizip(path, member) if member else str(_with_suffix(path, ".gpkg"))
        layers = _dataset_layers(pyogrio, dataset)
    elif fmt in ("kml", "kmz"):
        layers = _dataset_layers(pyogrio, str(_with_suffix(path, f".{fmt}")))
    else:
        layers = _dataset_layers(pyogrio, str(path))
        if fmt == "gpx":
            order = {name: index for index, name in enumerate(GPX_LAYER_ORDER)}
            layers.sort(key=lambda layer: order.get(layer.name, len(order)))
    if not layers:
        raise ImportFileError("empty", "в файле нет слоёв с объектами")
    return layers


def choose_layer(layers: list[Layer], wanted: str | None) -> Layer:
    if wanted:
        for layer in layers:
            if layer.name == wanted:
                return layer
        raise ImportFileError("layer_not_found", f"в файле нет слоя «{wanted}»")
    return next((layer for layer in layers if layer.rows > 0), layers[0])


# ─── Источник строк ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CrsChoice:
    """Система координат слоя: код, название, откуда взята и определение pyproj."""

    code: str | None
    name: str | None
    source: str
    definition: Any


class VectorSource(Source):
    """Объекты слоя геоформата: поля слоя и геометрия последней ячейкой."""

    def __init__(
        self,
        fmt: str,
        path: Path,
        options: dict[str, Any],
        *,
        limit: int | None = None,
        layers: list[Layer] | None = None,
    ) -> None:
        pyogrio = _libraries()
        self.format = fmt
        self.path = path
        self.options = dict(options)
        self.limit = limit
        self.warnings: list[str] = []
        self.layers = layers if layers is not None else list_layers(path, fmt)
        self.layer = choose_layer(self.layers, options.get("layer"))
        if len(self.layers) > 1 and not options.get("layer"):
            others = ", ".join(f"«{layer.name}»" for layer in self.layers[:6])
            self.warnings.append(
                f"В файле несколько слоёв ({others}) — загружается «{self.layer.name}»; "
                "другой слой можно выбрать"
            )
        self.encoding = self._encoding()
        info = _info(
            pyogrio,
            self.layer.dataset,
            self.layer.layer,
            encoding=self.encoding.read,
            force_total_bounds=True,
        )
        if self.encoding.warning:
            self.warnings.append(self.encoding.warning)
        fields = [str(name) for name in info.get("fields", [])]
        kinds = [str(value) for value in info.get("ogr_types", [""] * len(fields))]
        # Двоичные поля (BLOB) — не значения таблицы
        self.columns = [
            name
            for name, kind in zip(fields, kinds, strict=True)
            if not (fmt in ("kml", "kmz") and name in KML_SERVICE_FIELDS) and kind != "OFTBinary"
        ]
        self.geometry_index = len(self.columns)
        self.crs = self._crs(info)
        self.pipeline = GeometryPipeline(
            self.crs.definition if self.crs.source != "unknown" else None
        )
        self.declared_type = geometry_type_name(info.get("geometry_type"))
        self._done = 0

    # ── Параметры чтения ─────────────────────────────────────────────────────

    def _encoding(self) -> _Encoding:
        option = self.options.get("encoding")
        if self.format != "shp" or self.layer.member is None:
            # GeoPackage, KML и GPX — всегда UTF-8 (стандарт форматов)
            return _Encoding(None, "utf-8")
        member = PurePosixPath(self.layer.member)
        with zipfile.ZipFile(self.path) as archive:
            names = {name.lower(): name for name in archive.namelist()}
            cpg_name = names.get(str(member.with_suffix(".cpg")).lower())
            dbf_name = names.get(str(member.with_suffix(".dbf")).lower())
            cpg = archive.read(cpg_name) if cpg_name else None
            dbf_head = b""
            if dbf_name:
                with archive.open(dbf_name) as stream:
                    dbf_head = stream.read(DBF_SAMPLE_BYTES + 65536)
        return _shapefile_encoding(option, cpg, dbf_head)

    def _crs(self, info: dict[str, Any]) -> CrsChoice:
        option = self.options.get("crs")
        if option:
            definition = parse_crs(option)
            return CrsChoice(option, definition.name, "option", definition)
        if self.format in ("kml", "kmz", "gpx"):
            # KML и GPX по стандарту — всегда WGS 84
            definition = parse_crs("EPSG:4326")
            return CrsChoice("EPSG:4326", definition.name, "default", definition)
        declared = info.get("crs")
        if declared:
            try:
                definition = parse_crs(str(declared))
            except ImportFileError:
                self.warnings.append(
                    "Систему координат из файла распознать не удалось — выберите её"
                )
                return CrsChoice(None, None, "unknown", None)
            return CrsChoice(crs_code(definition), definition.name, "file", definition)
        bounds = info.get("total_bounds")
        if bounds is not None and within_degrees(bounds):
            definition = parse_crs("EPSG:4326")
            self.warnings.append(
                "В файле нет системы координат (.prj): координаты похожи на градусы — "
                "принята WGS 84 (EPSG:4326); если это не так, выберите систему координат"
            )
            return CrsChoice("EPSG:4326", definition.name, "default", definition)
        self.warnings.append(
            "В файле нет системы координат (.prj), а координаты не в градусах — выберите "
            "систему координат, иначе геометрия не загрузится"
        )
        return CrsChoice(None, None, "unknown", None)

    # ── Строки ───────────────────────────────────────────────────────────────

    def rows(self) -> Iterator[Row]:
        pyogrio = _libraries()
        import shapely

        number = 0
        try:
            with pyogrio.open_arrow(
                self.layer.dataset,
                layer=self.layer.layer,
                encoding=self.encoding.read,
                columns=self.columns,
                max_features=self.limit,
                batch_size=BATCH_SIZE,
                datetime_as_string=True,
                use_pyarrow=True,
            ) as (meta, reader):
                geometry_name = _geometry_column(reader.schema, meta)
                for batch in reader:
                    values = [batch.column(name).to_pylist() for name in self.columns]
                    if geometry_name is not None:
                        wkb = batch.column(geometry_name).to_pylist()
                        geometries = shapely.from_wkb(wkb, on_invalid="ignore")
                        cells = self.pipeline.cells(list(geometries))
                    else:
                        cells = [None] * batch.num_rows
                    for index in range(batch.num_rows):
                        number += 1
                        self._done = number
                        yield number, [column[index] for column in values] + [cells[index]]
        except ImportFileError:
            raise
        except Exception as error:  # ошибки GDAL при чтении объектов
            raise ImportFileError("unreadable", f"объект {number + 1}: {error}") from error

    def progress(self) -> float:
        return min(self._done / max(self.layer.rows, 1), 1.0)

    def reopen(self) -> "VectorSource":
        """Весь слой потоком с теми же параметрами (нормализация)."""
        return VectorSource(self.format, self.path, self.options, layers=self.layers)


def _geometry_column(schema: Any, meta: dict[str, Any]) -> str | None:
    """Столбец WKB в пачке Arrow: по метаданным расширения geoarrow.wkb."""
    for field in schema:
        metadata = field.metadata or {}
        if metadata.get(b"ARROW:extension:name") == b"geoarrow.wkb":
            return str(field.name)
    name = meta.get("geometry_name") or "wkb_geometry"
    return str(name) if name in schema.names else None
