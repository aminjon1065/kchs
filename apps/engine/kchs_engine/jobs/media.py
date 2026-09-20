"""Задание `media:media.transcribe`: расшифровка записи встречи (ADR-0092).

Движок скачивает запись из хранилища, извлекает звук, распознаёт речь и
сообщает сегменты api — в базу он не пишет. Без настроенной модели задание
выполняется успешно с ответом «функция недоступна»: это не сбой установки.
"""

import asyncio
import tempfile
from pathlib import Path
from typing import Any

from kchs_engine.api import report_transcript
from kchs_engine.config import settings
from kchs_engine.jobs.registry import PermanentJobError, handler
from kchs_engine.logging import log
from kchs_engine.media.transcribe import Transcript, extract_audio, transcribe, transcribe_enabled
from kchs_engine.storage import download


def _run(source: Path, workdir: Path) -> Transcript:
    """Блокирующая часть: ffmpeg и модель — в отдельном потоке."""
    audio = extract_audio(source, workdir / "audio.wav")
    return transcribe(audio)


@handler("media", "media.transcribe")
async def media_transcribe(data: dict[str, Any]) -> dict[str, Any]:
    recording_id = str(data["recordingId"])
    bucket = str(data["bucket"])
    key = str(data["storageKey"])

    if not transcribe_enabled():
        await report_transcript(
            recording_id,
            Transcript(
                status="unavailable", error="модель распознавания речи не настроена"
            ).as_payload(),
        )
        log.info("transcribe.disabled", recording_id=recording_id)
        return {"status": "unavailable"}

    timeout = settings().ENGINE_TRANSCRIBE_TIMEOUT_S
    with tempfile.TemporaryDirectory(prefix="kchs-transcribe-") as tmp:
        workdir = Path(tmp)
        try:
            source = await download(bucket, key, workdir / "recording.mp4")
        except Exception as error:  # файла нет — повтор не поможет
            raise PermanentJobError(f"запись не читается из хранилища: {error}") from error
        try:
            result = await asyncio.wait_for(
                asyncio.to_thread(_run, source, workdir), timeout=timeout
            )
        except TimeoutError as error:
            raise PermanentJobError(f"расшифровка не уложилась в {timeout} с") from error

    await report_transcript(recording_id, result.as_payload())
    log.info(
        "transcribe.done",
        recording_id=recording_id,
        status=result.status,
        segments=len(result.segments),
        language=result.language,
    )
    return {
        "status": result.status,
        "segments": len(result.segments),
        "language": result.language,
    }
