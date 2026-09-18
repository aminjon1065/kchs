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

## Импорт датасетов (ADR-0046)

- `POST /data/analyze` (сервисный токен `x-kchs-service-token`): тело
  `{bucket, key, fileName, options}` → `ImportAnalysis` контракта по голове файла
  (текстовые форматы — первые 8 МБ, Excel — книга целиком). Файл не читается — 422,
  причина по-русски в `detail`.
- Задание `imports:dataset.normalize`: весь файл потоком → нормализованный CSV (первый
  столбец — номер строки файла, дальше поля сопоставления, геометрия последней) и CSV
  ошибок `row,field,value,code` в хранилище; итог — `POST
  /api/v1/internal/data/imports/{importId}/normalized`. Нечитаемый файл — окончательный
  сбой задания без повторов.

Долгие и внешние проверки в CI не запускаются:

```bash
uv run pytest -m slow -s            # нормализация 1 млн строк CSV, время — в выводе
KCHS_TEST_S3=1 uv run pytest -m s3  # анализ из MinIO разработки (переменные S3_* из .env)
```
