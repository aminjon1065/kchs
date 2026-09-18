"""Проверочное задание: подтверждает сквозной путь api → очередь → движок."""

from typing import Any

from kchs_engine import __version__
from kchs_engine.jobs.registry import handler
from kchs_engine.logging import log


@handler("transform", "engine.echo")
async def echo(data: dict[str, Any]) -> dict[str, Any]:
    log.info("engine.echo", payload=data)
    return {"echo": data.get("message", ""), "engineVersion": __version__}
