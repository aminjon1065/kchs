"""Демонстрационные данные фазы 1 (P1-E10, 04-verification.md §7).

Генератор пишет файлы, а не строки в базу: сид загружает их через конвейер
импорта (ADR-0046) — файл в S3 → анализ → нормализация в движке → загрузка
воркером. Рядом с файлами — `manifest.json`: для каждого набора название,
формат, число строк, ключ, поле времени и территории, описание и готовое
сопоставление столбцов с полями (`ImportRunInput` без `fileId` и `target`).

Один и тот же seed даёт одинаковые файлы (см. `rng.py`). Запуск:
`python -m kchs_engine.demo --out <каталог|s3://бакет/префикс> --profile demo|small`.
"""

import json
import time
from collections.abc import Callable, Collection, Iterable
from dataclasses import dataclass
from typing import Any

from kchs_engine.demo.datasets import (
    HYDRO_POSTS,
    INCIDENT_TYPES,
    PROTECTED_OBJECTS,
    RISK_ZONES,
    TERRITORIES,
    WATER_LEVELS,
    build_posts,
    csv_text,
    feature_collection,
    incident_type_rows,
    object_features,
    post_rows,
    territory_rows,
    water_lines,
    zone_features,
)
from kchs_engine.demo.incidents import PERIOD_END, PERIOD_START, incident_lines
from kchs_engine.demo.incidents import SPEC as INCIDENTS
from kchs_engine.demo.output import Output, Target
from kchs_engine.demo.spec import DatasetSpec
from kchs_engine.demo.world import build_districts

DEFAULT_SEED = 2026
MANIFEST = "manifest.json"
MANIFEST_FORMAT = "kchs-demo/1"
TIMEZONE = "Asia/Dushanbe"


@dataclass(frozen=True)
class Profile:
    name: str
    # Строк «Происшествий», точек «Объектов защиты», гидропостов в «Уровнях воды»
    incidents: int
    objects: int
    water_posts: int


PROFILES = {
    "small": Profile("small", incidents=50_000, objects=5_000, water_posts=12),
    "demo": Profile("demo", incidents=5_000_000, objects=50_000, water_posts=46),
}

# Порядок загрузки: справочники раньше таблиц, которые на них ссылаются
DATASETS: tuple[DatasetSpec, ...] = (
    TERRITORIES,
    INCIDENT_TYPES,
    HYDRO_POSTS,
    INCIDENTS,
    PROTECTED_OBJECTS,
    RISK_ZONES,
    WATER_LEVELS,
)
DATASET_IDS = tuple(spec.id for spec in DATASETS)


@dataclass(frozen=True)
class Written:
    """Итог записи файла — для журнала и замеров (в манифест время не попадает)."""

    spec: DatasetSpec
    location: str
    rows: int
    bytes: int
    seconds: float


def _write(out: Output, chunks: Iterable[str]) -> None:
    for chunk in chunks:
        out.write(chunk)


def generate(
    target: Target,
    profile: Profile,
    *,
    seed: int = DEFAULT_SEED,
    only: Collection[str] | None = None,
    incidents: int | None = None,
    report: Callable[[Written], None] | None = None,
) -> dict[str, Any]:
    """Файлы наборов и manifest.json в `target`; возвращает манифест.

    `only` — только эти наборы (манифест перечисляет только их), `incidents` —
    число строк «Происшествий» вместо профиля (замеры).
    """
    unknown = set(only or ()) - set(DATASET_IDS)
    if unknown:
        raise ValueError(f"неизвестные наборы: {', '.join(sorted(unknown))}")
    incident_rows = profile.incidents if incidents is None else incidents
    if incident_rows < 1:
        raise ValueError("строк «Происшествий» должно быть не меньше одной")
    districts = build_districts(seed)
    posts = build_posts(districts, seed)
    series_posts = posts[: profile.water_posts]

    def produce(spec: DatasetSpec, out: Output) -> int:
        if spec is TERRITORIES:
            rows = territory_rows(districts)
            _write(out, [spec.csv_header(), csv_text(rows)])
            return len(rows)
        if spec is INCIDENT_TYPES:
            rows = incident_type_rows()
            _write(out, [spec.csv_header(), csv_text(rows)])
            return len(rows)
        if spec is HYDRO_POSTS:
            rows = post_rows(posts)
            _write(out, [spec.csv_header(), csv_text(rows)])
            return len(rows)
        if spec is INCIDENTS:
            _write(out, incident_lines(districts, incident_rows, seed))
            return incident_rows
        if spec is PROTECTED_OBJECTS:
            features = object_features(districts, profile.objects, seed)
            _write(out, feature_collection(spec.name, features))
            return profile.objects
        if spec is RISK_ZONES:
            zones = zone_features(districts, seed)
            _write(out, feature_collection(spec.name, zones))
            return len(zones)
        _write(out, water_lines(series_posts, seed))
        return len(series_posts) * ((PERIOD_END - PERIOD_START).days + 1)

    entries = []
    for spec in DATASETS:
        if only and spec.id not in only:
            continue
        started = time.perf_counter()
        with target.file(spec.file, spec.content_type) as out:
            rows = produce(spec, out)
        entries.append(spec.manifest(rows, out.bytes, out.sha256))
        if report is not None:
            elapsed = time.perf_counter() - started
            report(Written(spec, target.location(spec.file), rows, out.bytes, elapsed))
    manifest = {
        "format": MANIFEST_FORMAT,
        "profile": profile.name,
        "seed": seed,
        "period": {"from": PERIOD_START.isoformat(), "to": PERIOD_END.isoformat()},
        "timezone": TIMEZONE,
        "note": (
            "Синтетические данные для демонстрации и нагрузочных проверок: названия "
            "регионов и районов настоящие, события, объекты, зоны и наблюдения вымышлены."
        ),
        "datasets": entries,
    }
    with target.file(MANIFEST, "application/json") as out:
        out.write(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return manifest
