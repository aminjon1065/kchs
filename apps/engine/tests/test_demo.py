"""Демо-данные фазы 1 (P1-E10, 04-verification.md §7).

Малый профиль генерируется один раз на модуль: детерминированность, манифест,
схемы файлов и ссылки между ними, распознавание анализом импорта и
нормализация без ошибок (ADR-0046), правдоподобные распределения.
Большой профиль (5 млн строк) — `pytest -m slow -s tests/test_demo.py`.
"""

import asyncio
import csv
import hashlib
import json
import math
import os
import re
import resource
import statistics
import sys
import time
import uuid
from collections import Counter, defaultdict
from itertools import pairwise
from pathlib import Path
from typing import Any

import pytest
from import_helpers import assert_contract

from kchs_engine import storage
from kchs_engine.config import settings
from kchs_engine.contracts import data_import_contract
from kchs_engine.data.analyze import analyze_file, analyze_object
from kchs_engine.data.normalize import normalize_file, territory_key
from kchs_engine.data.readers import SAMPLE_BYTES
from kchs_engine.demo import DATASET_IDS, DATASETS, DEFAULT_SEED, PROFILES, generate
from kchs_engine.demo.__main__ import main
from kchs_engine.demo.incidents import SLOTS, incident_lines, template_slots
from kchs_engine.demo.output import DirectoryTarget, S3Target, parse_target
from kchs_engine.demo.reference import DISTRICTS, INCIDENT_KINDS, REGIONS, RIVERS, VILLAGES
from kchs_engine.demo.world import build_districts

Manifest = dict[str, Any]

# Таджикистан с запасом в полградуса
LAT_RANGE = (36.2, 41.5)
LON_RANGE = (67.0, 75.5)
KEY = re.compile(r"[a-z_][a-z0-9_]*")
DAYS = 1096  # 2024-01-01 … 2026-12-31


@pytest.fixture(scope="module")
def small(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Manifest]:
    folder = tmp_path_factory.mktemp("demo-small")
    manifest = generate(DirectoryTarget(folder), PROFILES["small"])
    return folder, manifest


def entry(manifest: Manifest, dataset: str) -> dict[str, Any]:
    found: dict[str, Any] = next(item for item in manifest["datasets"] if item["id"] == dataset)
    return found


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as stream:
        return list(csv.DictReader(stream))


def territory_table(folder: Path) -> dict[str, str]:
    """Коды справочника территорий → условные идентификаторы (как `matchTable` api)."""
    rows = read_csv(folder / "territories.csv")
    return {
        territory_key(row["Код"]): str(uuid.uuid5(uuid.NAMESPACE_URL, row["Код"])) for row in rows
    }


def features(path: Path) -> list[dict[str, Any]]:
    collection = json.loads(path.read_text(encoding="utf-8"))
    assert collection["type"] == "FeatureCollection"
    items: list[dict[str, Any]] = collection["features"]
    return items


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ─── Детерминированность ─────────────────────────────────────────────────────


def test_одинаковый_seed_даёт_те_же_файлы(small: tuple[Path, Manifest], tmp_path: Path) -> None:
    folder, manifest = small
    again = generate(DirectoryTarget(tmp_path), PROFILES["small"])
    assert again == manifest
    names = sorted(path.name for path in folder.iterdir())
    assert names == sorted(path.name for path in tmp_path.iterdir())
    for name in names:
        assert sha256(tmp_path / name) == sha256(folder / name), name

    other = generate(
        DirectoryTarget(tmp_path / "other"),
        PROFILES["small"],
        seed=DEFAULT_SEED + 1,
        only={"incidents", "risk_zones"},
    )
    assert [item["id"] for item in other["datasets"]] == ["incidents", "risk_zones"]
    for item in other["datasets"]:
        assert item["sha256"] != entry(manifest, item["id"])["sha256"]


# Эталон малого профиля с seed по умолчанию: одинаков на macOS (arm64, Python 3.14) и
# Linux (arm64 и x86_64, Python 3.12). Меняется только при намеренной правке генератора —
# тогда меняются и демо-данные, на которые опираются e2e-сценарии.
GOLDEN = {
    "territories": "a5d59791c6c87046b98dc48b95ab7856d356b82761491c366b0af168a4e7e1ee",
    "incident_types": "452ad42c452f90df582f01c0b2771d358031982d725218d954f848a3892da383",
    "hydro_posts": "0bc24b12220942a097024b2772690db63d961330a21643ef84bceb835653d80f",
    "incidents": "2e4a9198f46d9526efcda3b9436cda70b472a2f34ac3728e40b6946c20e25785",
    "protected_objects": "633a19149c4ca6a1c8615d0be342520ec19b7c98c2f6b9ac7736d35d58ff9207",
    "risk_zones": "84cf65343fbdfa23c228c4f8166b9e59d0ee21789a372fd4188bf342b38003f9",
    "water_levels": "1b03d34c68ea6fdeadbfd35ed5aa250b31487bdc49f1496f3509ee80be9e20ea",
}


def test_эталонные_хэши_малого_профиля(small: tuple[Path, Manifest]) -> None:
    _folder, manifest = small
    assert {item["id"]: item["sha256"] for item in manifest["datasets"]} == GOLDEN


def test_наборы_независимы_от_объёма_других(small: tuple[Path, Manifest], tmp_path: Path) -> None:
    """Число происшествий не сдвигает случайные числа других наборов."""
    _folder, manifest = small
    fewer = generate(
        DirectoryTarget(tmp_path),
        PROFILES["small"],
        incidents=1_000,
        only={"incidents", "risk_zones"},
    )
    assert entry(fewer, "incidents")["rows"] == 1_000
    assert entry(fewer, "risk_zones")["sha256"] == entry(manifest, "risk_zones")["sha256"]


# ─── Манифест и схемы ────────────────────────────────────────────────────────


def test_манифест_описывает_файлы_и_загрузку(small: tuple[Path, Manifest]) -> None:
    folder, manifest = small
    contract = data_import_contract()
    assert manifest["format"] == "kchs-demo/1"
    assert (manifest["profile"], manifest["seed"]) == ("small", DEFAULT_SEED)
    assert manifest["period"] == {"from": "2024-01-01", "to": "2026-12-31"}
    assert [item["id"] for item in manifest["datasets"]] == list(DATASET_IDS)
    ids = set(DATASET_IDS)
    expected_rows = {
        "territories": 74,
        "incident_types": len(INCIDENT_KINDS),
        "hydro_posts": sum(len(river.districts) for river in RIVERS),
        "incidents": 50_000,
        "protected_objects": 5_000,
        "water_levels": 12 * DAYS,
    }
    keys_by_dataset = {
        item["id"]: {field["fieldKey"] for field in item["import"]["mapping"]}
        for item in manifest["datasets"]
    }
    for item in manifest["datasets"]:
        path = folder / item["file"]
        assert item["bytes"] == path.stat().st_size
        assert item["sha256"] == sha256(path)
        if item["format"] == "csv":
            with path.open(encoding="utf-8", newline="") as stream:
                reader = csv.reader(stream)
                header = next(reader)
                rows = sum(1 for _row in reader)
        else:
            assert item["format"] == "geojson"
            items = features(path)
            header = list(items[0]["properties"])
            rows = len(items)
        assert item["rows"] == rows
        if item["id"] in expected_rows:
            assert rows == expected_rows[item["id"]], item["id"]
        assert item["kind"] in ("table", "reference")
        assert item["name"] and item["description"]

        run = item["import"]
        mapping = run["mapping"]
        assert [field["column"] for field in mapping] == list(range(len(header)))
        assert [field["label"]["ru"] for field in mapping] == header
        field_keys = [field["fieldKey"] for field in mapping]
        assert len(set(field_keys)) == len(field_keys)
        for field in mapping:
            assert KEY.fullmatch(field["fieldKey"]) and len(field["fieldKey"]) <= 64
            assert field["type"] in contract["fieldTypes"]
            assert field["semantic"] in contract["semantics"]
            assert field["label"]["en"]
            assert isinstance(field["required"], bool)
        assert set(run["options"]) <= {
            "format", "encoding", "delimiter", "skipRows", "headerRows", "decimal", "thousands",
            "dateOrder",
        }  # fmt: skip
        assert run["options"]["format"] == item["format"]
        assert run["key"] == item["key"] and run["key"]
        assert set(run["key"]) <= set(field_keys)
        assert run["onError"] == "stop"
        for name in ("timeField", "territoryField"):
            assert item[name] is None or item[name] in field_keys
        if item["territoryField"]:
            territory = next(f for f in mapping if f["fieldKey"] == item["territoryField"])
            # Поле-территория (ADR-0057): импорт сопоставляет коды со справочником территорий
            assert (territory["type"], territory["semantic"]) == ("territory", "territory")
        geometry = run.get("geometry")
        if geometry is None:
            assert "geometryField" not in run and item["geometryField"] is None
        else:
            assert run["geometryField"] == item["geometryField"] == "geometry"
            assert "geometry" not in field_keys
            if geometry["kind"] == "latlon":
                assert header[geometry["lat"]] == "Широта"
                assert header[geometry["lon"]] == "Долгота"
            else:
                assert geometry == {"kind": "features"} and item["format"] == "geojson"
        for lookup in item["lookups"]:
            assert lookup["field"] in field_keys
            assert lookup["dataset"] in ids
            target = keys_by_dataset[lookup["dataset"]]
            assert {lookup["keyField"], lookup["labelField"]} <= target


def test_справочник_территорий(small: tuple[Path, Manifest]) -> None:
    folder, _manifest = small
    rows = read_csv(folder / "territories.csv")
    by_code = {row["Код"]: row for row in rows}
    assert len(by_code) == len(rows) == 1 + len(REGIONS) + len(DISTRICTS) == 74
    assert [row["Код"] for row in rows] == sorted(by_code)
    levels = Counter(row["Уровень"] for row in rows)
    assert levels == {"страна": 1, "регион": 5, "район": 68}
    assert {row["Код"] for row in rows if row["Уровень"] == "регион"} == {
        "TJ-DU", "TJ-GB", "TJ-KT", "TJ-RA", "TJ-SU",
    }  # fmt: skip
    for row in rows:
        if row["Уровень"] == "район":
            assert re.fullmatch(r"TJ-(DU|GB|KT|RA|SU)-\d\d", row["Код"])
            assert row["Код родителя"] == row["Код"][:5]
        elif row["Уровень"] == "регион":
            assert row["Код родителя"] == "TJ"
            children = [r for r in rows if r["Код родителя"] == row["Код"]]
            assert int(row["Население"]) == sum(int(r["Население"]) for r in children)
        assert row["Название"] and row["Название (тадж.)"] and row["Название (англ.)"]
        assert LAT_RANGE[0] < float(row["Широта"]) < LAT_RANGE[1]
        assert LON_RANGE[0] < float(row["Долгота"]) < LON_RANGE[1]
    # Названия районов не повторяются: описание происшествия называет район по имени
    names = [row["Название"] for row in rows if row["Уровень"] == "район"]
    assert len(set(names)) == len(names)
    assert Counter(row["Код родителя"] for row in rows if row["Уровень"] == "район") == {
        "TJ-DU": 4, "TJ-GB": 8, "TJ-KT": 25, "TJ-RA": 13, "TJ-SU": 18,
    }  # fmt: skip


def test_происшествия_ссылаются_на_справочники(small: tuple[Path, Manifest]) -> None:
    folder, _manifest = small
    rows = read_csv(folder / "incidents.csv")
    types = {row["Код"] for row in read_csv(folder / "incident_types.csv")}
    districts = {info.code for info in DISTRICTS}
    assert {row["Тип"] for row in rows} == types
    assert {row["Территория"] for row in rows} == districts
    stamps = [row["Дата и время"] for row in rows]
    assert stamps == sorted(stamps)
    assert stamps[0] >= "2024-01-01 00:00" and stamps[-1] <= "2026-12-31 23:59"
    codes = [row["Номер"] for row in rows]
    assert len(set(codes)) == len(codes)
    for year in ("2024", "2025", "2026"):
        numbers = [int(code[9:]) for code in codes if code[4:8] == year]
        assert numbers == list(range(1, len(numbers) + 1))
    for row in rows:
        assert re.fullmatch(r"INC-20(24|25|26)-\d{7}", row["Номер"])
        assert row["Номер"][4:8] == row["Дата и время"][:4]
        assert re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d", row["Дата и время"])
        assert LAT_RANGE[0] < float(row["Широта"]) < LAT_RANGE[1]
        assert LON_RANGE[0] < float(row["Долгота"]) < LON_RANGE[1]
        assert row["Ущерб, сомони"] == "" or 0 < float(row["Ущерб, сомони"]) <= 20_000_000
        assert int(row["Пострадавшие"]) >= 0 and int(row["Погибшие"]) >= 0
        assert len(row) == 10 and row["Описание"]


def test_уровни_воды_по_постам(small: tuple[Path, Manifest]) -> None:
    folder, _manifest = small
    posts = {row["Код"]: row for row in read_csv(folder / "hydro_posts.csv")}
    rows = read_csv(folder / "water_levels.csv")
    pairs = {(row["Дата"], row["Гидропост"]) for row in rows}
    assert len(pairs) == len(rows) == 12 * DAYS
    # Малый профиль — первые 12 постов, и все на разных реках
    used = sorted({row["Гидропост"] for row in rows})
    assert used == [f"HP-{number:02d}" for number in range(1, 13)]
    assert len({posts[code]["Река"] for code in used}) == 12
    for row in rows:
        post = posts[row["Гидропост"]]
        assert row["Территория"] == post["Территория"]
        above = int(row["Уровень воды, см"]) >= int(post["Опасный уровень, см"])
        assert row["Выше опасного уровня"] == ("да" if above else "нет")
        assert float(row["Расход воды, м³/с"]) > 0


def test_геометрия_объектов_и_зон(small: tuple[Path, Manifest]) -> None:
    folder, manifest = small
    districts = {info.code for info in DISTRICTS}
    objects = features(folder / "protected_objects.geojson")
    header = [f["label"]["ru"] for f in entry(manifest, "protected_objects")["import"]["mapping"]]
    for item in objects:
        assert list(item["properties"]) == header
        assert item["properties"]["Территория"] in districts
        geometry = item["geometry"]
        assert geometry["type"] == "Point"
        lon, lat = geometry["coordinates"]
        assert LAT_RANGE[0] < lat < LAT_RANGE[1] and LON_RANGE[0] < lon < LON_RANGE[1]
    assert len({item["properties"]["Код"] for item in objects}) == len(objects)

    zones = features(folder / "risk_zones.geojson")
    header = [f["label"]["ru"] for f in entry(manifest, "risk_zones")["import"]["mapping"]]
    assert len(zones) > 150
    for item in zones:
        assert list(item["properties"]) == header
        assert item["properties"]["Территория"] in districts
        assert item["properties"]["Площадь, км²"] > 0
        geometry = item["geometry"]
        assert geometry["type"] == "Polygon" and len(geometry["coordinates"]) == 1
        ring = geometry["coordinates"][0]
        assert len(ring) >= 15 and ring[0] == ring[-1]
        # Внешнее кольцо — против часовой стрелки (RFC 7946), без повторов вершин
        signed = sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in pairwise(ring))
        assert signed > 0
        assert len({tuple(point) for point in ring[:-1]}) == len(ring) - 1


def test_шаблоны_описаний_и_имена_без_кавычек() -> None:
    for kind in INCIDENT_KINDS:
        assert kind.templates
        assert len(kind.season) == 12 and max(kind.season) > 0
        for template in kind.templates:
            assert template_slots(template) <= set(SLOTS), template
            assert '"' not in template and "\n" not in template
    names = [*VILLAGES, *(info.name for info in DISTRICTS)]
    assert all('"' not in name and "," not in name for name in names)
    assert len(set(VILLAGES)) == len(VILLAGES)
    known = {info.name for info in DISTRICTS}
    assert all(name in known for river in RIVERS for name in river.districts)


def test_адрес_назначения() -> None:
    target = parse_target("s3://kchs-files/seed/demo/")
    assert isinstance(target, S3Target)
    assert target.location("manifest.json") == "s3://kchs-files/seed/demo/manifest.json"
    bare = parse_target("s3://kchs-files")
    assert isinstance(bare, S3Target) and bare.key("a.csv") == "a.csv"
    folder = parse_target("seeds/.cache/demo")
    assert isinstance(folder, DirectoryTarget)
    with pytest.raises(ValueError):
        parse_target("s3:///prefix")


# ─── Анализ и нормализация импорта (ADR-0046) ────────────────────────────────

# Поля, которые манифест загружает не так, как предложит анализ, — сознательно
UPGRADES = {
    ("incidents", "damage"): ("number", "measure"),
    ("protected_objects", "seismic_rating"): ("integer", "measure"),
}


@pytest.mark.parametrize("dataset", DATASET_IDS)
def test_анализ_импорта_распознаёт_файл(small: tuple[Path, Manifest], dataset: str) -> None:
    folder, manifest = small
    item = entry(manifest, dataset)
    path = folder / item["file"]
    analysis = analyze_file(path, path.name, {}, complete=True)
    assert_contract(analysis)
    assert analysis["warnings"] == []
    assert analysis["format"] == item["format"]
    assert analysis["encoding"] == "utf-8"
    assert analysis["geometry"] == item["import"].get("geometry")
    options = item["import"]["options"]
    if item["format"] == "csv":
        assert (analysis["delimiter"], analysis["decimal"], analysis["thousands"]) == (",", ".", "")
        assert (analysis["skipRows"], analysis["headerRows"]) == (0, 1)
    assert analysis["dateOrder"] == options.get("dateOrder")
    if path.stat().st_size > SAMPLE_BYTES:
        assert analysis["approx"] and analysis["rowEstimate"] == pytest.approx(item["rows"], 0.02)
    else:
        assert (analysis["rowEstimate"], analysis["approx"]) == (item["rows"], False)
    mapping = item["import"]["mapping"]
    assert [column["name"] for column in analysis["columns"]] == [
        field["label"]["ru"] for field in mapping
    ]
    for column, field in zip(analysis["columns"], mapping, strict=True):
        assert column["invalid"] == 0, column["name"]
        expected = UPGRADES.get((dataset, field["fieldKey"]), (field["type"], field["semantic"]))
        if field["semantic"] == "territory":
            # Поле-территорию анализ не предлагает (в файле — коды районов), её задаёт манифест
            assert (column["type"], field["type"]) == ("text", "territory")
            assert column["semantic"] in ("dimension", "category")
        else:
            assert (column["type"], column["semantic"]) == expected, column["name"]
        if field["type"] in ("date", "datetime"):
            assert column["format"] == field["format"]


@pytest.mark.parametrize("dataset", DATASET_IDS)
def test_нормализация_по_манифесту_без_ошибок(
    small: tuple[Path, Manifest], dataset: str, tmp_path: Path
) -> None:
    folder, manifest = small
    item = entry(manifest, dataset)
    run = item["import"]
    path = folder / item["file"]
    normalized, errors = tmp_path / "normalized.csv", tmp_path / "errors.csv"
    # Таблица сопоставления территорий, как её передаёт api (ADR-0057): код → идентификатор
    territories = territory_table(folder)
    result = normalize_file(
        path,
        path.name,
        run["options"],
        run["mapping"],
        run.get("geometry"),
        run.get("geometryField"),
        normalized,
        errors,
        zone="Asia/Dushanbe",
        territories=territories,
    )
    assert (result.rows, result.errors, result.written) == (item["rows"], 0, item["rows"])
    assert errors.read_text(encoding="utf-8") == "row,field,value,code\n"
    with normalized.open(encoding="utf-8") as stream:
        first = next(csv.reader(stream))
    assert len(first) == 1 + len(run["mapping"]) + (1 if "geometry" in run else 0)
    if dataset == "incidents":
        assert first[:2] == ["2", "INC-2024-0000001"]
        assert first[4] in territories.values()
        assert re.fullmatch(r"2024-01-01T\d\d:\d\d:00\+05:00", first[2])
        assert re.fullmatch(r"SRID=4326;POINT\(\d+\.\d+ \d+\.\d+\)", first[-1])
    if dataset == "risk_zones":
        assert first[-1].startswith("SRID=4326;POLYGON((")
    if dataset == "water_levels":
        assert first[1] == "2024-01-01" and first[6] in ("true", "false")


def test_голова_профиля_demo_распознаётся_так_же(tmp_path: Path) -> None:
    """Голова пятимиллионного файла — первые дни января 2024 (почти без паводков и
    природных пожаров, другие доли типов): те же типы полей и без предупреждений."""
    districts = build_districts(DEFAULT_SEED)
    path = tmp_path / "incidents.csv"
    size = 0
    with path.open("w", encoding="utf-8", newline="") as stream:
        for chunk in incident_lines(districts, PROFILES["demo"].incidents, DEFAULT_SEED):
            stream.write(chunk)
            size += len(chunk.encode("utf-8"))
            if size > SAMPLE_BYTES + 1_000_000:
                break
    analysis = analyze_file(path, path.name, {}, complete=True)
    assert analysis["warnings"] == []
    spec = next(spec for spec in DATASETS if spec.id == "incidents")
    for column, field in zip(analysis["columns"], spec.columns, strict=True):
        assert column["invalid"] == 0, column["name"]
        kind, semantic = UPGRADES.get(("incidents", field.key), (field.type, field.semantic))
        if field.semantic == "territory":
            # Коды районов анализ видит текстом; поле-территорию задаёт манифест
            assert column["type"] == "text", column["name"]
            continue
        assert (column["type"], column["semantic"]) == (kind, semantic), column["name"]


# ─── Распределения ───────────────────────────────────────────────────────────


def _months(rows: list[dict[str, str]], kind: str) -> list[int]:
    counts = Counter(int(row["Дата и время"][5:7]) for row in rows if row["Тип"] == kind)
    return [counts[month] for month in range(1, 13)]


def test_распределения_происшествий_правдоподобны(small: tuple[Path, Manifest]) -> None:
    folder, _manifest = small
    rows = read_csv(folder / "incidents.csv")
    total = len(rows)

    def share(months: list[int], chosen: range) -> float:
        return sum(months[month - 1] for month in chosen) / sum(months)

    # Сезонность: паводки и сели весной, лавины зимой, природные пожары и вода летом
    assert share(_months(rows, "FLOOD"), range(3, 7)) > 0.6
    assert share(_months(rows, "MUDFLOW"), range(3, 7)) > 0.6
    avalanches = _months(rows, "AVALANCHE")
    assert sum(avalanches[month - 1] for month in (12, 1, 2, 3)) / sum(avalanches) > 0.8
    assert sum(avalanches[5:9]) == 0
    assert share(_months(rows, "WILDFIRE"), range(6, 10)) > 0.6
    assert share(_months(rows, "DROWNING"), range(6, 9)) > 0.6
    fires = _months(rows, "FIRE")
    assert fires[0] + fires[11] > 1.5 * (fires[4] + fires[5])

    # Больше всего — ДТП и пожары; с каждым годом происшествий немного больше
    top = [code for code, _count in Counter(row["Тип"] for row in rows).most_common(2)]
    assert set(top) == {"ROAD", "FIRE"}
    years = Counter(row["Дата и время"][:4] for row in rows)
    assert years["2024"] < years["2025"] < years["2026"] < 1.2 * years["2024"]

    # Лавины — в горах, ДТП — там, где живут люди
    mountain = {info.code: info.mountain for info in DISTRICTS}
    avalanche_places = [mountain[row["Территория"]] for row in rows if row["Тип"] == "AVALANCHE"]
    assert statistics.mean(avalanche_places) > 0.75
    road = Counter(row["Территория"][:5] for row in rows if row["Тип"] == "ROAD")
    assert road["TJ-GB"] < 0.05 * sum(road.values())

    # Погибшие — редко, пострадавшие — у трети, ущерб — логнормальный (среднее ≫ медианы)
    deaths = [int(row["Погибшие"]) for row in rows]
    assert 0.02 < sum(1 for value in deaths if value) / total < 0.12
    assert Counter(deaths)[1] > Counter(deaths)[2] > Counter(deaths)[3]
    injured = [int(row["Пострадавшие"]) for row in rows]
    assert 0.15 < sum(1 for value in injured if value) / total < 0.5
    damage = [float(row["Ущерб, сомони"]) for row in rows if row["Ущерб, сомони"]]
    assert 0.7 < len(damage) / total < 0.95
    assert 5_000 < statistics.median(damage) < 100_000
    assert statistics.mean(damage) > 3 * statistics.median(damage)
    by_kind: dict[str, list[float]] = defaultdict(list)
    for row in rows:
        if row["Ущерб, сомони"]:
            by_kind[row["Тип"]].append(float(row["Ущерб, сомони"]))
    assert statistics.median(by_kind["EARTHQUAKE"]) > 5 * statistics.median(by_kind["ROAD"])
    assert not by_kind["DROWNING"] and not by_kind["MOUNTAIN"]

    # Описания длинные (семантика «текст») и называют пункты района
    assert statistics.mean(len(row["Описание"]) for row in rows) > 60
    districts = {district.code: district for district in build_districts(DEFAULT_SEED)}
    for row in rows[:500]:
        district = districts[row["Территория"]]
        assert any(place.at in row["Описание"] or place.near in row["Описание"]
                   for place in district.places) or district.where in row["Описание"]  # fmt: skip


def test_уровни_воды_сезонны(small: tuple[Path, Manifest]) -> None:
    folder, _manifest = small
    posts = {row["Код"]: row for row in read_csv(folder / "hydro_posts.csv")}
    regimes = {river.name: river.regime for river in RIVERS}
    levels: dict[str, dict[int, list[int]]] = defaultdict(lambda: defaultdict(list))
    rows = read_csv(folder / "water_levels.csv")
    for row in rows:
        levels[row["Гидропост"]][int(row["Дата"][5:7])].append(int(row["Уровень воды, см"]))
    for code, months in levels.items():
        means = {month: statistics.mean(values) for month, values in months.items()}
        peak = max(means, key=lambda month: means[month])
        regime = regimes[posts[code]["Река"]]
        if regime == "glacier":
            assert peak in (6, 7, 8), code
        elif regime == "snow":
            assert peak in (4, 5, 6), code
        assert means[peak] > 1.3 * means[1], code
    above = sum(1 for row in rows if row["Выше опасного уровня"] == "да") / len(rows)
    assert 0.003 < above < 0.08


# ─── CLI ─────────────────────────────────────────────────────────────────────


def test_cli_пишет_каталог(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code = main(
        ["--out", str(tmp_path), "--profile", "small", "--only", "territories, incident_types"]
    )
    assert code == 0
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert [item["id"] for item in manifest["datasets"]] == ["territories", "incident_types"]
    assert sorted(path.name for path in tmp_path.iterdir()) == [
        "incident_types.csv", "manifest.json", "territories.csv",
    ]  # fmt: skip
    err = capsys.readouterr().err
    assert "territories.csv: 74 строк" in err and "пик памяти" in err

    with pytest.raises(SystemExit) as failed:
        main(["--out", str(tmp_path), "--only", "incidents,нет_такого"])
    assert failed.value.code == 2
    assert "нет_такого" in capsys.readouterr().err


def test_расстояния_в_градусах() -> None:
    # 111 км к северу — градус широты; к востоку на широте Душанбе — больше градуса
    from kchs_engine.demo.world import offset

    lat, lon = offset(38.56, 68.78, 0.0, 111.32)
    assert math.isclose(lat, 39.56) and lon == 68.78
    lat, lon = offset(38.56, 68.78, 111.32, 0.0)
    assert lat == 38.56 and 1.27 < lon - 68.78 < 1.29


# ─── Хранилище и большой профиль ─────────────────────────────────────────────


@pytest.mark.s3
@pytest.mark.skipif(os.environ.get("KCHS_TEST_S3") != "1", reason="нужен MinIO разработки")
def test_запись_в_minio_крупный_файл_частями() -> None:
    """`KCHS_TEST_S3=1 pytest -m s3` с переменными S3_* из `.env` разработки; объекты —
    под префиксом `test-engine-demo/` и удаляются."""
    settings.cache_clear()
    storage._client.cache_clear()
    bucket = settings().S3_BUCKET_FILES
    prefix = f"test-engine-demo/{uuid.uuid4()}/"
    client = storage._client()
    try:
        manifest = generate(
            parse_target(f"s3://{bucket}/{prefix}"),
            PROFILES["small"],
            only={"territories", "incidents"},
        )
        listed = client.list_objects_v2(Bucket=bucket, Prefix=prefix)
        assert sorted(item["Key"] for item in listed.get("Contents", [])) == [
            f"{prefix}incidents.csv", f"{prefix}manifest.json", f"{prefix}territories.csv",
        ]  # fmt: skip
        incidents = entry(manifest, "incidents")
        assert incidents["bytes"] > 8 * 1024 * 1024
        head = client.head_object(Bucket=bucket, Key=f"{prefix}incidents.csv")
        # Больше 8 МБ — загрузка частями: ETag такой загрузки — «хэш-число частей»
        assert re.fullmatch(r'"[0-9a-f]{32}-\d+"', head["ETag"]), head["ETag"]
        assert head["ContentType"] == "text/csv; charset=utf-8"
        assert head["ContentLength"] == incidents["bytes"]
        body = client.get_object(Bucket=bucket, Key=f"{prefix}incidents.csv")["Body"].read()
        assert hashlib.sha256(body).hexdigest() == incidents["sha256"]
        stored = client.get_object(Bucket=bucket, Key=f"{prefix}manifest.json")["Body"].read()
        assert json.loads(stored) == manifest
        # Анализ движка читает из хранилища только голову файла
        analysis = asyncio.run(
            analyze_object(bucket, f"{prefix}incidents.csv", "incidents.csv", {})
        )
        assert analysis["warnings"] == [] and analysis["approx"]
        assert analysis["geometry"] == {"kind": "latlon", "lat": 4, "lon": 5}
    finally:
        listed = client.list_objects_v2(Bucket=bucket, Prefix=prefix)
        for item in listed.get("Contents", []):
            client.delete_object(Bucket=bucket, Key=item["Key"])
        assert client.list_objects_v2(Bucket=bucket, Prefix=prefix).get("KeyCount", 0) == 0
        settings.cache_clear()
        storage._client.cache_clear()


def _peak_rss_mb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS — байты, Linux — килобайты
    return peak / (1024 * 1024) if sys.platform == "darwin" else peak / 1024


@pytest.mark.slow
def test_профиль_demo_пять_миллионов_происшествий(tmp_path: Path) -> None:
    """`pytest -m slow -s tests/test_demo.py`: генерация 5 млн строк и их нормализация."""
    started = time.perf_counter()
    manifest = generate(DirectoryTarget(tmp_path), PROFILES["demo"], only={"incidents"})
    generated = time.perf_counter() - started
    peak = _peak_rss_mb()
    item = entry(manifest, "incidents")
    path = tmp_path / item["file"]
    size_mb = item["bytes"] / 1024 / 1024
    print(
        f"\n«Происшествия», профиль demo: {item['rows']:,} строк, {size_mb:,.0f} МБ за "
        f"{generated:.1f} с ({item['rows'] / generated:,.0f} строк/с); "
        f"пик памяти процесса {peak:.0f} МБ"
    )
    assert item["rows"] == 5_000_000
    assert item["bytes"] < data_import_contract()["limits"]["maxFileBytes"]
    # Цель — минуты, не часы
    assert generated < 600

    analysis = analyze_file(path, path.name, {}, complete=True)
    assert analysis["warnings"] == []
    assert analysis["rowEstimate"] == pytest.approx(5_000_000, rel=0.02)

    run = item["import"]
    started = time.perf_counter()
    result = normalize_file(
        path,
        path.name,
        run["options"],
        run["mapping"],
        run["geometry"],
        run["geometryField"],
        tmp_path / "normalized.csv",
        tmp_path / "errors.csv",
        zone="Asia/Dushanbe",
    )
    normalized = time.perf_counter() - started
    print(
        f"нормализация движком (ADR-0046): {normalized:.1f} с "
        f"({result.rows / normalized:,.0f} строк/с), ошибок {result.errors}"
    )
    assert (result.rows, result.errors, result.written) == (5_000_000, 0, 5_000_000)
