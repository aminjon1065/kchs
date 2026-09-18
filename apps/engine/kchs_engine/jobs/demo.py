"""Демо-данные по заданию сида (P1-E10, ADR-0063).

Сид api ставит `transform:demo.generate`: генератор пишет файлы наборов и
`manifest.json` в хранилище под префиксом профиля. Файлы детерминированы, поэтому
манифест того же формата, профиля и seed означает, что всё уже на месте, —
повторный сид не генерирует данные заново.
"""

import asyncio
import json
from typing import Any

from botocore.exceptions import ClientError

from kchs_engine import storage
from kchs_engine.demo import DEFAULT_SEED, MANIFEST, MANIFEST_FORMAT, PROFILES, generate
from kchs_engine.demo.output import S3Target
from kchs_engine.jobs.registry import PermanentJobError, handler
from kchs_engine.logging import log

# Манифест 5 млн строк — несколько килобайт; больше — не наш файл
MANIFEST_LIMIT = 1_000_000


async def existing_manifest(bucket: str, key: str) -> dict[str, Any] | None:
    """Манифест в хранилище или None, если его нет."""
    try:
        size = await storage.object_size(bucket, key)
    except ClientError as error:
        code = str(error.response.get("Error", {}).get("Code", ""))
        if code in ("NoSuchKey", "404", "NotFound"):
            return None
        raise
    if size > MANIFEST_LIMIT:
        return None
    manifest: dict[str, Any] = json.loads(await storage.read_range(bucket, key, size))
    return manifest


@handler("transform", "demo.generate")
async def demo_generate(data: dict[str, Any]) -> dict[str, Any]:
    profile = PROFILES.get(str(data.get("profile")))
    if profile is None:
        raise PermanentJobError(f"неизвестный профиль демо-данных: {data.get('profile')}")
    seed = int(data.get("seed") or DEFAULT_SEED)
    bucket = str(data["bucket"])
    prefix = str(data["prefix"]).strip("/")
    if not bucket or not prefix:
        raise PermanentJobError("не указаны бакет и префикс демо-данных")
    key = f"{prefix}/{MANIFEST}"

    found = await existing_manifest(bucket, key)
    if (
        found is not None
        and found.get("format") == MANIFEST_FORMAT
        and found.get("profile") == profile.name
        and found.get("seed") == seed
    ):
        log.info("demo.reused", bucket=bucket, key=key)
        return {"manifestKey": key, "reused": True, "datasets": len(found.get("datasets", []))}

    # Генератор синхронный и пишет потоком — в отдельном потоке, цикл событий свободен
    manifest = await asyncio.to_thread(generate, S3Target(bucket, f"{prefix}/"), profile, seed=seed)
    rows = sum(int(item["rows"]) for item in manifest["datasets"])
    log.info("demo.generated", bucket=bucket, key=key, rows=rows)
    datasets = len(manifest["datasets"])
    return {"manifestKey": key, "reused": False, "datasets": datasets, "rows": rows}
