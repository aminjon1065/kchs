"""Геоэкспорт: выгрузка воркера (GeoJSONSeq) → GeoPackage, Shapefile (zip), KML (ADR-0068).

Файлы-результаты читаются обратно pyogrio: число объектов, типы полей,
система координат, раскладка Shapefile по типам геометрии и подписи полей.
"""

import csv
import io
import json
import zipfile
from datetime import date, datetime
from pathlib import Path
from typing import Any

import pyogrio
import pytest
from fastapi.testclient import TestClient

from kchs_engine import main
from kchs_engine.config import settings
from kchs_engine.data.geo_export import ExportField, ascii_name, convert_features, dbf_names

TOKEN = "service-token-for-tests"

FIELDS = [
    ExportField("code", "Код", "identifier"),
    ExportField("population_total", "Население, всего", "integer"),
    ExportField("population_share", "Доля", "percent"),
    ExportField("opened", "Открыт", "date"),
    ExportField("checked_at", "Проверен", "datetime"),
    ExportField("active", "Работает", "boolean"),
    ExportField("tags", "Метки", "multi_select"),
]


def _feature(geometry: dict[str, Any] | None, **properties: Any) -> str:
    return json.dumps(
        {"type": "Feature", "geometry": geometry, "properties": properties}, ensure_ascii=False
    )


ROWS = [
    _feature(
        {"type": "Point", "coordinates": [68.78, 38.56]},
        code="П-1",
        population_total=1200,
        population_share=0.25,
        opened="2026-05-01",
        checked_at="2026-05-01T05:00:00.000Z",
        active=True,
        tags=["школа", "ПВР"],
    ),
    _feature(
        {"type": "Polygon", "coordinates": [[[68, 38], [69, 38], [69, 39], [68, 38]]]},
        code="З-1",
        population_total=None,
        population_share=None,
        opened=None,
        checked_at=None,
        active=False,
        tags=None,
    ),
    _feature(
        {
            "type": "GeometryCollection",
            "geometries": [
                {"type": "Point", "coordinates": [68.9, 38.9]},
                {"type": "LineString", "coordinates": [[68, 38], [68.5, 38.5]]},
            ],
        },
        code="К-1",
        population_total=5,
    ),
    _feature({"type": "MultiPoint", "coordinates": [[68.1, 38.1], [68.2, 38.2]]}, code="М-1"),
    _feature(None, code="Б-1", population_total=7),
]


@pytest.fixture
def source(tmp_path: Path) -> Path:
    path = tmp_path / "rows.geojsonl"
    path.write_text("\n".join(ROWS) + "\n", encoding="utf-8")
    return path


def _records(path: str, layer: str | None = None) -> dict[str, list[Any]]:
    with pyogrio.open_arrow(path, layer=layer, use_pyarrow=True) as (_meta, reader):
        table = reader.read_all()
    return table.to_pydict()


def test_имена_файлов_и_полей_dbf() -> None:
    assert ascii_name("Пункты временного размещения 2026") == "punkty_vremennogo_razmescheniya_2026"
    assert ascii_name("Ҳисор ва Ғарм") == "hisor_va_gharm"
    assert ascii_name("***") == "layer"
    assert dbf_names(["population_total", "population_share", "code", "Код"]) == [
        "population",
        "populati_1",
        "code",
        "___",
    ]


def test_geopackage(source: Path, tmp_path: Path) -> None:
    target = tmp_path / "out.gpkg"
    assert convert_features(source, target, "gpkg", "Пункты", FIELDS) == 5
    info = pyogrio.read_info(str(target), layer="Пункты", force_feature_count=True)
    assert info["features"] == 5
    assert info["crs"] == "EPSG:4326"
    assert dict(zip(info["fields"], info["dtypes"], strict=True)) == {
        "code": "object",
        "population_total": "int64",
        "population_share": "float64",
        "opened": "datetime64[D]",
        "checked_at": "datetime64[ms]",
        "active": "bool",
        "tags": "object",
    }
    records = _records(str(target), "Пункты")
    assert records["code"] == ["П-1", "З-1", "К-1", "М-1", "Б-1"]
    assert records["population_total"] == [1200, None, 5, None, 7]
    assert records["opened"][0] == date(2026, 5, 1)
    assert records["checked_at"][0].replace(tzinfo=None) == datetime(2026, 5, 1, 5, 0)
    assert records["tags"][0] == "школа, ПВР"
    assert records["active"][:2] == [True, False]


def test_shapefile_по_типам_геометрии(source: Path, tmp_path: Path) -> None:
    target = tmp_path / "out.zip"
    assert convert_features(source, target, "shp", "Пункты ПВР", FIELDS) == 5
    with zipfile.ZipFile(target) as archive:
        names = sorted(archive.namelist())
        legend = archive.read("fields.csv").decode("utf-8-sig")
        cpg = archive.read("punkty_pvr_points.cpg").decode()
    assert names == sorted(
        [
            f"punkty_pvr_{family}.{suffix}"
            for family in ("points", "lines", "polygons")
            for suffix in ("shp", "shx", "dbf", "prj", "cpg")
        ]
        + ["fields.csv"]
    )
    assert cpg.strip().upper() == "UTF-8"
    rows = list(csv.reader(io.StringIO(legend)))
    assert rows[0] == ["dbf", "key", "label"]
    assert rows[2] == ["population", "population_total", "Население, всего"]

    points = f"/vsizip/{target}/punkty_pvr_points.shp"
    info = pyogrio.read_info(points, force_feature_count=True)
    # Есть MultiPoint — все точки файла мультиточки; строка без геометрии — в первом файле
    assert info["geometry_type"] == "MultiPoint"
    assert info["crs"] == "EPSG:4326"
    records = _records(points)
    assert records["code"] == ["П-1", "К-1", "М-1", "Б-1"]
    assert records["population"] == [1200, 5, None, 7]
    lines = _records(f"/vsizip/{target}/punkty_pvr_lines.shp")
    polygons = _records(f"/vsizip/{target}/punkty_pvr_polygons.shp")
    # Коллекция геометрий разложена по файлам своих частей
    assert (lines["code"], polygons["code"]) == (["К-1"], ["З-1"])


def test_kml_с_именем_метки(source: Path, tmp_path: Path) -> None:
    target = tmp_path / "out.kml"
    assert convert_features(source, target, "kml", "Пункты", FIELDS) == 5
    text = target.read_text(encoding="utf-8")
    assert "<name>П-1</name>" in text
    assert "<coordinates>68.78,38.56</coordinates>" in text
    info = pyogrio.read_info(str(target), force_feature_count=True)
    assert info["features"] == 5


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TOKEN)
    settings.cache_clear()
    return TestClient(main.app)


def test_маршрут_геоэкспорта(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, source: Path
) -> None:
    uploaded: dict[str, tuple[bytes, str]] = {}

    async def download(bucket: str, key: str, target: Path) -> Path:
        assert (bucket, key) == ("kchs-exports", "datasets/x/job/source.geojsonl")
        target.write_bytes(source.read_bytes())
        return target

    async def upload(bucket: str, key: str, path: Path, content_type: str) -> None:
        uploaded[key] = (path.read_bytes(), content_type)

    monkeypatch.setattr(main, "download", download)
    monkeypatch.setattr(main, "upload", upload)
    body = {
        "bucket": "kchs-exports",
        "sourceKey": "datasets/x/job/source.geojsonl",
        "targetKey": "datasets/x/job/Пункты.gpkg",
        "format": "gpkg",
        "layer": "Пункты",
        "contentType": "application/geopackage+sqlite3",
        "fields": [{"name": f.name, "label": f.label, "type": f.type} for f in FIELDS],
    }
    assert client.post("/data/geo-export", json=body).status_code == 401
    headers = {"x-kchs-service-token": TOKEN}
    response = client.post("/data/geo-export", json=body, headers=headers)
    assert response.status_code == 200, response.text
    data, content_type = uploaded["datasets/x/job/Пункты.gpkg"]
    assert response.json() == {"rows": 5, "size": len(data)}
    assert data.startswith(b"SQLite format 3")
    assert content_type == "application/geopackage+sqlite3"
    wrong = client.post("/data/geo-export", json={**body, "format": "csv"}, headers=headers)
    assert wrong.status_code == 422
