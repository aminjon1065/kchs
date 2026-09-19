from kchs_engine.jobs import JOB_HANDLERS, registered_queues
from kchs_engine.jobs.echo import echo


async def test_echo_returns_payload() -> None:
    result = await echo({"message": "проверка"})
    assert result["echo"] == "проверка"
    assert "engineVersion" in result


def test_handler_registered() -> None:
    assert "transform:engine.echo" in JOB_HANDLERS
    assert "transform" in registered_queues()


def test_report_render_handler_registered() -> None:
    # Рендер отчётов — очередь render движка (ADR-0035, ADR-0078)
    import kchs_engine.render.report  # noqa: F401

    assert "render:report.render" in JOB_HANDLERS


def test_queue_ownership_matches_contracts() -> None:
    from kchs_engine.contracts import engine_queues, queue_runtime

    runtimes = queue_runtime()
    assert set(runtimes.values()) <= {"worker", "engine"}
    assert "imports" in engine_queues()
    assert "maintenance" not in engine_queues()
    # Все очереди движка, где есть обработчики, принадлежат движку
    assert registered_queues() <= engine_queues()


def test_handler_in_worker_queue_is_rejected() -> None:
    import pytest

    from kchs_engine.jobs.registry import handler

    with pytest.raises(ValueError, match="TypeScript-воркер"):

        @handler("maintenance", "engine.misplaced")
        async def misplaced(data: dict[str, object]) -> dict[str, object]:
            return data
