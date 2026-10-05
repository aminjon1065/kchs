"""Реестр обработчиков заданий.

Ключ — `<очередь>:<имя задания>`; так же, как в TypeScript-воркере
(02-platform-kernel.md §9). Обработчик регистрируется только для задания из
контракта (`ENGINE_JOBS`, ADR-0190) и проверяет его нагрузку на входе, а
результат — на выходе.
"""

import functools
from collections.abc import Callable, Coroutine
from typing import Any

from pydantic import ValidationError

from kchs_engine.contracts import engine_queues
from kchs_engine.contracts.jobs import JOB_CONTRACTS, JobContract, contract_errors

JobHandler = Callable[[dict[str, Any]], Coroutine[Any, Any, dict[str, Any]]]

JOB_HANDLERS: dict[str, JobHandler] = {}


class PermanentJobError(RuntimeError):
    """Сбой, который повтор не исправит (файл не читается): задание завершается сразу.

    Текст — причина по-русски, её увидит пользователь.
    """


def _checked(key: str, contract: JobContract, func: JobHandler) -> JobHandler:
    """Обработчик с проверкой контракта: нагрузка до работы, результат после.

    Нагрузка не по контракту — повтор не поможет; результат не по контракту —
    ошибка движка, которую api всё равно не прочтёт.
    """

    @functools.wraps(func)
    async def run(data: dict[str, Any]) -> dict[str, Any]:
        try:
            contract.payload.validate_python(data)
        except ValidationError as error:
            raise PermanentJobError(
                f"Задание {key} не по контракту: {contract_errors(error)}"
            ) from error
        result = await func(data)
        try:
            contract.result.validate_python(result)
        except ValidationError as error:
            raise PermanentJobError(
                f"Результат задания {key} не по контракту: {contract_errors(error)}"
            ) from error
        return result

    return run


def handler(queue: str, name: str) -> Callable[[JobHandler], JobHandler]:
    """Регистрирует обработчик задания; возвращает его с проверкой контракта."""

    def decorator(func: JobHandler) -> JobHandler:
        key = f"{queue}:{name}"
        if queue not in engine_queues():
            # BullMQ отдаёт задание любому потребителю очереди: чужая очередь
            # означала бы перехват заданий TypeScript-воркера (ADR-0035)
            raise ValueError(
                f"Очередь {queue} исполняет TypeScript-воркер, обработчик {key} недопустим"
            )
        if key in JOB_HANDLERS:
            raise ValueError(f"Обработчик задания {key} уже зарегистрирован")
        contract = JOB_CONTRACTS.get(key)
        if contract is None:
            raise ValueError(
                f"Задания {key} нет в контракте: сначала ENGINE_JOBS в packages/contracts"
            )
        checked = _checked(key, contract, func)
        JOB_HANDLERS[key] = checked
        return checked

    return decorator


def registered_queues() -> set[str]:
    return {key.split(":", 1)[0] for key in JOB_HANDLERS}
