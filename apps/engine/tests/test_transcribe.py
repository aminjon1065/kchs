"""Расшифровка записи встречи (ADR-0092).

Модель распознавания в проверках не участвует: без `ENGINE_TRANSCRIBE_MODEL`
функция выключена, и задание обязано сообщить об этом, а не упасть.
"""

from pathlib import Path
from typing import Any

import pytest

from kchs_engine.config import settings
from kchs_engine.contracts import media_transcribe_contract
from kchs_engine.jobs import JOB_HANDLERS
from kchs_engine.jobs import media as media_job
from kchs_engine.media.transcribe import Segment, Transcript, transcribe, transcribe_enabled


def test_handler_registered_in_engine_queue() -> None:
    from kchs_engine.contracts import engine_queues

    contract = media_transcribe_contract()
    key = f"{contract['job']['queue']}:{contract['job']['name']}"
    assert key == "media:media.transcribe"
    assert key in JOB_HANDLERS
    assert contract["job"]["queue"] in engine_queues()


def test_contract_languages_and_limits() -> None:
    contract = media_transcribe_contract()
    assert contract["languages"] == ["ru", "tg", "en"]
    assert contract["maxSegments"] > 0
    assert contract["recordingMime"] == "video/mp4"


def test_disabled_without_model() -> None:
    settings.cache_clear()
    assert transcribe_enabled() is False
    result = transcribe(Path("не-читается.wav"))
    assert result.status == "unavailable"
    assert result.segments == []


def test_payload_shape_matches_contract() -> None:
    transcript = Transcript(
        status="ready",
        language="ru",
        model="small",
        duration_s=12.5,
        segments=[Segment(start=0.0, end=2.25, text="Добрый день")],
    )
    payload = transcript.as_payload()
    assert payload["status"] == "ready"
    assert payload["durationSeconds"] == 12.5
    assert payload["segments"] == [
        {"start": 0.0, "end": 2.25, "text": "Добрый день", "speaker": None}
    ]


async def test_job_reports_unavailable_without_downloading(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings.cache_clear()
    reported: list[tuple[str, dict[str, Any]]] = []

    async def fake_report(recording_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        reported.append((recording_id, payload))
        return {"ok": True}

    async def fail_download(*_args: object, **_kwargs: object) -> Path:
        raise AssertionError("без модели запись скачивать незачем")

    monkeypatch.setattr(media_job, "report_transcript", fake_report)
    monkeypatch.setattr(media_job, "download", fail_download)

    result = await media_job.media_transcribe(
        {"recordingId": "r-1", "bucket": "kchs-files", "storageKey": "meetings/m-1/r-1.mp4"}
    )
    assert result == {"status": "unavailable"}
    assert reported[0][0] == "r-1"
    assert reported[0][1]["status"] == "unavailable"
    assert reported[0][1]["segments"] == []


async def test_job_reports_segments(monkeypatch: pytest.MonkeyPatch) -> None:
    """Поддельная модель: задание отдаёт сегменты api и считает их в итоге."""
    reported: list[dict[str, Any]] = []

    async def fake_report(_recording_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        reported.append(payload)
        return {"ok": True}

    async def fake_download(_bucket: str, _key: str, target: Path) -> Path:
        target.write_bytes(b"fake-mp4")
        return target

    def fake_run(_source: Path, _workdir: Path) -> Transcript:
        return Transcript(
            status="ready",
            language="ru",
            model="small",
            duration_s=4.0,
            segments=[
                Segment(start=0.0, end=2.0, text="Первая фраза"),
                Segment(start=2.0, end=4.0, text="Вторая фраза"),
            ],
        )

    monkeypatch.setattr(media_job, "report_transcript", fake_report)
    monkeypatch.setattr(media_job, "download", fake_download)
    monkeypatch.setattr(media_job, "transcribe_enabled", lambda: True)
    monkeypatch.setattr(media_job, "_run", fake_run)

    result = await media_job.media_transcribe(
        {"recordingId": "r-2", "bucket": "kchs-files", "storageKey": "meetings/m-2/r-2.mp4"}
    )
    assert result == {"status": "ready", "segments": 2, "language": "ru"}
    assert [segment["text"] for segment in reported[0]["segments"]] == [
        "Первая фраза",
        "Вторая фраза",
    ]
