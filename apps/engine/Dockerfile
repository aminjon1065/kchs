# Вычислительный движок kchs.
# Системные библиотеки вынесены в отдельный слой: он меняется редко и кэшируется.
FROM python:3.12-slim-bookworm AS system

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl \
        gdal-bin libgdal-dev \
        libgeos-dev libproj-dev \
        ffmpeg \
        tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng \
        poppler-utils \
        libreoffice-core libreoffice-writer libreoffice-calc \
        fonts-dejavu fonts-liberation; \
    rm -rf /var/lib/apt/lists/*

# ── Зависимости Python ───────────────────────────────────────────────────────
FROM system AS deps

COPY --from=ghcr.io/astral-sh/uv:0.9.7 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml ./
RUN uv venv /opt/venv && VIRTUAL_ENV=/opt/venv uv pip install --no-cache -e '.[data,gis,dev]'

# ── Итоговый образ ───────────────────────────────────────────────────────────
FROM system AS runtime

COPY --from=deps /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" \
    VIRTUAL_ENV=/opt/venv

WORKDIR /app
COPY . .
RUN pip install --no-deps --no-cache-dir -e . \
 && useradd --system --uid 10001 --create-home kchs \
 && chown -R kchs:kchs /app
USER kchs

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "kchs_engine.main:app", "--host", "0.0.0.0", "--port", "8000"]
