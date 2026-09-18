"""Куда пишутся файлы демо-данных: каталог или хранилище S3.

Файл пишется потоком (UTF-8) со счётчиком байт и SHA-256 для манифеста. В S3
файл сначала пишется во временный каталог и затем загружается клиентом
`kchs_engine.storage` — boto3 делит файлы крупнее 8 МБ на части (multipart);
держать файл целиком в памяти не нужно ни в одном из случаев.
"""

import asyncio
import hashlib
import tempfile
from abc import ABC, abstractmethod
from collections.abc import Iterator
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from typing import BinaryIO


class Output:
    """Поток текста в файл: UTF-8, число байт и SHA-256 записанного."""

    def __init__(self, stream: BinaryIO) -> None:
        self._stream = stream
        self._hash = hashlib.sha256()
        self.bytes = 0

    def write(self, text: str) -> None:
        data = text.encode("utf-8")
        self._hash.update(data)
        self.bytes += len(data)
        self._stream.write(data)

    @property
    def sha256(self) -> str:
        return self._hash.hexdigest()


class Target(ABC):
    """Место назначения файлов: `file` открывает файл по имени."""

    @abstractmethod
    def location(self, name: str) -> str: ...

    @abstractmethod
    def file(self, name: str, content_type: str) -> AbstractContextManager[Output]: ...


class DirectoryTarget(Target):
    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def location(self, name: str) -> str:
        return str(self.directory / name)

    @contextmanager
    def file(self, name: str, content_type: str) -> Iterator[Output]:
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self.directory / name
        # Файл появляется под своим именем только целиком: сбой не оставит половину
        partial = path.with_name(path.name + ".partial")
        try:
            with partial.open("wb", buffering=1 << 20) as stream:
                yield Output(stream)
            partial.replace(path)
        finally:
            partial.unlink(missing_ok=True)


class S3Target(Target):
    def __init__(self, bucket: str, prefix: str) -> None:
        self.bucket = bucket
        self.prefix = prefix

    def key(self, name: str) -> str:
        return f"{self.prefix}{name}"

    def location(self, name: str) -> str:
        return f"s3://{self.bucket}/{self.key(name)}"

    @contextmanager
    def file(self, name: str, content_type: str) -> Iterator[Output]:
        # boto3 загружается, только когда пишем в хранилище
        from kchs_engine import storage

        with tempfile.TemporaryDirectory(prefix="kchs-demo-", ignore_cleanup_errors=True) as tmp:
            path = Path(tmp) / name
            with path.open("wb", buffering=1 << 20) as stream:
                yield Output(stream)
            asyncio.run(storage.upload(self.bucket, self.key(name), path, content_type))


def parse_target(out: str) -> Target:
    """`s3://бакет/префикс` — хранилище, иначе — каталог."""
    if out.startswith("s3://"):
        bucket, _, prefix = out[len("s3://") :].partition("/")
        if not bucket:
            raise ValueError("в адресе s3:// не указан бакет")
        prefix = prefix.strip("/")
        return S3Target(bucket, f"{prefix}/" if prefix else "")
    return DirectoryTarget(Path(out))
