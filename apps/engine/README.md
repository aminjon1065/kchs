# kchs engine

Вычислительный движок: импорт данных и геоформатов (GDAL/pyogrio), преобразования
(pandas/DuckDB), рендеринг отчётов и карт (Playwright, docxtpl/LibreOffice),
извлечение текста и OCR (tesseract), расшифровка речи (faster-whisper),
эмбеддинги и обращения к LLM.

Движок **не содержит доменной логики и не принимает решений о правах**: задания
приходят с уже проверенным контекстом (02-architecture/01-overview.md).

## Запуск

```bash
uv sync --extra dev
uv run uvicorn kchs_engine.main:app --port 8000
uv run pytest
uv run ruff check .
```
