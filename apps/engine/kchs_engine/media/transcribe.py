"""Расшифровка записи встречи через faster-whisper (ADR-0092).

Модель задаётся `ENGINE_TRANSCRIBE_MODEL`; пустое значение — функция выключена,
и api получает `unavailable`, а не ошибку задания. Веса модели скачиваются при
первом запуске, поэтому модель держится в памяти процесса между заданиями.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from kchs_engine.config import settings
from kchs_engine.contracts import media_transcribe_contract
from kchs_engine.logging import log

# Whisper работает с моно 16 кГц: приводим к нему ffmpeg'ом, а не в Python
SAMPLE_RATE = 16_000


@dataclass
class Segment:
    """Фраза расшифровки: секунды от начала записи (клик по фразе — перемотка)."""

    start: float
    end: float
    text: str
    speaker: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "text": self.text,
            "speaker": self.speaker,
        }


@dataclass
class Transcript:
    status: str
    language: str | None = None
    model: str | None = None
    duration_s: float | None = None
    segments: list[Segment] = field(default_factory=list)
    error: str | None = None

    def as_payload(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "language": self.language,
            "model": self.model,
            "durationSeconds": self.duration_s,
            "segments": [segment.as_dict() for segment in self.segments],
            "error": self.error,
        }


def transcribe_enabled() -> bool:
    return bool(settings().ENGINE_TRANSCRIBE_MODEL.strip())


_model: Any = None


def _load_model() -> Any:
    """Модель CTranslate2 держится в процессе: загрузка дороже самой расшифровки."""
    global _model
    if _model is not None:
        return _model
    config = settings()
    # Импорт внутри функции: без модели пакет faster-whisper не нужен вовсе
    from faster_whisper import WhisperModel

    _model = WhisperModel(
        config.ENGINE_TRANSCRIBE_MODEL.strip(),
        device=config.ENGINE_TRANSCRIBE_DEVICE,
        compute_type=config.ENGINE_TRANSCRIBE_COMPUTE,
    )
    return _model


def extract_audio(source: Path, target: Path) -> Path:
    """Звуковая дорожка записи: моно 16 кГц WAV — то, что ждёт модель."""
    # Аргументы формирует движок, а не пользователь: список без оболочки
    result = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-f",
            "wav",
            str(target),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0 or not target.exists():
        raise RuntimeError(f"ffmpeg не извлёк звук: {result.stderr.strip()[:500]}")
    return target


def _language() -> str | None:
    """Язык из настроек, если он в списке поддерживаемых; иначе — определять."""
    wanted = settings().ENGINE_TRANSCRIBE_LANGUAGE.strip().lower()
    languages: list[str] = list(media_transcribe_contract()["languages"])
    return wanted if wanted in languages else None


def transcribe(audio: Path) -> Transcript:
    """Расшифровка звуковой дорожки: сегменты с таймкодами.

    Диаризация (кто говорит) здесь не делается: composite-дорожка комнаты
    сводит участников в один канал, а отдельная модель разделения дикторов
    стоит дороже самой расшифровки. Поле спикера остаётся пустым (ADR-0092).
    """
    config = settings()
    if not transcribe_enabled():
        return Transcript(status="unavailable", error="модель распознавания речи не настроена")

    model_name = config.ENGINE_TRANSCRIBE_MODEL.strip()
    model = _load_model()
    max_segments = int(media_transcribe_contract()["maxSegments"])
    segments_iter, info = model.transcribe(
        str(audio),
        language=_language(),
        # Тишина между репликами не попадает в сегменты и не «галлюцинирует»
        vad_filter=True,
        beam_size=5,
    )

    segments: list[Segment] = []
    for item in segments_iter:
        text = (item.text or "").strip()
        if not text:
            continue
        segments.append(Segment(start=float(item.start), end=float(item.end), text=text))
        if len(segments) >= max_segments:
            log.warning("transcribe.truncated", segments=len(segments))
            break

    duration = float(getattr(info, "duration", 0.0) or 0.0)
    return Transcript(
        status="ready",
        language=getattr(info, "language", None),
        model=model_name,
        duration_s=duration or None,
        segments=segments,
    )
