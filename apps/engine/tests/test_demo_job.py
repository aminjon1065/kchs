"""Задание `transform:demo.generate` (P1-E10, ADR-0063): генерация по профилю и
повторное использование готовых файлов. Хранилище подменено каталогом."""

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from kchs_engine.demo import Profile
from kchs_engine.demo.output import DirectoryTarget
from kchs_engine.jobs import PermanentJobError
from kchs_engine.jobs import demo as demo_job

TINY = Profile("tiny", incidents=200, objects=20, water_posts=2)


@pytest.fixture
def storage_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    class FolderTarget(DirectoryTarget):
        def __init__(self, bucket: str, prefix: str) -> None:
            super().__init__(tmp_path / bucket / prefix.strip("/"))

    async def manifest_in_folder(bucket: str, key: str) -> dict[str, Any] | None:
        path = tmp_path / bucket / key
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None

    monkeypatch.setattr(demo_job, "S3Target", FolderTarget)
    monkeypatch.setattr(demo_job, "existing_manifest", manifest_in_folder)
    monkeypatch.setattr(demo_job, "PROFILES", {"tiny": TINY})
    return tmp_path


def run(data: dict[str, Any]) -> dict[str, Any]:
    return asyncio.run(demo_job.demo_generate(data))


def test_генерация_и_повтор_без_перегенерации(storage_dir: Path) -> None:
    job = {"profile": "tiny", "seed": 7, "bucket": "files", "prefix": "demo/tiny-7/"}
    first = run(job)
    assert first["manifestKey"] == "demo/tiny-7/manifest.json"
    assert (first["reused"], first["datasets"]) == (False, 7)
    manifest = json.loads((storage_dir / "files/demo/tiny-7/manifest.json").read_text("utf-8"))
    assert (manifest["profile"], manifest["seed"]) == ("tiny", 7)
    assert first["rows"] == sum(item["rows"] for item in manifest["datasets"])

    # Тот же профиль и seed — файлы на месте, генератор не запускается
    assert run(job) == {"manifestKey": first["manifestKey"], "reused": True, "datasets": 7}

    # Другой seed под тем же префиксом — файлы генерируются заново
    assert run({**job, "seed": 8})["reused"] is False


def test_неизвестный_профиль_и_пустой_префикс_не_повторяются(storage_dir: Path) -> None:
    with pytest.raises(PermanentJobError, match="неизвестный профиль"):
        run({"profile": "huge", "bucket": "files", "prefix": "demo/x"})
    with pytest.raises(PermanentJobError, match="префикс"):
        run({"profile": "tiny", "bucket": "files", "prefix": "/"})
