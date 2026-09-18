"""Превью и текст файлов (09-files.md §3–4). Тесты с внешними программами
(poppler, LibreOffice, tesseract) выполняются в образе движка и пропускаются там,
где этих программ нет."""

import shutil
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from kchs_engine.files.processing import (
    THUMBNAIL_WIDTH,
    WEB_MAX_SIDE,
    classify,
    detect_lang,
    image_previews,
    office_to_pdf,
    process,
    process_pdf,
    read_text_file,
)

needs_poppler = pytest.mark.skipif(shutil.which("pdftotext") is None, reason="нет poppler")
needs_office = pytest.mark.skipif(shutil.which("soffice") is None, reason="нет LibreOffice")
needs_ocr = pytest.mark.skipif(shutil.which("tesseract") is None, reason="нет tesseract")

FONT = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")


def rtf(text: str) -> str:
    """RTF с кириллицей через \\uN? — формат, который LibreOffice читает без зависимостей."""
    body = "".join(ch if ord(ch) < 128 else f"\\u{ord(ch)}?" for ch in text)
    return "{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 DejaVu Sans;}}\\f0\\fs28 " + body + "\\par}"


def test_classify_by_mime_and_extension() -> None:
    assert classify("image/png", "scan.png") == "image"
    assert classify("application/pdf", "doc.bin") == "pdf"
    assert classify("application/octet-stream", "Приказ.docx") == "office"
    assert classify("text/csv", "data.csv") == "text"
    assert classify("application/zip", "archive.zip") == "other"


def test_detect_lang() -> None:
    assert detect_lang("Сводка по паводку за сутки") == "ru"
    assert detect_lang("Ҳисобот дар бораи обхезӣ") == "tg"
    assert detect_lang("Flood report for the day") == "en"
    assert detect_lang("12345") is None


def test_image_previews_sizes(tmp_path: Path) -> None:
    source = tmp_path / "photo.png"
    Image.new("RGB", (3000, 1500), (40, 90, 160)).save(source)
    previews = {p.kind: p for p in image_previews(source, tmp_path)}
    assert previews["thumbnail"].width == THUMBNAIL_WIDTH
    assert max(previews["web"].width, previews["web"].height) <= WEB_MAX_SIDE
    assert previews["web"].path.read_bytes()[:4] == b"RIFF"  # WebP


def test_text_file_in_cp1251(tmp_path: Path) -> None:
    source = tmp_path / "old.txt"
    source.write_bytes("Уровень воды у поста Кофарнихон".encode("cp1251"))
    assert read_text_file(source) == "Уровень воды у поста Кофарнихон"
    result = process(source, "text/plain", "old.txt", tmp_path)
    assert result.text_status == "ready"
    assert result.preview_status == "unsupported"
    assert result.lang == "ru"


def test_broken_pdf_is_failed_not_raised(tmp_path: Path) -> None:
    source = tmp_path / "broken.pdf"
    source.write_bytes(b"%PDF-1.7 definitely not a pdf")
    result = process(source, "application/pdf", "broken.pdf", tmp_path)
    assert result.preview_status == "failed"
    assert result.error


@needs_office
@needs_poppler
def test_office_document_to_pdf_pages_and_text(tmp_path: Path) -> None:
    source = tmp_path / "prikaz.rtf"
    source.write_text(rtf("Приказ о мерах по паводку 2026"), encoding="ascii")
    pdf = office_to_pdf(source, tmp_path)
    result = process_pdf(pdf, tmp_path)
    assert result.pages == 1
    assert result.text_status == "ready"
    assert "паводку" in (result.text or "")
    assert result.lang == "ru"
    kinds = sorted(p.kind for p in result.previews)
    assert kinds == ["page", "thumbnail"]


@needs_ocr
@needs_poppler
@pytest.mark.skipif(not FONT.exists(), reason="нет шрифта DejaVu")
def test_scan_without_text_layer_goes_to_ocr(tmp_path: Path) -> None:
    image = Image.new("RGB", (1654, 600), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(FONT), 96)
    draw.text((80, 200), "KCHS FLOOD REPORT 2026", fill="black", font=font)
    scan = tmp_path / "scan.pdf"
    image.save(scan, "PDF", resolution=150)

    result = process_pdf(scan, tmp_path)
    assert result.pages == 1
    assert result.text_status == "ready"
    assert "FLOOD" in (result.text or "").upper()
