"""Минимальные права движка (ADR-0176): внешние программы без секретов движка,
предупреждение о правах шире нужного."""

import sys
from collections.abc import Iterator

import pytest

from kchs_engine import tools
from kchs_engine.config import settings
from kchs_engine.files.processing import run

SECRETS = ("DATABASE_QUERY_URL", "S3_SECRET_KEY", "REDIS_URL", "INTERNAL_SERVICE_TOKEN")


@pytest.fixture
def fresh_settings() -> Iterator[None]:
    settings.cache_clear()
    yield
    settings.cache_clear()


def test_внешняя_программа_не_видит_секретов(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (*SECRETS, "KCHS_NEW_SECRET"):
        monkeypatch.setenv(name, "секрет-движка")
    monkeypatch.setenv("LANG", "C.UTF-8")
    env = tools.tool_env()
    assert "секрет-движка" not in env.values()
    assert env["LANG"] == "C.UTF-8"
    assert env["PATH"]
    # Тот же путь, которым запускаются LibreOffice, poppler и tesseract
    printed = run([sys.executable, "-c", "import os; print(sorted(os.environ))"], timeout=30)
    for name in (*SECRETS, "KCHS_NEW_SECRET"):
        assert name not in printed


def test_широкие_права_видны_в_журнале(
    monkeypatch: pytest.MonkeyPatch, fresh_settings: None
) -> None:
    monkeypatch.setenv("REDIS_URL", "redis://:общий@redis:6379")
    monkeypatch.delenv("ENGINE_S3_SCOPED", raising=False)
    assert len(tools.broad_access_warnings()) == 2

    monkeypatch.setenv("REDIS_URL", "redis://kchs-engine:свой@redis:6379")
    monkeypatch.setenv("ENGINE_S3_SCOPED", "yes")
    settings.cache_clear()
    assert tools.broad_access_warnings() == []
