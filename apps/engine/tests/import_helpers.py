"""Общие помощники тестов импорта датасетов (ADR-0046)."""

import csv
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from kchs_engine.contracts import data_import_contract
from kchs_engine.data.analyze import analyze_file
from kchs_engine.data.normalize import NormalizeResult, normalize_file

ANALYSIS_KEYS = {
    "format",
    "encoding",
    "delimiter",
    "decimal",
    "thousands",
    "dateOrder",
    "sheets",
    "sheet",
    "skipRows",
    "headerRows",
    "rowEstimate",
    "approx",
    "columns",
    "preview",
    "geometry",
    "warnings",
}
COLUMN_KEYS = {"index", "name", "key", "type", "semantic", "emptyShare", "unique", "invalid"}
FORMAT_KEYS = {"precision", "thousands", "dateFormat", "currency", "scale", "prefix", "suffix"}
KEY_PATTERN = re.compile(r"[a-z_][a-z0-9_]*")


def assert_contract(analysis: dict[str, Any]) -> None:
    """Ответ анализа соответствует `ImportAnalysis` контракта (packages/contracts)."""
    contract = data_import_contract()
    limits = contract["limits"]
    assert set(analysis) == ANALYSIS_KEYS
    assert analysis["format"] in contract["formats"]
    assert analysis["decimal"] in (".", ",", None)
    assert analysis["dateOrder"] in ("dmy", "mdy", "ymd", None)
    assert all(set(sheet) == {"name", "rows"} for sheet in analysis["sheets"])
    assert isinstance(analysis["rowEstimate"], int) and analysis["rowEstimate"] >= 0
    assert isinstance(analysis["approx"], bool)
    assert len(analysis["preview"]) <= limits["previewRows"]
    for row in analysis["preview"]:
        assert all(cell is None or isinstance(cell, str) for cell in row)
    assert all(isinstance(warning, str) and warning for warning in analysis["warnings"])
    seen_keys = set()
    for item in analysis["columns"]:
        assert COLUMN_KEYS <= set(item) <= COLUMN_KEYS | {"format", "samples"}
        assert item["type"] in contract["fieldTypes"]
        assert item["semantic"] in contract["semantics"]
        assert KEY_PATTERN.fullmatch(item["key"]) and len(item["key"]) <= 64
        assert not item["key"].startswith("_")
        assert item["key"] not in seen_keys
        seen_keys.add(item["key"])
        assert 0 <= item["emptyShare"] <= 1
        assert isinstance(item["invalid"], int) and item["invalid"] >= 0
        assert len(item["samples"]) <= limits["samplesPerColumn"]
        assert set(item.get("format", {})) <= FORMAT_KEYS
    geometry = analysis["geometry"]
    if geometry is not None:
        expected = {"latlon": {"lat", "lon"}, "wkt": {"column"}, "geojson": {"column"}}
        assert set(geometry) == {"kind"} | expected.get(geometry["kind"], set())


def analyze(path: Path, options: dict[str, Any] | None = None) -> dict[str, Any]:
    analysis = analyze_file(path, path.name, options or {}, complete=True)
    assert_contract(analysis)
    return analysis


def column(analysis: dict[str, Any], name: str) -> dict[str, Any]:
    return next(item for item in analysis["columns"] if item["name"] == name)


def mapping_from(
    analysis: dict[str, Any], overrides: dict[str, dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    """Сопоставление «как предложил анализ»: все столбцы, их ключи и типы."""
    items = []
    for item in analysis["columns"]:
        entry: dict[str, Any] = {
            "column": item["index"],
            "fieldKey": item["key"],
            "label": {"ru": item["name"]},
            "type": item["type"],
            "semantic": item["semantic"],
        }
        if "format" in item:
            entry["format"] = item["format"]
        entry.update((overrides or {}).get(item["key"], {}))
        items.append(entry)
    return items


def parse_copy_csv(text: str) -> list[list[str | None]]:
    """Нормализованный CSV как его прочтёт COPY: пустое без кавычек — NULL, "" — пустая строка."""
    rows: list[list[str | None]] = []
    row: list[str | None] = []
    position, length = 0, len(text)
    while position < length:
        if text[position] == '"':
            position += 1
            parts = []
            while True:
                end = text.index('"', position)
                parts.append(text[position:end])
                if end + 1 < length and text[end + 1] == '"':
                    parts.append('"')
                    position = end + 2
                    continue
                position = end + 1
                break
            row.append("".join(parts))
        else:
            end = position
            while end < length and text[end] not in ",\n":
                end += 1
            raw = text[position:end]
            row.append(raw if raw else None)
            position = end
        if position < length and text[position] == ",":
            position += 1
            continue
        if position < length and text[position] == "\n":
            rows.append(row)
            row = []
            position += 1
    if row:
        rows.append(row)
    return rows


@dataclass
class Normalized:
    result: NormalizeResult
    rows: list[list[str | None]]
    errors: list[dict[str, str]]
    text: str


def normalize(
    path: Path,
    mapping: list[dict[str, Any]],
    *,
    options: dict[str, Any] | None = None,
    geometry: dict[str, Any] | None = None,
    geometry_field: str | None = None,
    territories: dict[str, str] | None = None,
) -> Normalized:
    normalized = path.with_name(path.name + ".normalized.csv")
    errors = path.with_name(path.name + ".errors.csv")
    result = normalize_file(
        path,
        path.name,
        options or {},
        mapping,
        geometry,
        geometry_field,
        normalized,
        errors,
        zone="Asia/Dushanbe",
        territories=territories,
    )
    text = normalized.read_text(encoding="utf-8")
    with errors.open(encoding="utf-8", newline="") as stream:
        error_rows = list(csv.DictReader(stream))
    return Normalized(result, parse_copy_csv(text), error_rows, text)
