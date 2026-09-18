from kchs_engine.jobs import JOB_HANDLERS, registered_queues
from kchs_engine.jobs.echo import echo


async def test_echo_returns_payload() -> None:
    result = await echo({"message": "проверка"})
    assert result["echo"] == "проверка"
    assert "engineVersion" in result


def test_handler_registered() -> None:
    assert "transform:engine.echo" in JOB_HANDLERS
    assert "transform" in registered_queues()
