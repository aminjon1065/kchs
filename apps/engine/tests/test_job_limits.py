"""Предел времени задания движка и замок скачивания копии по ключу (ADR-0220), вытеснение
копий и остановка движка (ADR-0222)."""

import asyncio
import os
import threading
import time
from pathlib import Path
from types import SimpleNamespace

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
    worker = threading.Thread(target=columnar._acquire_local, args=("bucket", "slow"))
    worker.start()
    time.sleep(0.1)
    started = time.monotonic()
    # Готовая копия отдаётся сразу, пока соседняя качается
    assert columnar._acquire_local("bucket", "ready") == cached
    assert time.monotonic() - started < 0.5
    release.set()
    worker.join(5)
    slow = tmp_path / columnar._cache_name("bucket", "slow")
    assert slow.exists()
    columnar._release([cached, slow])


def test_batch_table_matches_per_value_conversion() -> None:
    """Пачка по столбцам (ADR-0220) — те же значения, что и прежнее преобразование по одному."""
    import uuid
    from datetime import UTC, datetime
    from decimal import Decimal

    import pyarrow as pa

    from kchs_engine.data import columnar

    columns = [
        columnar.Column("amount", "money"),
        columnar.Column("score", "number"),
        columnar.Column("happened", "datetime"),
        columnar.Column("tags", "multi_select"),
        columnar.Column("title", "text"),
    ]
    schema = pa.schema(
        [pa.field(column.name, columnar._arrow_type(column.type)) for column in columns]
    )
    batch = [
        (Decimal("12.50"), Decimal("1.5"), datetime(2026, 1, 2, 3, 4, 5), ["a", 1], "один"),
        (None, 2.0, datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC), None, str(uuid.UUID(int=1))),
    ]
    table = columnar._batch_table(batch, columns, schema)
    expected = pa.Table.from_arrays(
        [
            pa.array(
                [columnar._value_for_arrow(row[index], column.type) for row in batch],
                type=schema.field(index).type,
            )
            for index, column in enumerate(columns)
        ],
        schema=schema,
    )
    assert table.equals(expected)
    assert columnar._batch_table([], columns, schema).num_rows == 0


def _copy(folder: Path, key: str, size: int, mtime: float) -> Path:
    path = folder / columnar._cache_name("bucket", key)
    path.write_bytes(b"x" * size)
    os.utime(path, (mtime, mtime))
    return path


def test_eviction_by_last_use_skips_files_in_use(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Вытеснение (ADR-0222): по времени выдачи кэшем (mtime), читаемое не удаляется,
    замок скачивания удалённой копии уходит вместе с ней."""
    monkeypatch.setattr(columnar, "_cache_dir", lambda: tmp_path)
    monkeypatch.setattr(columnar, "settings", lambda: SimpleNamespace(ENGINE_COLUMNAR_CACHE_MB=1))
    half = 512 * 1024
    now = time.time()
    oldest = _copy(tmp_path, "oldest", half, now - 300)
    reading = _copy(tmp_path, "reading", half, now - 200)
    recent = _copy(tmp_path, "recent", half, now - 100)
    # atime свежий (как попало на томах с noatime): решать по нему нельзя
    os.utime(oldest, (now, now - 300))
    columnar._key_lock(oldest.name)

    held = columnar._acquire_local("bucket", "reading")
    assert held == reading
    assert reading.stat().st_mtime > now - 1, "выдача обновляет время обращения"
    # Читаемая копия снова самая давняя по mtime — вытеснение всё равно её не тронет
    os.utime(reading, (now, now - 400))

    def download(_bucket: str, _key: str, target: Path) -> None:
        target.write_bytes(b"x" * half)

    monkeypatch.setattr(columnar.storage, "download_sync", download)
    fresh = columnar._acquire_local("bucket", "fresh")
    try:
        # 4 × 0,5 МБ при пределе 1 МБ: уходят давние, читаемое и только что скачанное — нет
        assert reading.exists()
        assert fresh.exists()
        assert not oldest.exists()
        assert not recent.exists()
        assert oldest.name not in columnar._download_locks
    finally:
        columnar._release([held, fresh])
    assert columnar._in_use == {}


def test_query_releases_copies_even_on_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(columnar, "_cache_dir", lambda: tmp_path)
    _copy(tmp_path, "broken", 16, time.time())

    def failing(_payload: dict[str, object], _files: dict[str, Path]) -> dict[str, object]:
        raise RuntimeError("сбой запроса")

    monkeypatch.setattr(columnar, "_query", failing)
    payload = {"sql": "select 1", "sources": [{"table": "t", "bucket": "bucket", "key": "broken"}]}
    with pytest.raises(RuntimeError):
        asyncio.run(columnar.query(payload))
    assert columnar._in_use == {}


def test_cancel_client_is_closed_on_shutdown(monkeypatch: pytest.MonkeyPatch) -> None:
    closed: list[bool] = []

    class FakeRedis:
        async def aclose(self) -> None:
            closed.append(True)

    monkeypatch.setattr(cancel, "_client", FakeRedis())
    asyncio.run(cancel.close_cancel_client())
    assert closed == [True]
    assert cancel._client is None
    # Повторная остановка — без ошибок
    asyncio.run(cancel.close_cancel_client())
