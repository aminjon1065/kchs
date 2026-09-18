"""Производительность нормализации (ADR-0046): 1 млн строк CSV.

Долгая проверка, в CI не запускается: `pytest -m slow -s tests/test_data_perf.py`.
Печатает время разбора и пиковую память процесса.
"""

import resource
import sys
import time
from pathlib import Path

import pytest

from kchs_engine.data.normalize import normalize_file

ROWS = 1_000_000
DISTRICTS = [
    "Вахдат",
    "Рудаки",
    "Гиссар",
    "Турсунзаде",
    "Шахринав",
    "Варзоб",
    "Файзабад",
    "Рогун",
    "Нурек",
    "Яван",
    "Дангара",
    "Куляб",
]


def _peak_rss_mb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS — байты, Linux — килобайты
    return peak / (1024 * 1024) if sys.platform == "darwin" else peak / 1024


def _generate(path: Path) -> None:
    with path.open("w", encoding="utf-8", newline="") as stream:
        stream.write("Код;Район;Дата;Сумма;Количество;Обследован;Широта;Долгота;Примечание\n")
        batch = []
        for index in range(ROWS):
            lat = f"{37 + (index % 3000) / 1000:.4f}".replace(".", ",")
            lon = f"{67 + (index % 5000) / 1000:.4f}".replace(".", ",")
            # Суммы с разделителем тысяч «12 345,67» и без него «0,05»
            amount = f"{index % 100_000:,}".replace(",", " ") + f",{index % 100:02d}"
            batch.append(
                f"{index};{DISTRICTS[index % 12]};{index % 28 + 1:02d}.{index % 12 + 1:02d}.2025;"
                f"{amount};{index % 1000};"
                f"{'да' if index % 2 else 'нет'};{lat};{lon};запись {index}\n"
            )
            if len(batch) == 10_000:
                stream.write("".join(batch))
                batch.clear()
        stream.write("".join(batch))


@pytest.mark.slow
def test_нормализация_миллиона_строк_csv(tmp_path: Path) -> None:
    source = tmp_path / "million.csv"
    started = time.perf_counter()
    _generate(source)
    generated = time.perf_counter() - started
    types = [
        ("kod", "integer"),
        ("rayon", "text"),
        ("data", "date"),
        ("summa", "number"),
        ("kolichestvo", "integer"),
        ("obsledovan", "boolean"),
        ("shirota", "number"),
        ("dolgota", "number"),
        ("primechanie", "text"),
    ]
    mapping = [
        {
            "column": index,
            "fieldKey": key,
            "label": {"ru": key},
            "type": kind,
            "semantic": "dimension",
        }
        for index, (key, kind) in enumerate(types)
    ]
    started = time.perf_counter()
    result = normalize_file(
        source,
        source.name,
        {},
        mapping,
        {"kind": "latlon", "lat": 6, "lon": 7},
        "geom",
        tmp_path / "normalized.csv",
        tmp_path / "errors.csv",
        zone="Asia/Dushanbe",
    )
    elapsed = time.perf_counter() - started
    size_mb = source.stat().st_size / 1024 / 1024
    print(
        f"\nнормализация {ROWS:,} строк CSV ({size_mb:.0f} МБ, 9 полей + геометрия): "
        f"{elapsed:.1f} с ({ROWS / elapsed:,.0f} строк/с); "
        f"генерация файла {generated:.1f} с; пик памяти процесса {_peak_rss_mb():.0f} МБ"
    )
    assert (result.rows, result.errors, result.written) == (ROWS, 0, ROWS)
    with (tmp_path / "normalized.csv").open(encoding="utf-8") as stream:
        first = stream.readline()
    assert first.startswith('"2","0","Вахдат","2025-01-01","0.00","0","false"')
    assert first.rstrip().endswith('"SRID=4326;POINT(67 37)"')
    # «В пределах нескольких минут» (ADR-0046) — с запасом на медленный стенд
    assert elapsed < 300
