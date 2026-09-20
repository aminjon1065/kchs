"""Векторы для поиска по смыслу (ADR-0099).

Настоящая модель в проверках не участвует: без `ENGINE_EMBEDDING_MODEL`
функция выключена, а с моделью — подменяется заглушкой.
"""

from typing import Any

import pytest
from fastapi.testclient import TestClient

from kchs_engine.ai import embed as embed_module
from kchs_engine.config import settings
from kchs_engine.main import app

TOKEN = "test-service-token-32-characters!!"


@pytest.fixture(autouse=True)
def service_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TOKEN)
    settings.cache_clear()
    yield
    settings.cache_clear()


def test_disabled_without_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENGINE_EMBEDDING_MODEL", "")
    settings.cache_clear()
    assert embed_module.embeddings_enabled() is False

    with TestClient(app) as client:
        response = client.post(
            "/ai/embed",
            json={"texts": ["паводок"]},
            headers={"x-kchs-service-token": TOKEN},
        )
    assert response.status_code == 503


def test_embeds_texts_with_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENGINE_EMBEDDING_MODEL", "BAAI/bge-m3")
    settings.cache_clear()

    class FakeModel:
        def embed(self, texts: list[str]) -> list[list[float]]:
            return [[float(len(text))] * 1024 for text in texts]

    embed_module._model.cache_clear()
    monkeypatch.setattr(embed_module, "_model", lambda: FakeModel())

    result = embed_module.embed(["паводок", "сель"])
    assert result.model == "BAAI/bge-m3"
    assert result.dim == 1024
    assert len(result.vectors) == 2

    with TestClient(app) as client:
        response = client.post(
            "/ai/embed",
            json={"texts": ["паводок"]},
            headers={"x-kchs-service-token": TOKEN},
        )
    assert response.status_code == 200
    payload: dict[str, Any] = response.json()
    assert payload["dim"] == 1024
    assert len(payload["vectors"]) == 1


def test_requires_service_token() -> None:
    with TestClient(app) as client:
        response = client.post("/ai/embed", json={"texts": ["паводок"]})
    assert response.status_code in (401, 403)


def test_long_text_is_cut() -> None:
    assert len("x" * 20_000) > embed_module.MAX_CHARS
