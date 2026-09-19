"""Рендер отчёта в Chromium (ADR-0078): задание открывает страницу печати с cookie
служебного токена, ждёт готовности, печатает PDF и собирает DOCX с картинкой.

Нужен Chromium Playwright — образ движка или `playwright install chromium`:
`pytest -m browser`. Страница печати — поддельная, на локальном HTTP-сервере.
"""

import asyncio
import http.server
import json
import threading
from pathlib import Path
from typing import Any, ClassVar

import pytest

pytest.importorskip("playwright")
pytest.importorskip("docxtpl")

pytestmark = pytest.mark.browser

MODEL = {
    "version": 1,
    "title": "Отчёт о паводках",
    "subtitle": "Период: апрель 2026",
    "settings": {
        "orientation": "portrait",
        "header": "",
        "footer": "",
        "titlePage": False,
        "formats": ["pdf", "docx"],
    },
    "labels": {"page": "Страница", "of": "из"},
    "blocks": [
        {"id": "c1", "kind": "figure", "title": "График", "figure": "chart", "note": None},
        {"id": "b1", "kind": "page_break"},
        {"id": "t1", "kind": "text", "body": {"type": "doc", "content": []}},
    ],
}

PAGE = """<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Отчёт о паводках</title>
<style>.brk{break-before:page}</style></head><body>
<h1>Отчёт о паводках: ҳ ӣ ӯ ҷ қ ғ</h1>
<div data-print-figure="c1" style="width:300px;height:150px"><canvas id="c" width="600" height="300"
 style="width:300px;height:150px"></canvas></div>
<div class="brk"><p>Вторая страница</p></div>
<script>
const g = document.getElementById('c').getContext('2d');
g.fillStyle = '#2050c0'; g.fillRect(20, 20, 400, 200);
window.kchsPrint = MODEL_JSON;
setTimeout(() => { document.documentElement.dataset.printState = 'ready' }, 50);
</script></body></html>"""


class PrintPage(http.server.BaseHTTPRequestHandler):
    cookies: ClassVar[list[str]] = []

    def do_GET(self) -> None:
        PrintPage.cookies.append(self.headers.get("Cookie", ""))
        body = PAGE.replace("MODEL_JSON", json.dumps(MODEL, ensure_ascii=False)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: Any) -> None:
        return


@pytest.fixture
def web_server() -> Any:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), PrintPage)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


async def test_report_job_prints_pdf_and_docx(
    web_server: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from docx import Document

    from kchs_engine.config import settings
    from kchs_engine.render import report

    monkeypatch.setenv("KCHS_WEB_URL", web_server)
    settings.cache_clear()
    uploads: dict[str, bytes] = {}
    rendered: dict[str, Any] = {}

    async def fake_start(run_id: str) -> dict[str, Any]:
        assert run_id == "run-1"
        return {
            "status": "render",
            "token": "p_secret",
            "printPath": "/print/report/run-1",
            "locale": "ru",
            "timezone": "Asia/Dushanbe",
            "title": "Отчёт о паводках",
            "orientation": "portrait",
            "header": "Отчёт о паводках",
            "footer": "КЧС",
            "labels": {"page": "Страница", "of": "из"},
            "bucket": "kchs-exports",
            "files": [
                {
                    "format": "pdf",
                    "key": "reports/r/run-1/report.pdf",
                    "fileName": "a.pdf",
                    "contentType": "application/pdf",
                },
                {
                    "format": "docx",
                    "key": "reports/r/run-1/report.docx",
                    "fileName": "a.docx",
                    "contentType": "x",
                },
            ],
        }

    async def fake_upload(bucket: str, key: str, source: Path, content_type: str) -> None:
        assert bucket == "kchs-exports"
        uploads[key] = source.read_bytes()

    async def fake_rendered(run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        rendered.update(payload)
        return {"ok": True}

    monkeypatch.setattr(report, "report_render_start", fake_start)
    monkeypatch.setattr(report, "upload", fake_upload)
    monkeypatch.setattr(report, "report_rendered", fake_rendered)
    try:
        result = await report.report_render({"runId": "run-1"})
    finally:
        await report.close_browser()
        settings.cache_clear()

    # Страница открыта с cookie служебного токена
    assert any("kchs_print=p_secret" in cookie for cookie in PrintPage.cookies)
    pdf = uploads["reports/r/run-1/report.pdf"]
    assert pdf.startswith(b"%PDF-")
    assert result["pages"] == 2 and rendered["pages"] == 2
    assert {item["format"] for item in rendered["files"]} == {"pdf", "docx"}
    assert rendered["timings"]["ready"] >= 0
    doc = Document(__import__("io").BytesIO(uploads["reports/r/run-1/report.docx"]))
    assert doc.paragraphs[0].text == "Отчёт о паводках"
    # График снят картинкой со страницы печати
    assert len(doc.inline_shapes) == 1


async def test_report_job_fails_permanently_on_page_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    from kchs_engine.config import settings
    from kchs_engine.jobs import PermanentJobError
    from kchs_engine.render import report

    page = tmp_path / "index.html"
    page.write_text(
        '<html><head><meta charset="utf-8"></head><body>'
        "<script>window.kchsPrint={error:'нет доступа'};"
        "document.documentElement.dataset.printState='error'</script></body></html>",
        encoding="utf-8",
    )
    handler = type(
        "H",
        (http.server.SimpleHTTPRequestHandler,),
        {"log_message": lambda *_: None, "translate_path": lambda self, _p: str(page)},
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("KCHS_WEB_URL", f"http://127.0.0.1:{server.server_address[1]}")
    settings.cache_clear()
    plan = {
        "status": "render",
        "token": "p_x",
        "printPath": "/print/report/run-2",
        "orientation": "portrait",
        "files": [
            {"format": "pdf", "key": "k", "fileName": "a.pdf", "contentType": "application/pdf"}
        ],
    }
    try:
        with pytest.raises(PermanentJobError, match="нет доступа"):
            await asyncio.wait_for(report.render_report(plan, tmp_path), timeout=60)
    finally:
        server.shutdown()
        await report.close_browser()
        settings.cache_clear()
