"""Маршрут анализа, задание нормализации и окончательные сбои (ADR-0046).

Хранилище и API подменяются: маршрут и задание проверяются без MinIO и без
api (проверка с настоящим MinIO — tests/test_data_s3.py).
"""

import asyncio
import shutil
import zipfile
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest
import shapely
from botocore.exceptions import ClientError
from bullmq.custom_errors import UnrecoverableError
from fastapi.testclient import TestClient
from import_helpers import assert_contract, parse_copy_csv
from openpyxl import Workbook
from pyogrio import raw

from kchs_engine import main, worker
from kchs_engine.config import settings
from kchs_engine.data import analyze as analyze_module
from kchs_engine.jobs import JOB_HANDLERS, PermanentJobError, dataset_import

TOKEN = "service-token-for-tests"
BUCKET = "kchs-files"
CSV = (
    "Район;Население;Площадь;Дата\n"
    "Вахдат;1 234 567;1 234,5;18.09.2025\n"
    "Рудаки;450 000;2 891,25;01.02.2025\n"
    "Гиссар;много;1 040;13.01.2025\n"
)


class FakeStorage:
    """Бакет в памяти вместо MinIO: HEAD, чтение начала и скачивание целиком."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.calls: list[tuple[str, int]] = []
        self.delay = 0.0

    def _get(self, key: str) -> bytes:
        if key not in self.objects:
            raise ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
        return self.objects[key]

    async def object_size(self, bucket: str, key: str) -> int:
        assert bucket == BUCKET
        return len(self._get(key))

    async def read_range(self, bucket: str, key: str, length: int) -> bytes:
        await asyncio.sleep(self.delay)
        self.calls.append(("range", length))
        return self._get(key)[:length]

    async def download(self, bucket: str, key: str, target: Path) -> Path:
        data = self._get(key)
        self.calls.append(("download", len(data)))
        target.write_bytes(data)
        return target


@pytest.fixture
def storage(monkeypatch: pytest.MonkeyPatch) -> FakeStorage:
    fake = FakeStorage()
    monkeypatch.setattr(analyze_module, "object_size", fake.object_size)
    monkeypatch.setattr(analyze_module, "read_range", fake.read_range)
    monkeypatch.setattr(analyze_module, "download", fake.download)
    return fake


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TOKEN)
    settings.cache_clear()
    # Без `with`: жизненный цикл (воркеры BullMQ) в тестах маршрута не запускается
    yield TestClient(main.app)
    settings.cache_clear()


def post(client: TestClient, key: str, **extra: Any) -> Any:
    body = {"bucket": BUCKET, "key": key, "fileName": key.rsplit("/", 1)[-1], **extra}
    return client.post("/data/analyze", json=body, headers={"x-kchs-service-token": TOKEN})


def test_анализ_только_с_сервисным_токеном(client: TestClient, storage: FakeStorage) -> None:
    storage.objects["a.csv"] = CSV.encode()
    body = {"bucket": BUCKET, "key": "a.csv", "fileName": "a.csv"}
    assert client.post("/data/analyze", json=body).status_code == 401
    wrong = client.post("/data/analyze", json=body, headers={"x-kchs-service-token": "wrong"})
    assert wrong.status_code == 401


def test_анализ_csv(client: TestClient, storage: FakeStorage) -> None:
    storage.objects["uploads/svodka.csv"] = CSV.encode("cp1251")
    response = post(client, "uploads/svodka.csv")
    assert response.status_code == 200, response.text
    analysis = response.json()
    assert_contract(analysis)
    assert (analysis["encoding"], analysis["delimiter"], analysis["decimal"]) == (
        "cp1251",
        ";",
        ",",
    )
    assert [item["key"] for item in analysis["columns"]] == [
        "rayon",
        "naselenie",
        "ploshchad",
        "data",
    ]
    # Маленький файл читается одним запросом начала — целиком
    assert storage.calls == [("range", len(CSV.encode("cp1251")))]


def test_параметры_чтения_из_запроса(client: TestClient, storage: FakeStorage) -> None:
    storage.objects["plain.txt"] = b"a|b\n1|2\n3|4\n"
    response = post(client, "plain.txt", options={"delimiter": "|", "headerRows": 0})
    assert response.status_code == 200, response.text
    analysis = response.json()
    assert (analysis["delimiter"], analysis["headerRows"]) == ("|", 0)
    assert analysis["rowEstimate"] == 3
    invalid = post(client, "plain.txt", options={"delimiter": "||"})
    assert invalid.status_code == 422


def test_большой_текстовый_файл_читается_по_началу(
    client: TestClient, storage: FakeStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(analyze_module, "SAMPLE_BYTES", 4096)
    line = "Вахдат;1 234;18.09.2025\n"
    storage.objects["big.csv"] = ("Район;Число;Дата\n" + line * 2000).encode()
    response = post(client, "big.csv")
    assert response.status_code == 200, response.text
    analysis = response.json()
    assert analysis["approx"] is True
    assert storage.calls == [("range", 4096)]
    assert analysis["rowEstimate"] > 0


def test_книга_excel_скачивается_целиком(
    client: TestClient, storage: FakeStorage, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    book = Workbook()
    sheet = book.active
    assert sheet is not None
    sheet.append(["Код", "Сумма"])
    for index in range(20):
        sheet.append([f"К-{index}", index * 1.5])
    path = tmp_path / "book.xlsx"
    book.save(path)
    storage.objects["book.xlsx"] = path.read_bytes()
    monkeypatch.setattr(analyze_module, "SAMPLE_BYTES", 1024)
    response = post(client, "book.xlsx")
    assert response.status_code == 200, response.text
    assert response.json()["format"] == "xlsx"
    assert storage.calls == [("range", 1024), ("download", path.stat().st_size)]


def test_shapefile_в_архиве_скачивается_целиком(
    client: TestClient, storage: FakeStorage, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    layer = tmp_path / "posts.shp"
    raw.write(
        str(layer),
        shapely.to_wkb(np.array([shapely.Point(340000, 4270000)] * 30, dtype=object)),
        [np.array([f"Пост {index}" for index in range(30)], dtype=object)],
        ["name"],
        geometry_type="Point",
        crs="EPSG:32642",
        driver="ESRI Shapefile",
    )
    archive = tmp_path / "posts.zip"
    with zipfile.ZipFile(archive, "w") as packed:
        for path in tmp_path.glob("posts.*"):
            if path.suffix != ".zip":
                packed.write(path, path.name)
    storage.objects["uploads/posts.zip"] = archive.read_bytes()
    monkeypatch.setattr(analyze_module, "SAMPLE_BYTES", 256)
    response = post(client, "uploads/posts.zip", options={"crs": "EPSG:32642"})
    assert response.status_code == 200, response.text
    analysis = response.json()
    assert_contract(analysis)
    assert (analysis["format"], analysis["rowEstimate"]) == ("shp", 30)
    assert analysis["geo"]["crsSource"] == "option"
    assert storage.calls == [("range", 256), ("download", archive.stat().st_size)]
    invalid = post(client, "uploads/posts.zip", options={"crs": "UTM42"})
    assert invalid.status_code == 422


def test_ошибки_анализа(
    client: TestClient, storage: FakeStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage.objects["empty.csv"] = b""
    empty = post(client, "empty.csv")
    assert (empty.status_code, empty.json()["detail"]) == (422, "Файл пуст")
    storage.objects["broken.xlsx"] = b"PK\x03\x04" + b"\x00" * 64
    broken = post(client, "broken.xlsx")
    assert broken.status_code == 422
    assert broken.json()["detail"].startswith("Книга Excel повреждена")
    assert post(client, "missing.csv").status_code == 404

    storage.objects["slow.csv"] = CSV.encode()
    storage.delay = 0.5
    limits = {**analyze_module._limits(), "analyzeTimeoutMs": 50}
    monkeypatch.setattr(analyze_module, "_limits", lambda: limits)
    slow = post(client, "slow.csv")
    assert slow.status_code == 422
    assert "не уложился" in slow.json()["detail"]


# ─── Задание imports:dataset.normalize ───────────────────────────────────────


class FakeJobIo:
    """Хранилище и API для задания: файл-источник, загруженные объекты, отчёты."""

    def __init__(self, source: Path) -> None:
        self.source = source
        self.uploads: dict[str, tuple[bytes, str]] = {}
        self.progress: list[tuple[float, str | None]] = []
        self.reports: list[tuple[str, dict[str, Any]]] = []

    async def object_size(self, bucket: str, key: str) -> int:
        return self.source.stat().st_size

    async def download(self, bucket: str, key: str, target: Path) -> Path:
        shutil.copy(self.source, target)
        return target

    async def upload(self, bucket: str, key: str, path: Path, content_type: str) -> None:
        self.uploads[f"{bucket}/{key}"] = (path.read_bytes(), content_type)

    async def report_progress(self, job_id: str, value: float, message: str | None = None) -> None:
        self.progress.append((value, message))

    async def report(self, import_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.reports.append((import_id, payload))
        return {"loadJobId": "load-job"}


def job_io(monkeypatch: pytest.MonkeyPatch, source: Path) -> FakeJobIo:
    fake = FakeJobIo(source)
    monkeypatch.setattr(dataset_import, "object_size", fake.object_size)
    monkeypatch.setattr(dataset_import, "download", fake.download)
    monkeypatch.setattr(dataset_import, "upload", fake.upload)
    monkeypatch.setattr(dataset_import, "report_progress", fake.report_progress)
    monkeypatch.setattr(dataset_import, "report_dataset_normalized", fake.report)
    return fake


def job_data(**extra: Any) -> dict[str, Any]:
    mapping = [
        {"column": 0, "fieldKey": "rayon", "label": {"ru": "Район"}, "type": "text"},
        {"column": 1, "fieldKey": "naselenie", "label": {"ru": "Население"}, "type": "integer"},
        {"column": 3, "fieldKey": "data", "label": {"ru": "Дата"}, "type": "date"},
    ]
    for item in mapping:
        item["semantic"] = "dimension"
    data: dict[str, Any] = {
        "jobRecordId": "job-1",
        "importId": "import-1",
        "bucket": BUCKET,
        "storageKey": "files/source",
        "fileName": "svodka.csv",
        "options": {},
        "mapping": mapping,
        "geometry": None,
        "geometryField": None,
        "onError": "skip",
        "output": {
            "bucket": BUCKET,
            "normalizedKey": "imports/import-1/normalized.csv",
            "errorsKey": "imports/import-1/errors.csv",
        },
    }
    data.update(extra)
    return data


async def test_задание_нормализации(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    assert "imports:dataset.normalize" in JOB_HANDLERS
    source = tmp_path / "svodka.csv"
    source.write_bytes(CSV.encode("cp1251"))
    fake = job_io(monkeypatch, source)
    result = await dataset_import.dataset_normalize(job_data())
    assert result == {
        "rows": 3,
        "errors": 1,
        "normalizedKey": "imports/import-1/normalized.csv",
        "errorsKey": "imports/import-1/errors.csv",
        "loadJobId": "load-job",
    }
    normalized, mime = fake.uploads[f"{BUCKET}/imports/import-1/normalized.csv"]
    assert mime == "text/csv; charset=utf-8"
    assert parse_copy_csv(normalized.decode()) == [
        ["2", "Вахдат", "1234567", "2025-09-18"],
        ["3", "Рудаки", "450000", "2025-02-01"],
    ]
    errors, _mime = fake.uploads[f"{BUCKET}/imports/import-1/errors.csv"]
    assert errors.decode().splitlines() == [
        "row,field,value,code",
        "4,naselenie,много,invalid_integer",
    ]
    assert fake.reports == [
        (
            "import-1",
            {
                "jobRecordId": "job-1",
                "rows": 3,
                "errors": 1,
                "normalizedKey": "imports/import-1/normalized.csv",
                "errorsKey": "imports/import-1/errors.csv",
                "errorSample": [
                    {"row": 4, "column": "naselenie", "value": "много", "reason": "invalid_integer"}
                ],
            },
        )
    ]
    assert fake.progress[0][0] == 0.05 and fake.progress[-1][0] == 0.95


async def test_задание_без_ошибок_не_пишет_файл_ошибок(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "clean.csv"
    source.write_text("Район;Население;Площадь;Дата\nВахдат;1;2;18.09.2025\n", encoding="utf-8")
    fake = job_io(monkeypatch, source)
    result = await dataset_import.dataset_normalize(job_data())
    assert (result["errors"], result["errorsKey"]) == (0, None)
    assert list(fake.uploads) == [f"{BUCKET}/imports/import-1/normalized.csv"]
    assert fake.reports[0][1]["errorsKey"] is None


async def test_задание_с_книгой_excel(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    book = Workbook()
    sheet = book.active
    assert sheet is not None
    sheet.append(["Отчёт"])
    sheet.append(["Район", "Население", "Площадь", "Дата"])
    sheet.append(["Вахдат", 1234567, 1234.5, "18.09.2025"])
    sheet.append(["Рудаки", "много", 2891.25, "01.02.2025"])
    source = tmp_path / "upload"
    book.save(source)
    fake = job_io(monkeypatch, source)
    result = await dataset_import.dataset_normalize(job_data(fileName="отчёт.xlsx"))
    assert (result["rows"], result["errors"]) == (2, 1)
    normalized, _mime = fake.uploads[f"{BUCKET}/imports/import-1/normalized.csv"]
    assert parse_copy_csv(normalized.decode()) == [["3", "Вахдат", "1234567", "2025-09-18"]]
    assert fake.reports[0][1]["errorSample"][0]["row"] == 4


async def test_нечитаемый_файл_окончательный_сбой(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = tmp_path / "empty.csv"
    source.write_bytes(b"")
    fake = job_io(monkeypatch, source)
    with pytest.raises(PermanentJobError, match="Не удалось прочитать файл: файл пуст"):
        await dataset_import.dataset_normalize(job_data())
    assert fake.reports == []
    source.write_text("a;b\n1;2\n", encoding="utf-8")
    bad_mapping = job_data(mapping=[{"column": 0, "fieldKey": "a", "type": "user"}])
    with pytest.raises(PermanentJobError, match="Неверные параметры импорта"):
        await dataset_import.dataset_normalize(bad_mapping)


async def test_воркер_не_повторяет_окончательный_сбой(monkeypatch: pytest.MonkeyPatch) -> None:
    failures: list[tuple[str, str, bool]] = []

    async def started(job_id: str) -> None:
        return None

    async def failed(job_id: str, error: str, *, final: bool = True) -> None:
        failures.append((job_id, error, final))

    async def permanent(data: dict[str, Any]) -> dict[str, Any]:
        raise PermanentJobError("Не удалось прочитать файл: файл пуст")

    async def transient(data: dict[str, Any]) -> dict[str, Any]:
        raise RuntimeError("хранилище недоступно")

    monkeypatch.setattr(worker, "report_started", started)
    monkeypatch.setattr(worker, "report_failure", failed)
    monkeypatch.setitem(JOB_HANDLERS, "imports:test.permanent", permanent)
    monkeypatch.setitem(JOB_HANDLERS, "imports:test.transient", transient)
    process = worker._make_processor("imports")

    job = SimpleNamespace(
        name="test.permanent", data={"jobRecordId": "job-1"}, id="1", attempts=2, attemptsMade=0
    )
    with pytest.raises(UnrecoverableError):
        await process(job, "token")  # type: ignore[arg-type]
    job = SimpleNamespace(
        name="test.transient", data={"jobRecordId": "job-2"}, id="2", attempts=2, attemptsMade=0
    )
    with pytest.raises(RuntimeError):
        await process(job, "token")  # type: ignore[arg-type]
    assert failures == [
        ("job-1", "Не удалось прочитать файл: файл пуст", True),
        ("job-2", "хранилище недоступно", False),
    ]
