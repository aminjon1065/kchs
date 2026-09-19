"""Рендеры модуля документов (ADR-0085): разбор и заполнение шаблонов DOCX в
песочнице Jinja, наложение штампа и водяного знака на PDF (pypdf).

Печать в Chromium — в образе движка: `pytest -m browser`."""

from __future__ import annotations

import asyncio
import io
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("docxtpl")
pytest.importorskip("pypdf")

from docx import Document
from pypdf import PageObject, PdfReader, PdfWriter
from pypdf.generic import ContentStream

from kchs_engine.render import documents
from kchs_engine.render.documents import (
    RenderContentError,
    collect_placeholders,
    fill_template,
    inspect_template,
    merge_overlays,
    page_sizes,
    size_key,
)

# ─── Плейсхолдеры ────────────────────────────────────────────────────────────


def test_placeholders_are_longest_attribute_chains() -> None:
    source = (
        "{{ doc.subject }} {{ doc.fields.addressee }} {{ author.position|upper }}"
        " {{ doc.reg_number or '____' }} {{ doc['summary'] }} {{ today }}"
    )
    assert collect_placeholders(source) == [
        "author.position",
        "doc.fields.addressee",
        "doc.reg_number",
        "doc.subject",
        "doc.summary",
        "today",
    ]


def test_loop_variables_are_not_context() -> None:
    source = (
        "{% for item in doc.attachments %}{{ loop.index }}. {{ item.name }}{% endfor %}"
        "{% set signer_name = signer.short_name %}{{ signer_name }}"
    )
    assert collect_placeholders(source) == ["doc.attachments", "signer.short_name"]


def _docx(path: Path, body: list[str], header: str | None = None) -> Path:
    document = Document()
    for text in body:
        document.add_paragraph(text)
    if header is not None:
        document.sections[0].header.paragraphs[0].text = header
    document.save(str(path))
    return path


def test_inspect_reads_body_and_header(tmp_path: Path) -> None:
    source = _docx(
        tmp_path / "t.docx",
        ["{{ doc.subject }}", "{%p for a in doc.attachments %}", "{{ a.name }}", "{%p endfor %}"],
        header="{{ org.name }}",
    )
    assert inspect_template(source) == ["doc.attachments", "doc.subject", "org.name"]


def test_inspect_syntax_error_is_content_error(tmp_path: Path) -> None:
    source = _docx(tmp_path / "t.docx", ["{{ doc.subject "])
    with pytest.raises(RenderContentError, match="Ошибка в шаблоне"):
        inspect_template(source)


def test_inspect_not_docx(tmp_path: Path) -> None:
    source = tmp_path / "t.docx"
    source.write_bytes(b"not a zip")
    with pytest.raises(RenderContentError, match="Word"):
        inspect_template(source)


# ─── Заполнение ──────────────────────────────────────────────────────────────


def _text(path: Path) -> str:
    return "\n".join(paragraph.text for paragraph in Document(str(path)).paragraphs)


def test_fill_escapes_values_for_word_xml(tmp_path: Path) -> None:
    source = _docx(
        tmp_path / "t.docx",
        ["Тема: {{ doc.subject }}", "{{ doc.fields.addressee }}", "[{{ unknown.path }}]"],
    )
    context: dict[str, Any] = {
        "doc": {"subject": "Смета <2026> & «план»", "fields": {"addressee": "Хукумат"}},
    }
    result = fill_template(source, context, tmp_path / "out.docx")
    text = _text(result)
    assert "Тема: Смета <2026> & «план»" in text
    assert "Хукумат" in text
    # Неизвестный плейсхолдер — пусто, не ошибка
    assert "[]" in text


def test_fill_loops_over_lists(tmp_path: Path) -> None:
    source = _docx(
        tmp_path / "t.docx",
        [
            "{%p for item in doc.attachments %}",
            "{{ loop.index }}. {{ item.name }}",
            "{%p endfor %}",
        ],
    )
    context = {"doc": {"attachments": [{"name": "Смета.xlsx"}, {"name": "Схема.pdf"}]}}
    text = _text(fill_template(source, context, tmp_path / "out.docx"))
    assert "1. Смета.xlsx" in text
    assert "2. Схема.pdf" in text


def test_fill_sandbox_blocks_python_internals(tmp_path: Path) -> None:
    source = _docx(tmp_path / "t.docx", ["{{ ''.__class__.__mro__[1].__subclasses__() }}"])
    with pytest.raises(RenderContentError, match="Ошибка в шаблоне"):
        fill_template(source, {}, tmp_path / "out.docx")


# ─── Наложение ───────────────────────────────────────────────────────────────


def _page_with(width: float, height: float, operators: bytes) -> PageObject:
    """Лист заданного размера с содержимым — операторами PDF."""
    writer = PdfWriter()
    page = writer.add_blank_page(width, height)
    stream = ContentStream(None, writer)
    stream.set_data(operators)
    page.replace_contents(stream)
    return page


def _pdf(pages: list[PageObject], rotate: dict[int, int] | None = None) -> bytes:
    writer = PdfWriter()
    for index, page in enumerate(pages):
        added = writer.add_page(page)
        if rotate and index in rotate:
            added.rotate(rotate[index])
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def test_page_sizes_follow_rotation(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    a4 = (595.0, 842.0)
    source.write_bytes(
        _pdf(
            [_page_with(*a4, b"0 0 1 rg 0 0 10 10 re f"), _page_with(*a4, b"")],
            rotate={1: 90},
        )
    )
    assert page_sizes(source, "first") == [a4]
    # Повёрнутый лист — альбомный: наложение печатается под видимый размер
    assert page_sizes(source, "all") == [a4, (842.0, 595.0)]


def test_merge_overlays_puts_overlay_on_target_pages(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source.write_bytes(
        _pdf([_page_with(595, 842, b"0 0 1 rg 0 0 10 10 re f"), _page_with(595, 842, b"")])
    )
    overlay = _pdf([_page_with(595, 842, b"1 0 0 rg 100 100 50 50 re f")])
    overlays = {size_key((595.0, 842.0)): overlay}

    first, pages = merge_overlays(source, overlays, "first", tmp_path / "first.pdf")
    assert pages == 2
    reader = PdfReader(str(first))
    assert b"100 100 50 50 re" in reader.pages[0].get_contents().get_data()
    second = reader.pages[1].get_contents()
    assert second is None or b"100 100 50 50 re" not in second.get_data()

    every, _ = merge_overlays(source, overlays, "all", tmp_path / "all.pdf")
    for page in PdfReader(str(every)).pages:
        assert b"100 100 50 50 re" in page.get_contents().get_data()
    # Исходник не тронут
    assert b"100 100 50 50 re" not in source.read_bytes()


def test_merge_scales_overlay_to_page(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    source.write_bytes(_pdf([_page_with(600, 800, b"")]))
    # Chromium печатает с точностью до пикселя: наложение чуть другого размера
    overlays = {size_key((600.0, 800.0)): _pdf([_page_with(599.25, 799.5, b"0 g 0 0 5 5 re f")])}
    result, _ = merge_overlays(source, overlays, "first", tmp_path / "out.pdf")
    content = PdfReader(str(result)).pages[0].get_contents().get_data()
    assert b"cm" in content


def test_encrypted_pdf_is_content_error(tmp_path: Path) -> None:
    writer = PdfWriter()
    writer.add_blank_page(100, 100)
    writer.encrypt(user_password="secret", owner_password="owner")
    source = tmp_path / "locked.pdf"
    with source.open("wb") as stream:
        writer.write(stream)
    with pytest.raises(RenderContentError, match="паролем"):
        page_sizes(source, "first")


def test_broken_pdf_is_content_error(tmp_path: Path) -> None:
    source = tmp_path / "broken.pdf"
    source.write_bytes(b"%PDF-1.4\nnot really")
    with pytest.raises(RenderContentError):
        page_sizes(source, "first")


# ─── Задание целиком (api и хранилище — подделки) ────────────────────────────


class FakeApi:
    def __init__(self, start: dict[str, Any]) -> None:
        self.start = start
        self.done: list[dict[str, Any]] = []


@pytest.fixture
def fake_io(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, Any]:
    state: dict[str, Any] = {"objects": {}, "uploaded": {}}

    async def object_size(bucket: str, key: str) -> int:
        return len(state["objects"][(bucket, key)])

    async def download(bucket: str, key: str, target: Path) -> Path:
        target.write_bytes(state["objects"][(bucket, key)])
        return target

    async def upload(bucket: str, key: str, source: Path, content_type: str) -> None:
        state["uploaded"][(bucket, key)] = (source.read_bytes(), content_type)

    monkeypatch.setattr(documents, "object_size", object_size)
    monkeypatch.setattr(documents, "download", download)
    monkeypatch.setattr(documents, "upload", upload)
    return state


def _wire_api(monkeypatch: pytest.MonkeyPatch, api: FakeApi) -> None:
    async def start(render_id: str) -> dict[str, Any]:
        return api.start

    async def done(render_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        api.done.append(payload)
        return {"ok": True, "stale": False}

    monkeypatch.setattr(documents, "document_render_start", start)
    monkeypatch.setattr(documents, "document_render_done", done)


def test_job_fill_uploads_docx_and_reports(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, fake_io: dict[str, Any]
) -> None:
    template = _docx(tmp_path / "t.docx", ["{{ doc.subject }}"])
    fake_io["objects"][("files", "tpl")] = template.read_bytes()
    api = FakeApi(
        {
            "status": "render",
            "plan": {
                "kind": "docx",
                "template": {"bucket": "files", "storageKey": "tpl"},
                "context": {"doc": {"subject": "Ответ на запрос"}},
            },
            "target": {
                "bucket": "files",
                "storageKey": "out/render.docx",
                "fileName": "Ответ.docx",
                "contentType": "application/docx",
            },
        }
    )
    _wire_api(monkeypatch, api)
    result = asyncio.run(documents.document_render({"renderId": "r1"}))
    assert result["kind"] == "docx"
    data, content_type = fake_io["uploaded"][("files", "out/render.docx")]
    assert content_type == "application/docx"
    filled = tmp_path / "filled.docx"
    filled.write_bytes(data)
    assert "Ответ на запрос" in _text(filled)
    assert api.done == [{"status": "ready", "size": len(data), "pages": None}]


def test_job_inspect_reports_placeholders(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, fake_io: dict[str, Any]
) -> None:
    template = _docx(tmp_path / "t.docx", ["{{ doc.subject }} {{ author.position }}"])
    fake_io["objects"][("files", "tpl")] = template.read_bytes()
    api = FakeApi(
        {
            "status": "render",
            "plan": {"kind": "inspect", "template": {"bucket": "files", "storageKey": "tpl"}},
            "target": None,
        }
    )
    _wire_api(monkeypatch, api)
    asyncio.run(documents.document_render({"renderId": "r2"}))
    assert api.done == [{"status": "ready", "placeholders": ["author.position", "doc.subject"]}]


def test_job_bad_template_reports_failure_without_retry(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, fake_io: dict[str, Any]
) -> None:
    template = _docx(tmp_path / "t.docx", ["{% if %}"])
    fake_io["objects"][("files", "tpl")] = template.read_bytes()
    api = FakeApi(
        {
            "status": "render",
            "plan": {
                "kind": "docx",
                "template": {"bucket": "files", "storageKey": "tpl"},
                "context": {},
            },
            "target": {
                "bucket": "files",
                "storageKey": "out",
                "fileName": "x.docx",
                "contentType": "x",
            },
        }
    )
    _wire_api(monkeypatch, api)
    result = asyncio.run(documents.document_render({"renderId": "r3"}))
    assert "failed" in result
    assert api.done[0]["status"] == "failed"
    assert "Ошибка в шаблоне" in api.done[0]["error"]
    assert fake_io["uploaded"] == {}


def test_job_skip_does_nothing(monkeypatch: pytest.MonkeyPatch, fake_io: dict[str, Any]) -> None:
    api = FakeApi({"status": "skip", "reason": "no_access"})
    _wire_api(monkeypatch, api)
    assert asyncio.run(documents.document_render({"renderId": "r4"})) == {"skipped": "no_access"}
    assert api.done == []


# ─── Chromium (образ движка) ─────────────────────────────────────────────────

browser = pytest.mark.browser


def _pixel(pdf: Path, x_ratio: float, y_ratio: float, workdir: Path) -> tuple[int, int, int]:
    """Цвет точки первого листа: pdftoppm → PPM, доли ширины и высоты от левого верхнего угла."""
    prefix = workdir / "raster"
    subprocess.run(
        ["pdftoppm", "-r", "30", "-f", "1", "-l", "1", str(pdf), str(prefix)], check=True
    )
    ppm = next(workdir.glob("raster*.ppm")).read_bytes()
    parts = ppm.split(b"\n", 3)
    width, height = (int(value) for value in parts[1].split())
    pixels = parts[3]
    x = int(width * x_ratio)
    y = int(height * y_ratio)
    offset = (y * width + x) * 3
    return pixels[offset], pixels[offset + 1], pixels[offset + 2]


@browser
@pytest.mark.skipif(shutil.which("pdftoppm") is None, reason="нет poppler")
def test_stamp_overlay_keeps_page_visible(tmp_path: Path, fake_io: dict[str, Any]) -> None:
    """Наложение прозрачно вне штампа: лист под ним виден, штамп — в правом нижнем углу."""
    green = "<html><body style='margin:0;background:#00ff00'>&nbsp;</body></html>"
    source_pdf, _ = asyncio.run(
        documents.render_html({"html": green, "orientation": "portrait", "labels": {}}, tmp_path)
    )
    fake_io["objects"][("files", "scan")] = source_pdf.read_bytes()
    stamp = (
        "<html><body style='margin:0;background:transparent'>"
        "<div style='position:absolute;right:14mm;bottom:12mm;width:50mm;height:20mm;"
        "background:#0000ff'></div></body></html>"
    )
    plan = {
        "kind": "overlay",
        "source": {
            "bucket": "files",
            "storageKey": "scan",
            "name": "scan.pdf",
            "mime": "application/pdf",
        },
        "html": stamp,
        "pages": "first",
    }
    result, pages = asyncio.run(documents.render_overlay(plan, tmp_path))
    assert pages >= 1
    top_left = _pixel(result, 0.3, 0.3, tmp_path)
    assert top_left[1] > 200 and top_left[2] < 60, top_left
    for leftover in tmp_path.glob("raster*.ppm"):
        leftover.unlink()
    corner = _pixel(result, 0.8, 0.92, tmp_path)
    assert corner[2] > 200 and corner[1] < 60, corner


@browser
def test_html_form_blocks_network(tmp_path: Path) -> None:
    page = "<html><body><h1>Карточка</h1><img src='http://127.0.0.1:9/leak.png'></body></html>"
    path, pages = asyncio.run(
        documents.render_html(
            {
                "html": page,
                "orientation": "portrait",
                "footer": "kchs",
                "labels": {"page": "Лист", "of": "из"},
            },
            tmp_path,
        )
    )
    assert path.read_bytes().startswith(b"%PDF")
    assert pages == 1
