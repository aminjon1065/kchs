"""PDF-представление версии документа и хэш основного файла (ADR-0080).
Перевод офисных форматов — в образе движка (LibreOffice), здесь пропускается,
если программы нет."""

import hashlib
import shutil
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from kchs_engine.files.pdf import image_to_pdf, sha256_file, to_pdf
from kchs_engine.files.processing import ToolError
from kchs_engine.jobs import documents

needs_office = pytest.mark.skipif(shutil.which("soffice") is None, reason="нет LibreOffice")


def page_count(data: bytes) -> int:
    """Страницы PDF от Pillow: объекты `/Type /Page` без корня `/Type /Pages`."""
    return data.count(b"/Type /Page") - data.count(b"/Type /Pages")


def test_sha256_file_matches_hashlib(tmp_path: Path) -> None:
    source = tmp_path / "scan.pdf"
    payload = b"%PDF-1.7\n" + bytes(range(256)) * 5000
    source.write_bytes(payload)
    assert sha256_file(source) == hashlib.sha256(payload).hexdigest()


def test_image_to_pdf_single_page(tmp_path: Path) -> None:
    source = tmp_path / "scan.jpg"
    Image.new("RGB", (1240, 1754), (250, 250, 245)).save(source, "JPEG")
    pdf = image_to_pdf(source, tmp_path / "out.pdf")
    data = pdf.read_bytes()
    assert data.startswith(b"%PDF")
    assert page_count(data) == 1


def test_multipage_tiff_keeps_every_page(tmp_path: Path) -> None:
    source = tmp_path / "scan.tiff"
    first = Image.new("L", (600, 800), 255)
    second = Image.new("L", (600, 800), 200)
    first.save(source, "TIFF", save_all=True, append_images=[second])
    pdf = to_pdf(source, "image/tiff", "scan.tiff", tmp_path)
    assert page_count(pdf.read_bytes()) == 2


def test_other_formats_are_not_converted(tmp_path: Path) -> None:
    source = tmp_path / "data.zip"
    source.write_bytes(b"PK\x03\x04")
    with pytest.raises(ToolError):
        to_pdf(source, "application/zip", "data.zip", tmp_path)


@needs_office
def test_office_document_to_pdf(tmp_path: Path) -> None:
    source = tmp_path / "letter.rtf"
    source.write_text("{\\rtf1\\ansi\\f0 Letter\\par}", encoding="ascii")
    pdf = to_pdf(source, "application/rtf", "letter.rtf", tmp_path)
    assert pdf.read_bytes().startswith(b"%PDF")


async def test_job_reports_hash_without_conversion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = b"%PDF-1.4 test"
    reports: list[tuple[str, dict[str, Any]]] = []

    async def fake_size(_bucket: str, _key: str) -> int:
        return len(payload)

    async def fake_download(_bucket: str, _key: str, target: Path) -> Path:
        target.write_bytes(payload)
        return target

    async def fake_report(version_id: str, body: dict[str, Any]) -> dict[str, Any]:
        reports.append((version_id, body))
        return {"ok": True}

    monkeypatch.setattr(documents, "object_size", fake_size)
    monkeypatch.setattr(documents, "download", fake_download)
    monkeypatch.setattr(documents, "report_document_pdf", fake_report)

    result = await documents.document_pdf(
        {
            "versionId": "v-1",
            "name": "scan.pdf",
            "mime": "application/pdf",
            "bucket": "files",
            "storageKey": "spaces/s/files/f/v/scan.pdf",
            "convert": False,
        }
    )
    digest = hashlib.sha256(payload).hexdigest()
    assert result == {"sha256": digest, "converted": False}
    assert reports == [("v-1", {"status": "skipped", "sha256": digest})]


async def test_job_converts_image_and_uploads_under_target_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    image = tmp_path / "input.png"
    Image.new("RGB", (400, 300), (10, 20, 30)).save(image)
    uploads: list[tuple[str, str, str]] = []
    reports: list[dict[str, Any]] = []

    async def fake_size(_bucket: str, _key: str) -> int:
        return image.stat().st_size

    async def fake_download(_bucket: str, _key: str, target: Path) -> Path:
        target.write_bytes(image.read_bytes())
        return target

    async def fake_upload(bucket: str, key: str, source: Path, content_type: str) -> None:
        assert source.read_bytes().startswith(b"%PDF")
        uploads.append((bucket, key, content_type))

    async def fake_report(_version_id: str, body: dict[str, Any]) -> dict[str, Any]:
        reports.append(body)
        return {"ok": True}

    monkeypatch.setattr(documents, "object_size", fake_size)
    monkeypatch.setattr(documents, "download", fake_download)
    monkeypatch.setattr(documents, "upload", fake_upload)
    monkeypatch.setattr(documents, "report_document_pdf", fake_report)

    target_key = "spaces/s/files/pdf-file/pdf-version/scan.pdf"
    await documents.document_pdf(
        {
            "versionId": "v-2",
            "name": "scan.png",
            "mime": "image/png",
            "bucket": "files",
            "storageKey": "spaces/s/files/f/v/scan.png",
            "convert": True,
            "target": {
                "fileId": "pdf-file",
                "versionId": "pdf-version",
                "bucket": "files",
                "storageKey": target_key,
            },
        }
    )
    assert uploads == [("files", target_key, "application/pdf")]
    assert reports[0]["status"] == "ready"
    assert reports[0]["storageKey"] == target_key
    assert reports[0]["pdfFileId"] == "pdf-file"
    assert reports[0]["size"] > 0
