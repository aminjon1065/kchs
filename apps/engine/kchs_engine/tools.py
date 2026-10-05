"""Окружение внешних программ движка (ADR-0176).

LibreOffice, poppler, tesseract, ffmpeg и Chromium разбирают недоверенные файлы.
Секреты движка (ключи хранилища, пароль Redis, сервисный токен, адрес базы) им не
нужны и не передаются: окружение собирается по белому списку, а не наследуется.
Новая переменная окружения движка поэтому не попадёт к программам сама собой.
"""

import os
from urllib.parse import urlsplit

from kchs_engine.config import settings

# Без этого программы не работают или работают иначе: поиск исполняемых файлов,
# профиль и временные каталоги, язык и пояс, шрифты и данные распознавания
PASSED_VARIABLES = (
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    "FONTCONFIG_FILE",
    "FONTCONFIG_PATH",
    "TESSDATA_PREFIX",
    "OMP_THREAD_LIMIT",
    "OMP_NUM_THREADS",
    "LD_LIBRARY_PATH",
)

DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin"


def tool_env() -> dict[str, str]:
    """Окружение для `subprocess` и браузера: только переменные из белого списка."""
    env = {name: value for name in PASSED_VARIABLES if (value := os.environ.get(name)) is not None}
    env.setdefault("PATH", DEFAULT_PATH)
    return env


def broad_access_warnings() -> list[str]:
    """Права шире нужного (установка до ADR-0176): пароль Redis по умолчанию с доступом
    ко всем ключам и ключ администратора хранилища. Список — для журнала при старте."""
    config = settings()
    warnings: list[str] = []
    if not urlsplit(config.REDIS_URL).username:
        warnings.append(
            "Redis: общий пароль, доступ ко всем ключам — задайте REDIS_ENGINE_PASSWORD "
            "(generate-secrets.sh --add-missing)"
        )
    if config.ENGINE_S3_SCOPED != "yes":
        warnings.append(
            "Хранилище: ключ администратора — задайте S3_ENGINE_ACCESS_KEY и "
            "S3_ENGINE_SECRET_KEY (generate-secrets.sh --add-missing)"
        )
    return warnings
