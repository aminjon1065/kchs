"""Объектное хранилище (MinIO/S3). Движок читает исходники и пишет производные.

boto3 синхронный — вызовы уходят в пул потоков, чтобы не блокировать цикл событий.
"""

import asyncio
from functools import lru_cache
from pathlib import Path
from typing import Any

import boto3
from botocore.config import Config

from kchs_engine.config import settings


@lru_cache
def _client() -> Any:
    config = settings()
    return boto3.client(
        "s3",
        endpoint_url=config.S3_ENDPOINT,
        region_name=config.S3_REGION,
        aws_access_key_id=config.S3_ACCESS_KEY,
        aws_secret_access_key=config.S3_SECRET_KEY,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


async def object_size(bucket: str, key: str) -> int:
    head = await asyncio.to_thread(_client().head_object, Bucket=bucket, Key=key)
    return int(head["ContentLength"])


async def read_range(bucket: str, key: str, length: int) -> bytes:
    """Первые `length` байт объекта: анализ импорта читает только начало файла."""

    def fetch() -> bytes:
        response = _client().get_object(Bucket=bucket, Key=key, Range=f"bytes=0-{length - 1}")
        body = response["Body"]
        try:
            return bytes(body.read())
        finally:
            body.close()

    if length <= 0:
        return b""
    return await asyncio.to_thread(fetch)


async def download(bucket: str, key: str, target: Path) -> Path:
    await asyncio.to_thread(download_sync, bucket, key, target)
    return target


def download_sync(bucket: str, key: str, target: Path) -> Path:
    """Скачивание из уже выделенного потока (кэш колоночных копий, ADR-0109)."""
    _client().download_file(bucket, key, str(target))
    return target


async def upload(bucket: str, key: str, source: Path, content_type: str) -> None:
    await asyncio.to_thread(
        _client().upload_file,
        str(source),
        bucket,
        key,
        ExtraArgs={"ContentType": content_type},
    )
