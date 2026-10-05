"""Контракты, сгенерированные из `packages/contracts` (источник правды — TypeScript).

Файлы рядом с модулем создаёт `pnpm --filter @kchs/contracts gen:engine`;
CI проверяет, что они совпадают с TypeScript-схемами.
"""

import json
from functools import lru_cache
from importlib.resources import files
from typing import Any


def _load(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((files(__package__) / name).read_text(encoding="utf-8"))
    return data


@lru_cache
def queue_runtime() -> dict[str, str]:
    """Очередь → исполнитель (`worker` или `engine`), ADR-0035."""
    return dict(_load("queues.json")["queues"])


def engine_queues() -> set[str]:
    return {queue for queue, runtime in queue_runtime().items() if runtime == "engine"}


@lru_cache
def users_import_contract() -> dict[str, Any]:
    """Столбцы, пределы и коды замечаний импорта пользователей (ADR-0041)."""
    return _load("users_import.json")


@lru_cache
def data_import_contract() -> dict[str, Any]:
    """Форматы, типы, пределы и коды ошибок импорта датасетов (ADR-0046)."""
    return _load("data_import.json")


@lru_cache
def data_export_contract() -> dict[str, Any]:
    """Форматы геоэкспорта, которые собирает движок, и предел строк (ADR-0056, ADR-0068)."""
    return _load("data_export.json")


@lru_cache
def report_render_contract() -> dict[str, Any]:
    """Форматы, cookie токена печати и признаки готовности страницы отчёта (ADR-0078)."""
    return _load("report_render.json")


@lru_cache
def media_transcribe_contract() -> dict[str, Any]:
    """Задание расшифровки записи встречи: языки и предел сегментов (ADR-0092)."""
    return _load("media_transcribe.json")


@lru_cache
def document_render_contract() -> dict[str, Any]:
    """Виды рендеров модуля документов и пределы исходника и шаблона (ADR-0085)."""
    return _load("document_render.json")


@lru_cache
def jobs_contract() -> dict[str, Any]:
    """JSON Schema нагрузки и результата заданий движка и его обратных вызовов (ADR-0190).

    Модели движка — `contracts/jobs.py` и `contracts/callbacks.py`; их совместимость
    со схемами отсюда проверяет `tests/test_engine_contracts.py`.
    """
    return _load("jobs.json")


@lru_cache
def field_types_contract() -> dict[str, Any]:
    """Хранение полей датасета и слова «да/нет» — общий реестр с api и компилятором (ADR-0190)."""
    return _load("field_types.json")


def field_storage(kind: str) -> dict[str, Any]:
    """Хранение типа поля: столбец Postgres, тип Arrow копии, тип DuckDB, семейство выгрузки."""
    storage: dict[str, dict[str, Any]] = field_types_contract()["storage"]
    try:
        return storage[kind]
    except KeyError as error:
        raise ValueError(f"тип поля {kind} не хранится в таблице датасета") from error


def fields_of_export_family(family: str) -> frozenset[str]:
    """Типы полей, которые геовыгрузка пишет значениями этого семейства."""
    storage: dict[str, dict[str, Any]] = field_types_contract()["storage"]
    return frozenset(kind for kind, item in storage.items() if item["exportFamily"] == family)
