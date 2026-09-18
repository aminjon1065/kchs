"""Анализ файла из настоящего MinIO разработки (ADR-0046).

Запуск: `KCHS_TEST_S3=1 pytest -m s3` с переменными S3_* из `.env` разработки.
Объекты пишутся в бакет файлов под префиксом `test-engine-import/` и удаляются.
"""

import os
import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from kchs_engine import main, storage
from kchs_engine.config import settings
from kchs_engine.data.readers import SAMPLE_BYTES

pytestmark = [
    pytest.mark.s3,
    pytest.mark.skipif(os.environ.get("KCHS_TEST_S3") != "1", reason="нужен MinIO разработки"),
]

TOKEN = "service-token-for-s3-tests"
PREFIX = "test-engine-import/"


@pytest.fixture
def s3(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[TestClient, str, str]]:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TOKEN)
    settings.cache_clear()
    storage._client.cache_clear()
    bucket = settings().S3_BUCKET_FILES
    folder = f"{PREFIX}{uuid.uuid4()}/"
    yield TestClient(main.app), bucket, folder
    client = storage._client()
    listed = client.list_objects_v2(Bucket=bucket, Prefix=folder)
    for item in listed.get("Contents", []):
        client.delete_object(Bucket=bucket, Key=item["Key"])
    assert client.list_objects_v2(Bucket=bucket, Prefix=folder).get("KeyCount", 0) == 0
    settings.cache_clear()
    storage._client.cache_clear()


def test_анализ_из_minio(s3: tuple[TestClient, str, str]) -> None:
    client, bucket, folder = s3
    s3_client = storage._client()
    small = f"{folder}svodka.csv"
    body = "Район;Население;Дата\nВахдат;1 234 567;18.09.2025\nРудаки;450 000;01.02.2025\n"
    s3_client.put_object(Bucket=bucket, Key=small, Body=body.encode("cp1251"))
    response = client.post(
        "/data/analyze",
        json={"bucket": bucket, "key": small, "fileName": "svodka.csv"},
        headers={"x-kchs-service-token": TOKEN},
    )
    assert response.status_code == 200, response.text
    analysis = response.json()
    assert (analysis["encoding"], analysis["rowEstimate"], analysis["approx"]) == (
        "cp1251",
        2,
        False,
    )

    # Больше головы анализа: читается только начало (Range), число строк — оценка
    line = "Вахдат;1 234 567;18.09.2025\n".encode()
    count = SAMPLE_BYTES // len(line) + 20_000
    big = f"{folder}big.csv"
    s3_client.put_object(
        Bucket=bucket, Key=big, Body="Район;Население;Дата\n".encode() + line * count
    )
    response = client.post(
        "/data/analyze",
        json={"bucket": bucket, "key": big, "fileName": "big.csv"},
        headers={"x-kchs-service-token": TOKEN},
    )
    assert response.status_code == 200, response.text
    analysis = response.json()
    assert analysis["approx"] is True
    assert analysis["rowEstimate"] == pytest.approx(count, rel=0.01)

    missing = client.post(
        "/data/analyze",
        json={"bucket": bucket, "key": f"{folder}нет-такого.csv", "fileName": "x.csv"},
        headers={"x-kchs-service-token": TOKEN},
    )
    assert missing.status_code == 404
