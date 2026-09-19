"""Конфигурация движка: те же переменные окружения, что у api."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=True)

    NODE_ENV: str = "development"
    LOG_LEVEL: str = "info"
    # Пояс организации: даты и время без смещения в файлах импорта — в нём
    TZ: str = "Asia/Dushanbe"

    REDIS_URL: str = "redis://localhost:6379"
    DATABASE_URL: str = ""

    S3_ENDPOINT: str = "http://localhost:9000"
    S3_REGION: str = "us-east-1"
    S3_ACCESS_KEY: str = ""
    S3_SECRET_KEY: str = ""
    S3_BUCKET_FILES: str = "kchs-files"
    S3_BUCKET_PREVIEWS: str = "kchs-previews"
    S3_BUCKET_EXPORTS: str = "kchs-exports"

    KCHS_API_URL: str = "http://localhost:3000"
    INTERNAL_SERVICE_TOKEN: str = ""

    ENGINE_PORT: int = 8000
    ENGINE_CONCURRENCY: int = 4

    # Печать отчётов (ADR-0078): адрес веба, который открывает Chromium движка
    # (страница `/print/report/<запуск>`), и сколько страниц печатается сразу
    KCHS_WEB_URL: str = "http://localhost:5173"
    ENGINE_RENDER_CONCURRENCY: int = 2
    # Предел одного рендера, с: загрузка, готовность страницы, PDF и DOCX
    ENGINE_RENDER_TIMEOUT_S: int = 240


@lru_cache
def settings() -> Settings:
    return Settings()
