"""Реестр обработчиков заданий.

Ключ — `<очередь>:<имя задания>`; так же, как в TypeScript-воркере
(02-platform-kernel.md §9).
"""

from collections.abc import Awaitable, Callable
from typing import Any

JobHandler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]

JOB_HANDLERS: dict[str, JobHandler] = {}


def handler(queue: str, name: str) -> Callable[[JobHandler], JobHandler]:
    """Регистрирует обработчик задания."""

    def decorator(func: JobHandler) -> JobHandler:
        key = f"{queue}:{name}"
        if key in JOB_HANDLERS:
            raise ValueError(f"Обработчик задания {key} уже зарегистрирован")
        JOB_HANDLERS[key] = func
        return func

    return decorator


def registered_queues() -> set[str]:
    return {key.split(":", 1)[0] for key in JOB_HANDLERS}
