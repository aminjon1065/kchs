"""Импорт геоформатов через GDAL (P2-E03 S04, ADR-0068).

Файлы строятся в тесте pyogrio: Shapefile в Windows-1251 и EPSG:32642 без .cpg
(сценарий приёмки фазы 2 №1), GeoPackage с двумя слоями, KML/KMZ, GPX, CSV с
координатами в метрах, GeoJSON с объявленной системой координат.
"""

import json
import re
import zipfile
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import shapely
from import_helpers import analyze, column, mapping_from, normalize
from pyogrio import raw

from kchs_engine.contracts import data_import_contract
from kchs_engine.data.readers import FEATURE_FORMATS, ImportFileError

# Пункты временного размещения под Душанбе в UTM 42N (метры) и их координаты в градусах
PVR_UTM = [(340000.0, 4270000.0), (341000.0, 4271000.0), (342500.0, 4269000.0)]
# В Windows-1251 нет таджикских букв (Ҳ, Ӣ, Ҷ): старые файлы пишут без них
PVR_NAMES = ["ПВР «Школа № 5»", "ПВР Ёлки — Гиссар", "Пункт обогрева"]
PVR_DISTRICTS = ["Гиссар", "Рудаки", "Вахдат"]
POINT = re.compile(r"SRID=4326;POINT \(([-\d.]+) ([-\d.]+)\)")


def _shapefile(
    folder: Path,
    name: str,
    geometries: list[Any],
    fields: dict[str, list[Any]],
    *,
    crs: str | None,
    encoding: str = "cp1251",
    cpg: bool = False,
    geometry_type: str = "Point",
) -> dict[str, bytes]:
    """Файлы слоя Shapefile: как у старых программ — без .cpg и без кода языка DBF."""
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{name}.shp"
    values = [
        np.array(items, dtype=object if isinstance(items[0], str) else None)
        for items in fields.values()
    ]
    raw.write(
        str(target),
        shapely.to_wkb(np.array(geometries, dtype=object), output_dimension=2),
        values,
        list(fields),
        geometry_type=geometry_type,
        crs=crs,
        driver="ESRI Shapefile",
        encoding=encoding,
    )
    files = {
        path.suffix.lower(): path.read_bytes()
        for path in folder.glob(f"{name}.*")
        if path.suffix.lower() in (".shp", ".shx", ".dbf", ".prj", ".cpg")
    }
    dbf = bytearray(files[".dbf"])
    dbf[29] = 0
    files[".dbf"] = bytes(dbf)
    if not cpg:
        files.pop(".cpg", None)
    return files


def _zip(path: Path, members: dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return path


def _pvr_zip(tmp_path: Path, *, prj: bool = True, cpg: bool = False) -> Path:
    files = _shapefile(
        tmp_path / "build",
        "pvr",
        [shapely.Point(x, y) for x, y in PVR_UTM],
        {
            "name": PVR_NAMES,
            "capacity": [120, 80, 45],
            "district": PVR_DISTRICTS,
        },
        crs="EPSG:32642",
        cpg=cpg,
    )
    if not prj:
        files.pop(".prj")
    # Файлы слоя — в папке архива, как их упаковывает проводник Windows
    return _zip(tmp_path / "pvr.zip", {f"ПВР/pvr{suffix}": data for suffix, data in files.items()})


def _points(rows: list[list[str | None]]) -> list[tuple[float, float]]:
    result = []
    for row in rows:
        match = POINT.fullmatch(row[-1] or "")
        assert match, row[-1]
        result.append((float(match.group(1)), float(match.group(2))))
    return result


def test_контракт_знает_форматы_слоёв() -> None:
    contract = data_import_contract()
    assert set(contract["layerFormats"]) == FEATURE_FORMATS
    assert set(contract["formats"]) >= FEATURE_FORMATS


# ─── Shapefile ───────────────────────────────────────────────────────────────


def test_shapefile_cp1251_utm42_без_cpg(tmp_path: Path) -> None:
    source = _pvr_zip(tmp_path)
    analysis = analyze(source)
    assert analysis["format"] == "shp"
    # Кодировку без .cpg определяет содержимое DBF
    assert analysis["encoding"] == "cp1251"
    assert not any("Windows-1251" in warning for warning in analysis["warnings"])
    assert analysis["geometry"] == {"kind": "features"}
    assert (analysis["rowEstimate"], analysis["approx"]) == (3, False)
    assert [item["name"] for item in analysis["columns"]] == ["name", "capacity", "district"]
    assert column(analysis, "capacity")["type"] == "integer"
    assert [row[0] for row in analysis["preview"]] == PVR_NAMES
    geo = analysis["geo"]
    assert geo["crs"] == "EPSG:32642"
    assert geo["crsSource"] == "file"
    assert "UTM zone 42N" in geo["crsName"]
    assert geo["geometryType"] == "Point"
    assert geo["layers"] == [{"name": "pvr", "rows": 3, "geometryType": "Point"}]
    assert geo["layer"] == "pvr"
    assert (geo["fixed"], geo["invalid"]) == (0, 0)
    west, south, east, north = geo["bbox"]
    assert 67.1 < west < east < 67.3 and 38.5 < south < north < 38.6

    options = {"format": "shp", "encoding": analysis["encoding"]}
    done = normalize(
        source,
        mapping_from(analysis),
        options=options,
        geometry={"kind": "features"},
        geometry_field="geom",
    )
    assert done.errors == []
    assert [row[:4] for row in done.rows] == [
        ["1", PVR_NAMES[0], "120", PVR_DISTRICTS[0]],
        ["2", PVR_NAMES[1], "80", PVR_DISTRICTS[1]],
        ["3", PVR_NAMES[2], "45", PVR_DISTRICTS[2]],
    ]
    lon, lat = _points(done.rows)[0]
    assert lon == pytest.approx(67.163536, abs=1e-6)
    assert lat == pytest.approx(38.564056, abs=1e-6)


def test_shapefile_без_cpg_с_короткими_надписями_читается_как_windows_1251(
    tmp_path: Path,
) -> None:
    # Двух букв мало, чтобы узнать кодировку по частоте, — принята обычная для старых файлов
    files = _shapefile(
        tmp_path / "build", "short", [shapely.Point(68.78, 38.56)], {"a": ["Ёж"]}, crs="EPSG:4326"
    )
    source = _zip(tmp_path / "short.zip", {f"short{k}": v for k, v in files.items()})
    analysis = analyze(source)
    assert analysis["encoding"] == "cp1251"
    assert any("принята Windows-1251" in warning for warning in analysis["warnings"])
    assert analysis["preview"][0][0] == "Ёж"


def test_shapefile_с_cpg_и_кодировка_вручную(tmp_path: Path) -> None:
    source = _pvr_zip(tmp_path, cpg=True)
    analysis = analyze(source)
    assert analysis["encoding"] == "cp1251"
    assert not any("Windows-1251" in warning for warning in analysis["warnings"])
    assert analysis["preview"][1][0] == PVR_NAMES[1]
    # Пользователь выбрал кодировку сам — она важнее .cpg
    forced = analyze(source, {"encoding": "koi8-r"})
    assert forced["encoding"] == "koi8-r"
    assert forced["preview"][0][0] != PVR_NAMES[0]
    with pytest.raises(ImportFileError) as error:
        analyze(source, {"encoding": "klingon"})
    assert error.value.code == "unsupported"


def test_shapefile_без_prj(tmp_path: Path) -> None:
    # Метры без системы координат — выбрать систему; с выбранной — пересчёт
    source = _pvr_zip(tmp_path, prj=False)
    analysis = analyze(source)
    assert analysis["geo"]["crsSource"] == "unknown"
    assert analysis["geo"]["crs"] is None
    assert analysis["geo"]["invalid"] == 3
    assert any("выберите систему координат" in warning for warning in analysis["warnings"])
    blind = normalize(
        source, mapping_from(analysis), geometry={"kind": "features"}, geometry_field="geom"
    )
    assert [(item["row"], item["code"]) for item in blind.errors] == [
        ("1", "invalid_geometry"),
        ("2", "invalid_geometry"),
        ("3", "invalid_geometry"),
    ]
    assert blind.errors[0]["value"].startswith("POINT (340000 4270000")

    chosen = analyze(source, {"crs": "EPSG:32642"})
    assert (chosen["geo"]["crs"], chosen["geo"]["crsSource"]) == ("EPSG:32642", "option")
    done = normalize(
        source,
        mapping_from(chosen),
        options={"crs": "EPSG:32642"},
        geometry={"kind": "features"},
        geometry_field="geom",
    )
    assert done.errors == []
    assert _points(done.rows)[0][0] == pytest.approx(67.163536, abs=1e-6)

    # Градусы без .prj — WGS 84 по координатам, с предупреждением
    degrees = _shapefile(
        tmp_path / "deg",
        "posts",
        [shapely.Point(68.78, 38.56)],
        {"name": ["Душанбе"]},
        crs=None,
    )
    plain = analyze(_zip(tmp_path / "posts.zip", {f"posts{k}": v for k, v in degrees.items()}))
    assert (plain["geo"]["crs"], plain["geo"]["crsSource"]) == ("EPSG:4326", "default")
    assert any("похожи на градусы" in warning for warning in plain["warnings"])
    with pytest.raises(ImportFileError) as error:
        analyze(source, {"crs": "EPSG:999999"})
    assert error.value.code == "unsupported"


def test_shapefile_полигон_с_самопересечением_исправляется(tmp_path: Path) -> None:
    bow = shapely.Polygon([(68, 38), (69, 39), (69, 38), (68, 39), (68, 38)])
    square = shapely.box(68, 38, 68.5, 38.5)
    files = _shapefile(
        tmp_path / "build",
        "zones",
        [bow, square],
        {"zone": ["Бабочка", "Квадрат"]},
        crs="EPSG:4326",
        geometry_type="Polygon",
    )
    source = _zip(tmp_path / "zones.zip", {f"zones{k}": v for k, v in files.items()})
    analysis = analyze(source)
    assert analysis["geo"]["fixed"] == 1
    assert any("будет исправлена" in warning for warning in analysis["warnings"])
    done = normalize(
        source, mapping_from(analysis), geometry={"kind": "features"}, geometry_field="geom"
    )
    assert done.errors == []
    assert done.rows[0][-1].startswith("SRID=4326;MULTIPOLYGON")
    assert shapely.is_valid(shapely.from_wkt(done.rows[0][-1].split(";", 1)[1]))
    assert done.rows[1][-1].startswith("SRID=4326;POLYGON")


def test_shapefile_и_архивы_без_слоя(tmp_path: Path) -> None:
    files = _shapefile(
        tmp_path / "build", "one", [shapely.Point(68.78, 38.56)], {"a": ["x"]}, crs="EPSG:4326"
    )
    bare = tmp_path / "one.shp"
    bare.write_bytes(files[".shp"])
    with pytest.raises(ImportFileError) as error:
        analyze(bare)
    assert error.value.code == "unsupported"
    assert "архивом .zip" in error.value.message
    empty = _zip(tmp_path / "docs.zip", {"readme.txt": b"hello"})
    with pytest.raises(ImportFileError) as error:
        analyze(empty)
    assert error.value.code == "unsupported"
    no_dbf = _zip(tmp_path / "nodbf.zip", {"one.shp": files[".shp"], "one.shx": files[".shx"]})
    with pytest.raises(ImportFileError) as error:
        analyze(no_dbf)
    assert "one.dbf" in error.value.message


def test_архив_с_двумя_shapefile_это_два_слоя(tmp_path: Path) -> None:
    first = _shapefile(
        tmp_path / "a", "roads", [shapely.LineString([(68, 38), (69, 39)])], {"r": ["M34"]},
        crs="EPSG:4326", geometry_type="LineString",
    )  # fmt: skip
    second = _shapefile(
        tmp_path / "b", "posts", [shapely.Point(68.7, 38.5)] * 2, {"p": ["А", "Б"]},
        crs="EPSG:4326",
    )  # fmt: skip
    members = {f"roads{k}": v for k, v in first.items()} | {
        f"posts{k}": v for k, v in second.items()
    }
    source = _zip(tmp_path / "two.zip", members)
    analysis = analyze(source)
    assert [layer["name"] for layer in analysis["geo"]["layers"]] == ["roads", "posts"]
    assert analysis["geo"]["layer"] == "roads"
    assert any("несколько слоёв" in warning for warning in analysis["warnings"])
    posts = analyze(source, {"layer": "posts"})
    assert [item["name"] for item in posts["columns"]] == ["p"]
    assert posts["rowEstimate"] == 2
    with pytest.raises(ImportFileError) as error:
        analyze(source, {"layer": "rivers"})
    assert error.value.code == "layer_not_found"


# ─── GeoPackage ──────────────────────────────────────────────────────────────


def test_geopackage_два_слоя_и_web_mercator(tmp_path: Path) -> None:
    # Файл задания называется без расширения — как его скачивает движок
    source = tmp_path / "source"
    raw.write(
        str(source),
        shapely.to_wkb(np.array([shapely.Point(68.78, 38.56)], dtype=object)),
        [np.array(["Пост"], dtype=object), np.array([2.5])],
        ["name", "level"],
        layer="posts",
        geometry_type="Point",
        crs="EPSG:4326",
        driver="GPKG",
    )
    zone = shapely.box(7_650_000, 4_650_000, 7_660_000, 4_660_000)
    raw.write(
        str(source),
        shapely.to_wkb(np.array([zone], dtype=object)),
        [np.array(["Зона"], dtype=object)],
        ["title"],
        layer="zones",
        geometry_type="Polygon",
        crs="EPSG:3857",
        driver="GPKG",
        append=True,
    )
    analysis = analyze(source)
    assert analysis["format"] == "gpkg"
    assert [layer["name"] for layer in analysis["geo"]["layers"]] == ["posts", "zones"]
    assert analysis["geo"]["crs"] == "EPSG:4326"
    assert column(analysis, "level")["type"] == "number"

    zones = analyze(source, {"layer": "zones"})
    assert (zones["geo"]["crs"], zones["geo"]["geometryType"]) == ("EPSG:3857", "Polygon")
    done = normalize(
        source,
        mapping_from(zones),
        options={"layer": "zones"},
        geometry={"kind": "features"},
        geometry_field="geom",
    )
    assert done.rows[0][1] == "Зона"
    polygon = shapely.from_wkt(done.rows[0][-1].split(";", 1)[1])
    west, south, east, north = polygon.bounds
    assert 68.7 < west < east < 68.9 and 38.4 < south < north < 38.7


# ─── KML, KMZ, GPX ───────────────────────────────────────────────────────────

KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document><name>Объекты</name>
<Folder><name>ПВР</name>
<Placemark><name>ПВР-1</name><description>Школа</description>
<ExtendedData><Data name="capacity"><value>120</value></Data></ExtendedData>
<Point><coordinates>68.78,38.56,800</coordinates></Point></Placemark>
<Placemark><name>ПВР-2</name>
<ExtendedData><Data name="capacity"><value>80</value></Data></ExtendedData>
<Polygon><outerBoundaryIs><LinearRing>
<coordinates>68.7,38.5 68.8,38.5 68.8,38.6 68.7,38.6 68.7,38.5</coordinates>
</LinearRing></outerBoundaryIs></Polygon></Placemark>
</Folder>
</Document></kml>
"""


def test_kml_и_kmz(tmp_path: Path) -> None:
    kml = tmp_path / "source"
    kml.write_text(KML, encoding="utf-8")
    analysis = analyze(kml)
    assert analysis["format"] == "kml"
    names = [item["name"] for item in analysis["columns"]]
    assert {"Name", "description", "capacity"} <= set(names)
    # Служебные поля оформления меток LIBKML — не столбцы
    assert "tessellate" not in names and "visibility" not in names
    assert (analysis["geo"]["crs"], analysis["geo"]["crsSource"]) == ("EPSG:4326", "default")
    assert analysis["geo"]["geometryType"] is None
    done = normalize(
        kml, mapping_from(analysis), geometry={"kind": "features"}, geometry_field="geom"
    )
    assert done.errors == []
    geometries = [row[-1] for row in done.rows]
    # Высота отброшена: геометрия датасета двумерная
    assert geometries[0] == "SRID=4326;POINT (68.78 38.56)"
    assert geometries[1].startswith("SRID=4326;POLYGON ((68.7 38.5")

    kmz = _zip(tmp_path / "upload.kmz", {"doc.kml": KML.encode()})
    packed = analyze(kmz)
    assert packed["format"] == "kmz"
    assert packed["rowEstimate"] == 2


GPX = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="kchs" xmlns="http://www.topografix.com/GPX/1/1">
<wpt lat="38.56" lon="68.78"><ele>800</ele><time>2026-05-01T10:00:00Z</time>
<name>Лагерь</name></wpt>
<wpt lat="38.57" lon="68.79"><time>2026-05-01T12:30:00Z</time><name>Родник</name></wpt>
<trk><name>Маршрут</name><trkseg>
<trkpt lat="38.56" lon="68.78"><ele>800</ele></trkpt>
<trkpt lat="38.57" lon="68.79"><ele>810</ele></trkpt>
</trkseg></trk>
</gpx>
"""


def test_gpx_точки_и_треки(tmp_path: Path) -> None:
    source = tmp_path / "route.gpx"
    source.write_text(GPX, encoding="utf-8")
    analysis = analyze(source)
    assert analysis["format"] == "gpx"
    assert analysis["geo"]["layer"] == "waypoints"
    assert [layer["name"] for layer in analysis["geo"]["layers"]][:3] == [
        "waypoints",
        "tracks",
        "routes",
    ]
    assert column(analysis, "time")["type"] == "datetime"
    mapping = [item for item in mapping_from(analysis) if item["fieldKey"] in ("name", "time")]
    done = normalize(source, mapping, geometry={"kind": "features"}, geometry_field="geom")
    # Время «Z» — UTC, в нормализованном файле со смещением
    assert done.rows[0][1:3] == ["2026-05-01T10:00:00+00:00", "Лагерь"]
    tracks = analyze(source, {"layer": "tracks"})
    assert tracks["geo"]["geometryType"] == "MultiLineString"


# ─── Координаты в столбцах и GeoJSON ─────────────────────────────────────────


def test_csv_с_координатами_utm(tmp_path: Path) -> None:
    source = tmp_path / "pvr.csv"
    lines = ["Пункт;X;Y"] + [
        f"{name};{x:.1f};{y:.1f}" for name, (x, y) in zip(PVR_NAMES, PVR_UTM, strict=True)
    ]
    source.write_text("\n".join(lines) + "\n", encoding="utf-8")
    blind = analyze(source)
    assert blind["geometry"] is None
    assert blind["geo"]["crsSource"] == "unknown"
    assert any("«X» и «Y»" in warning for warning in blind["warnings"])

    analysis = analyze(source, {"crs": "EPSG:32642"})
    assert analysis["geometry"] == {"kind": "latlon", "lat": 2, "lon": 1}
    assert (analysis["geo"]["crs"], analysis["geo"]["crsSource"]) == ("EPSG:32642", "option")
    assert analysis["geo"]["geometryType"] == "Point"
    done = normalize(
        source,
        mapping_from(analysis),
        options={"crs": "EPSG:32642"},
        geometry=analysis["geometry"],
        geometry_field="geom",
    )
    assert done.errors == []
    assert _points(done.rows)[0] == pytest.approx((67.163536, 38.564056), abs=1e-6)


def test_geojson_с_объявленной_системой_координат(tmp_path: Path) -> None:
    collection = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::32642"}},
        "features": [
            {
                "type": "Feature",
                "properties": {"name": name},
                "geometry": {"type": "Point", "coordinates": [x, y]},
            }
            for name, (x, y) in zip(PVR_NAMES, PVR_UTM, strict=True)
        ],
    }
    source = tmp_path / "pvr.geojson"
    source.write_text(json.dumps(collection, ensure_ascii=False), encoding="utf-8")
    analysis = analyze(source)
    assert (analysis["geo"]["crs"], analysis["geo"]["crsSource"]) == ("EPSG:32642", "file")
    assert analysis["warnings"] == []
    done = normalize(
        source, mapping_from(analysis), geometry={"kind": "features"}, geometry_field="geom"
    )
    assert done.errors == []
    assert _points(done.rows)[2][1] == pytest.approx(38.555, abs=0.01)
