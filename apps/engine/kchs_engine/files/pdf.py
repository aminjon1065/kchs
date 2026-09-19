"""PDF-представление версии документа (08-documents.md §8, ADR-0080).

Чистые функции над локальными файлами: SHA-256 основного файла версии и
перевод в PDF — офисные форматы через LibreOffice (как у превью), изображения
(сканы JPEG/PNG/TIFF, в том числе многостраничные) через Pillow.
"""

import hashlib
from pathlib import Path

from PIL import Image, ImageOps, ImageSequence

from kchs_engine.files.processing import ToolError, classify, office_to_pdf

# Разрешение изображения в PDF: A4 при 150 dpi — скан того же размера на странице
IMAGE_DPI = 150.0
HASH_CHUNK = 1024 * 1024


def sha256_file(path: Path) -> str:
    """SHA-256 содержимого: фиксирует версию документа для подписи (08-documents.md §9)."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(HASH_CHUNK):
            digest.update(chunk)
    return digest.hexdigest()


def image_to_pdf(source: Path, target: Path) -> Path:
    """Изображение (все кадры многостраничного TIFF) → PDF с сохранением ориентации."""
    with Image.open(source) as opened:
        pages = [
            ImageOps.exif_transpose(frame.copy()).convert("RGB")
            for frame in ImageSequence.Iterator(opened)
        ]
    if not pages:
        raise ToolError("изображение без кадров")
    first, *rest = pages
    first.save(target, "PDF", resolution=IMAGE_DPI, save_all=True, append_images=rest)
    return target


def to_pdf(source: Path, mime: str, name: str, workdir: Path) -> Path:
    """PDF-представление: офисный документ или изображение; прочее — не переводится."""
    kind = classify(mime, name)
    if kind == "office":
        return office_to_pdf(source, workdir)
    if kind == "image":
        return image_to_pdf(source, workdir / "representation.pdf")
    raise ToolError(f"формат {mime} не переводится в PDF")
