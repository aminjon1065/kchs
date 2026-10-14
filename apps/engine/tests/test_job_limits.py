"""Предел времени задания движка и замок скачивания копии по ключу (ADR-0220)."""

import asyncio
import threading
import time
from pathlib import Path

import pytest

from kchs_engine import cancel
from kchs_engine.data import columnar


def test_job_over_limit_is_stopped(monkeypatch: pytest.MonkeyPatch) -> None:
    async def never_cancelled(_job_id: str) -> bool:
        return False

    monkeypatch.setattr(cancel, "is_cancelled", never_cancelled)

    async def hanging() -> dict[str, object]:
        await asyncio.sleep(30)
        return {}

    async def scenario() -> float:
        started = time.monotonic()
        with pytest.raises(cancel.JobTimeoutError):
            await cancel.run_cancellable("job", hanging(), poll_seconds=0.05, timeout_seconds=0.2)
        return time.monotonic() - started

    assert asyncio.run(scenario()) < 2


def test_job_within_limit_returns_result(monkeypatch: pytest.MonkeyPatch) -> None:
    async def never_cancelled(_job_id: str) -> bool:
        return False

    monkeypatch.setattr(cancel, "is_cancelled", never_cancelled)

    async def quick() -> dict[str, object]:
        await asyncio.sleep(0.01)
        return {"ok": True}

    result = asyncio.run(
        cancel.run_cancellable("job", quick(), poll_seconds=0.05, timeout_seconds=5)
    )
    assert result == (False, {"ok": True})


def test_slow_download_does_not_block_cached_copies(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(columnar, "_cache_dir", lambda: tmp_path)
    monkeypatch.setattr(columnar, "_evict", lambda _folder, _keep: None)
    cached = tmp_path / columnar._cache_name("bucket", "ready")
    cached.write_bytes(b"parquet")
    release = threading.Event()

    def slow_download(_bucket: str, _key: str, target: Path) -> None:
        release.wait(5)
        target.write_bytes(b"parquet")

    monkeypatch.setattr(columnar.storage, "download_sync", slow_download)
    worker = threading.Thread(target=columnar._ensure_local, args=("bucket", "slow"))
    worker.start()
    time.sleep(0.1)
    started = time.monotonic()
    # Готовая копия отдаётся сразу, пока соседняя качается
    assert columnar._ensure_local("bucket", "ready") == cached
    assert time.monotonic() - started < 0.5
    release.set()
    worker.join(5)
    assert (tmp_path / columnar._cache_name("bucket", "slow")).exists()
