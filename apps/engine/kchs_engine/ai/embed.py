"""Векторы текста для поиска по смыслу (13-search-knowledge-ai.md §1, ADR-0099).

Модель задаётся `ENGINE_EMBEDDING_MODEL`; пустое значение — функция выключена,
и api получает «недоступно», а не ошибку. Веса скачиваются при первом вызове,
поэтому модель держится в памяти процесса между запросами.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from kchs_engine.config import settings
from kchs_engine.logging import log

# Длинный кусок модель всё равно обрежет — режем сами, чтобы не тратить время
MAX_CHARS = 8000


@dataclass
class Vectors:
    """Ответ движка: модель, размерность и векторы в порядке входных строк."""

    model: str
    dim: int
    vectors: list[list[float]]

    def as_payload(self) -> dict[str, Any]:
        return {"model": self.model, "dim": self.dim, "vectors": self.vectors}


def embeddings_enabled() -> bool:
    return bool(settings().ENGINE_EMBEDDING_MODEL.strip())


@lru_cache(maxsize=1)
def _model() -> Any:
    from fastembed import TextEmbedding  # тяжёлый импорт — только при первом вызове

    name = settings().ENGINE_EMBEDDING_MODEL.strip()
    log.info("embeddings.loading", model=name)
    return TextEmbedding(model_name=name)


def embed(texts: list[str]) -> Vectors:
    """Считает векторы; вызывающий обязан сам проверить `embeddings_enabled()`."""
    name = settings().ENGINE_EMBEDDING_MODEL.strip()
    prepared = [text[:MAX_CHARS] for text in texts]
    vectors = [list(map(float, vector)) for vector in _model().embed(prepared)]
    dim = len(vectors[0]) if vectors else 0
    return Vectors(model=name, dim=dim, vectors=vectors)
