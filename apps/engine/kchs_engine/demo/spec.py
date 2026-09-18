"""Описание наборов демо-данных и запись о них в manifest.json.

Запись манифеста содержит всё, что нужно сиду для загрузки через конвейер
импорта (ADR-0046): `import` — это `ImportRunInput` контракта
(`packages/contracts/src/data/import.ts`) без `fileId` и `target`: параметры
чтения, сопоставление столбцов с полями, геометрия, ключ.
"""

import csv
import io
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

# Поле геометрии нового датасета — как у мастера импорта (geometryFieldKey)
GEOMETRY_FIELD = "geometry"
CSV_TYPE = "text/csv; charset=utf-8"
GEOJSON_TYPE = "application/geo+json"


@dataclass(frozen=True)
class Column:
    """Столбец файла и поле датасета, в которое он загружается."""

    key: str
    # Подпись поля по-русски — она же заголовок столбца в файле
    label: str
    en: str
    type: str
    semantic: str
    format: Mapping[str, Any] | None = None
    required: bool = False


@dataclass(frozen=True)
class Lookup:
    """Предлагаемая связь поля со справочником (подписи вместо кодов)."""

    field: str
    dataset: str
    key_field: str = "code"
    label_field: str = "name"


@dataclass(frozen=True)
class DatasetSpec:
    id: str
    file: str
    name: str
    # table — таблица данных, reference — справочник (DatasetKind контракта)
    kind: str
    description: str
    format: str
    columns: tuple[Column, ...]
    key: tuple[str, ...]
    time_field: str | None = None
    territory_field: str | None = None
    # latlon — точка из столбцов «Широта»/«Долгота», features — геометрия объектов GeoJSON
    geometry: str | None = None
    lookups: tuple[Lookup, ...] = field(default_factory=tuple)

    @property
    def content_type(self) -> str:
        return GEOJSON_TYPE if self.format == "geojson" else CSV_TYPE

    def index(self, key: str) -> int:
        return next(i for i, column in enumerate(self.columns) if column.key == key)

    def csv_header(self) -> str:
        buffer = io.StringIO()
        csv.writer(buffer, lineterminator="\n").writerow(c.label for c in self.columns)
        return buffer.getvalue()

    def _options(self) -> dict[str, Any]:
        """Параметры чтения явно — нормализация не зависит от автоопределения."""
        options: dict[str, Any] = {"format": self.format, "encoding": "utf-8"}
        if self.format == "csv":
            options.update(
                {"delimiter": ",", "skipRows": 0, "headerRows": 1, "decimal": ".", "thousands": ""}
            )
        if any(column.type in ("date", "datetime") for column in self.columns):
            options["dateOrder"] = "ymd"
        return options

    def _geometry(self) -> dict[str, Any] | None:
        if self.geometry == "latlon":
            return {"kind": "latlon", "lat": self.index("lat"), "lon": self.index("lon")}
        if self.geometry == "features":
            return {"kind": "features"}
        return None

    def manifest(self, rows: int, size: int, sha256: str) -> dict[str, Any]:
        mapping = []
        for index, column in enumerate(self.columns):
            item: dict[str, Any] = {
                "column": index,
                "fieldKey": column.key,
                "label": {"ru": column.label, "en": column.en},
                "type": column.type,
                "semantic": column.semantic,
            }
            if column.format:
                item["format"] = dict(column.format)
            item["required"] = column.required
            mapping.append(item)
        geometry = self._geometry()
        run: dict[str, Any] = {"options": self._options(), "mapping": mapping}
        if geometry is not None:
            run["geometry"] = geometry
            run["geometryField"] = GEOMETRY_FIELD
        run["key"] = list(self.key)
        # Демо-данные чистые: ошибка в строке — повод остановиться, а не пропустить
        run["onError"] = "stop"
        return {
            "id": self.id,
            "file": self.file,
            "name": self.name,
            "kind": self.kind,
            "description": self.description,
            "format": self.format,
            "contentType": self.content_type,
            "rows": rows,
            "bytes": size,
            "sha256": sha256,
            "key": list(self.key),
            "timeField": self.time_field,
            "territoryField": self.territory_field,
            "geometryField": GEOMETRY_FIELD if geometry is not None else None,
            "lookups": [
                {
                    "field": lookup.field,
                    "dataset": lookup.dataset,
                    "keyField": lookup.key_field,
                    "labelField": lookup.label_field,
                }
                for lookup in self.lookups
            ],
            "import": run,
        }
