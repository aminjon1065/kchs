"""Надёжность заданий движка (ADR-0172): отчёт о статусе повторяется, отмена
видна до начала и во время работы обработчика."""

import asyncio
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from kchs_engine import api, cancel, worker
from kchs_engine.config import settings


@pytest.fixture
def token(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "test-token")
    settings.cache_clear()
    monkeypatch.setattr(api, "_RETRY_DELAYS", (0.0, 0.0, 0.0))
    yield
    settings.cache_clear()


def fake_api(monkeypatch: pytest.MonkeyPatch, statuses: list[int]) -> list[str]:
    """api отвечает по очереди кодами `statuses`; возвращает журнал запросов."""
    calls: list[str] = []
    replies = iter(statuses)

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(next(replies), json={"ok": True})

    real_client = httpx.AsyncClient

    def client(**kwargs: Any) -> httpx.AsyncClient:
        return real_client(transport=httpx.MockTransport(handle), **kwargs)

    monkeypatch.setattr(api.httpx, "AsyncClient", client)
    return calls


async def test_отчёт_повторяется_при_сбое_api(token: None, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = fake_api(monkeypatch, [503, 502, 200])
    assert await api._post("/api/v1/internal/jobs/x/status", {"status": "succeeded"}) is True
    assert len(calls) == 3


async def test_отчёт_не_повторяется_при_ошибке_запроса(
    token: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = fake_api(monkeypatch, [400, 200])
    assert await api._post("/api/v1/internal/jobs/x/status", {"status": "succeeded"}) is False
    assert len(calls) == 1


async def test_прогресс_не_повторяется(token: None, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = fake_api(monkeypatch, [503, 200])
    await api.report_progress("x", 0.5, "половина")
    assert len(calls) == 1


async def test_исчерпанные_попытки_не_роняют_задание(
    token: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = fake_api(monkeypatch, [503, 503, 503, 503])
    assert await api._post("/api/v1/internal/jobs/x/status", {"status": "running"}) is False
    assert len(calls) == 4


async def test_отмена_прерывает_обработчик(monkeypatch: pytest.MonkeyPatch) -> None:
    checks = {"count": 0}

    async def cancelled(_job_id: str) -> bool:
        checks["count"] += 1
        return checks["count"] >= 2

    monkeypatch.setattr(cancel, "is_cancelled", cancelled)
    reached_end = asyncio.Event()

    async def slow() -> dict[str, Any]:
        await asyncio.sleep(10)
        reached_end.set()
        return {"done": True}

    was_cancelled, result = await cancel.run_cancellable("job-1", slow(), poll_seconds=0.01)
    assert was_cancelled is True
    assert result is None
    assert not reached_end.is_set()


async def test_без_отмены_результат_обработчика(monkeypatch: pytest.MonkeyPatch) -> None:
    async def never(_job_id: str) -> bool:
        return False

    monkeypatch.setattr(cancel, "is_cancelled", never)

    async def quick() -> dict[str, Any]:
        await asyncio.sleep(0.02)
        return {"done": True}

    assert await cancel.run_cancellable("job-2", quick(), poll_seconds=0.01) == (
        False,
        {"done": True},
    )


async def test_ошибка_обработчика_поднимается(monkeypatch: pytest.MonkeyPatch) -> None:
    async def never(_job_id: str) -> bool:
        return False

    monkeypatch.setattr(cancel, "is_cancelled", never)

    async def broken() -> dict[str, Any]:
        raise RuntimeError("файл не читается")

    with pytest.raises(RuntimeError, match="не читается"):
        await cancel.run_cancellable("job-3", broken(), poll_seconds=0.01)


def fake_job() -> SimpleNamespace:
    """Задание BullMQ в той мере, в какой его читает `_run`."""
    return SimpleNamespace(
        name="engine.echo", data={"jobRecordId": "rec-1"}, attemptsMade=0, attempts=1
    )


async def test_отменённое_задание_не_начинается(monkeypatch: pytest.MonkeyPatch) -> None:
    async def cancelled(_job_id: str) -> bool:
        return True

    started: list[str] = []

    async def report_started(job_id: str) -> None:
        started.append(job_id)

    async def handler(_data: dict[str, Any]) -> dict[str, Any]:
        raise AssertionError("отменённое задание не исполняется")

    monkeypatch.setattr(worker, "is_cancelled", cancelled)
    monkeypatch.setattr(worker, "report_started", report_started)
    result = await worker._run("transform", fake_job(), handler, "rec-1")  # type: ignore[arg-type]
    assert result == {"cancelled": True}
    assert started == []


async def test_исход_уходит_результатом_очереди(monkeypatch: pytest.MonkeyPatch) -> None:
    async def never(_job_id: str) -> bool:
        return False

    reported: list[dict[str, Any]] = []

    async def noop(_job_id: str) -> None:
        return None

    async def report_result(_job_id: str, result: dict[str, Any]) -> None:
        reported.append(result)

    async def handler(data: dict[str, Any]) -> dict[str, Any]:
        return {"echo": data["jobRecordId"]}

    monkeypatch.setattr(worker, "is_cancelled", never)
    monkeypatch.setattr(cancel, "is_cancelled", never)
    monkeypatch.setattr(worker, "report_started", noop)
    monkeypatch.setattr(worker, "report_result", report_result)
    result = await worker._run("transform", fake_job(), handler, "rec-1")  # type: ignore[arg-type]
    # Тот же исход — и отчётом api, и возвращаемым значением задания BullMQ
    assert result == {"echo": "rec-1"}
    assert reported == [{"echo": "rec-1"}]
