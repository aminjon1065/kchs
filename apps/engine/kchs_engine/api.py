"""Обратная связь с api: движок не пишет метаданные напрямую в базу.

Реестр заданий ведёт ядро (02-platform-kernel.md §9), поэтому статус, прогресс
и результат сообщаются внутренним маршрутом. Каждый вызов несёт токен своего
задания (ADR-0176): его api кладёт в данные задания при передаче в очередь, и он
открывает только маршруты этого задания и его ресурса. Общий сервисный токен
внутренние маршруты api не принимают — им движок только проверяет вызовы api.

Пути, тела и ответы — по контракту `ENGINE_CALLBACKS` (ADR-0190): тело движок
проверяет до отправки, ответ — до того, как его прочтёт обработчик.
"""

import asyncio
import re
from contextvars import ContextVar
from typing import Any
from urllib.parse import quote

import httpx
from pydantic import ValidationError

from kchs_engine.config import settings
from kchs_engine.contracts import jobs_contract
from kchs_engine.contracts.callbacks import CALLBACK_CONTRACTS
from kchs_engine.contracts.jobs import contract_errors
from kchs_engine.logging import log

_TIMEOUT = httpx.Timeout(10.0)

JOB_TOKEN_HEADER = "x-kchs-job-token"
# Токен выполняемого задания: воркер ставит его на время обработчика, задачи
# asyncio и потоки `to_thread` получают его вместе с контекстом
JOB_TOKEN: ContextVar[str | None] = ContextVar("kchs_job_token", default=None)
# Задержки повторов отчёта о статусе, с: api перезапускается, сеть моргнула.
# Исчерпанные попытки — не сбой задания: исход api возьмёт из очереди (ADR-0172)
_RETRY_DELAYS: tuple[float, ...] = (0.5, 1.0, 2.0, 4.0)
# Маршруты api — под префиксом версии; пути контракта — без него
API_PREFIX = "/api/v1"
_PATH_PARAM = re.compile(r":[A-Za-z_]\w*")


class CallbackContractError(RuntimeError):
    """Тело или ответ обратного вызова не по контракту: ошибка кода, а не данных."""


def callback_path(name: str, resource: str) -> str:
    """Путь обратного вызова из контракта; единственный параметр — идентификатор ресурса."""
    template = str(jobs_contract()["callbacks"][name]["path"])
    return API_PREFIX + _PATH_PARAM.sub(quote(resource, safe=""), template, count=1)


def checked_body(name: str, body: dict[str, Any]) -> dict[str, Any]:
    """Тело обратного вызова по контракту; тесты проверяют им и поддельные вызовы."""
    adapter = CALLBACK_CONTRACTS[name].body
    if adapter is not None:
        try:
            adapter.validate_python(body)
        except ValidationError as error:
            raise CallbackContractError(
                f"тело обратного вызова {name} не по контракту: {contract_errors(error)}"
            ) from error
    return body


def checked_reply(name: str, reply: dict[str, Any]) -> dict[str, Any]:
    """Ответ api по контракту — до того, как его прочтёт обработчик."""
    try:
        CALLBACK_CONTRACTS[name].reply.validate_python(reply)
    except ValidationError as error:
        raise CallbackContractError(
            f"ответ api на {name} не по контракту: {contract_errors(error)}"
        ) from error
    return reply


async def _post(path: str, payload: dict[str, Any], *, retry: bool = True) -> bool:
    """Отчёт о статусе задания. Сбой сети и ответ 5xx повторяются с задержкой,
    4xx — нет: повтор того же запроса не поможет. Истина — api принял отчёт."""
    config = settings()
    token = JOB_TOKEN.get()
    if not token:
        log.debug("api.skip", path=path, reason="нет токена задания")
        return False
    delays = _RETRY_DELAYS if retry else ()
    for attempt in range(len(delays) + 1):
        try:
            async with httpx.AsyncClient(base_url=config.KCHS_API_URL, timeout=_TIMEOUT) as client:
                response = await client.post(path, json=payload, headers={JOB_TOKEN_HEADER: token})
            if response.status_code < 400:
                return True
            log.warning(
                "api.error",
                path=path,
                status=response.status_code,
                body=response.text[:500],
                attempt=attempt + 1,
            )
            if response.status_code < 500:
                return False
        except httpx.HTTPError as error:
            log.warning("api.unreachable", path=path, error=str(error), attempt=attempt + 1)
        if attempt < len(delays):
            await asyncio.sleep(delays[attempt])
    return False


async def _status(job_id: str, report: dict[str, Any], *, retry: bool = True) -> None:
    path = callback_path("jobStatus", job_id)
    await _post(path, checked_body("jobStatus", report), retry=retry)


async def report_started(job_id: str) -> None:
    await _status(job_id, {"status": "running"})


async def report_progress(job_id: str, progress: float, message: str | None = None) -> None:
    # Прогресс не повторяется: следующий отчёт всё равно новее
    report = {"status": "running", "progress": float(progress), "message": message}
    await _status(job_id, report, retry=False)


async def report_result(job_id: str, result: dict[str, Any]) -> None:
    await _status(job_id, {"status": "succeeded", "result": result})


async def report_failure(job_id: str, error: str, *, final: bool = True) -> None:
    """`final=False` — BullMQ ещё повторит задание; реестр вернёт его в очередь."""
    await _status(job_id, {"status": "failed", "error": error[:4000], "final": final})


async def _post_strict(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Отчёт, без которого задание не завершено: ошибка api → повтор задания."""
    config = settings()
    token = JOB_TOKEN.get()
    if not token:
        raise RuntimeError("у задания нет токена обратного вызова: результат не сообщить")
    timeout = httpx.Timeout(60.0)
    async with httpx.AsyncClient(base_url=config.KCHS_API_URL, timeout=timeout) as client:
        response = await client.post(path, json=payload, headers={JOB_TOKEN_HEADER: token})
    if response.status_code >= 400:
        raise RuntimeError(f"api {path}: {response.status_code} {response.text[:500]}")
    data: dict[str, Any] = response.json()
    return data


async def _call(name: str, resource: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """Обратный вызов по контракту: тело — до отправки, ответ — до чтения."""
    payload = {} if body is None else checked_body(name, body)
    reply = await _post_strict(callback_path(name, resource), payload)
    return checked_reply(name, reply)


async def report_file_processed(file_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    return await _call("fileProcessed", file_id, payload)


async def report_document_pdf(version_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Хэш версии документа и её PDF-представление; файл реестра создаёт api (ADR-0080)."""
    return await _call("documentPdf", version_id, payload)


async def report_transcript(recording_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Сегменты расшифровки записи встречи; хранит их модуль встреч (ADR-0092)."""
    return await _call("recordingTranscript", recording_id, payload)


async def report_users_import_parsed(job_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Строки файла импорта пользователей; API ставит проверку и создание (ADR-0041)."""
    return await _call("usersImportParsed", job_id, payload)


async def report_dataset_normalized(import_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Итог нормализации файла импорта; API ставит воркеру загрузку в датасет (ADR-0046)."""
    return await _call("importNormalized", import_id, payload)


async def report_render_start(run_id: str) -> dict[str, Any]:
    """Служебный токен страницы печати и параметры рендера отчёта (ADR-0078).

    Номер попытки api считает сам: повтор BullMQ приходит тем же запросом.
    """
    return await _call("reportRenderStart", run_id)


async def report_rendered(run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Файлы отчёта в бакете экспортов: api отмечает запуск и рассылает (ADR-0078)."""
    return await _call("reportRendered", run_id, payload)


async def document_render_start(render_id: str) -> dict[str, Any]:
    """План рендера модуля документов с правами заказчика на этот момент (ADR-0085)."""
    return await _call("documentRenderStart", render_id)


async def document_render_done(render_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Результат рендера: файл под выданным ключом, плейсхолдеры шаблона или причина сбоя."""
    return await _call("documentRenderDone", render_id, payload)
