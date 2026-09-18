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
