"""Рендер отчёта в Chromium (ADR-0022, ADR-0078): задание `render:report.render`.

Движок не читает базу и не решает о правах: api выдаёт служебный токен страницы
печати пользователя, под чьими правами строится запуск, движок кладёт его в cookie
своего браузера и открывает `/print/report/<запуск>` веба. Страница сама считает
данные с этими правами, дорисовывает графики и карты и сообщает готовность
(`<html data-print-state="ready">`) и модель документа (`window.kchsPrint`). Движок
печатает PDF (A4, колонтитулы, номера страниц), снимает графики и карты картинками
для DOCX (docxtpl) и кладёт файлы в бакет экспортов.
"""

from __future__ import annotations

import asyncio
import html
import json
import re
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from kchs_engine.api import report_render_start, report_rendered
from kchs_engine.config import settings
from kchs_engine.contracts import report_render_contract
from kchs_engine.jobs.registry import PermanentJobError, handler
from kchs_engine.logging import log
from kchs_engine.storage import upload

if TYPE_CHECKING:
    from playwright.async_api import Browser, Playwright

# Поля PDF, мм: колонтитулы — в верхнем и нижнем поле
MARGIN_MM = {"top": 16, "bottom": 16, "left": 14, "right": 14}
A4_MM = (210, 297)
PX_PER_MM = 96 / 25.4
# WebGL карт без GPU — SwiftShader (MapLibre GL 6 требует WebGL 2)
CHROMIUM_ARGS = [
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--disable-dev-shm-usage",
]


@dataclass
class RenderedFile:
    format: str
    key: str
    content_type: str
    path: Path


@dataclass
class RenderOutput:
    files: list[RenderedFile]
    pages: int | None
    timings: dict[str, int] = field(default_factory=dict)


# ─── Браузер ──────────────────────────────────────────────────────────────────

_playwright: Playwright | None = None
_browser: Browser | None = None
_browser_lock = asyncio.Lock()
_slots: asyncio.Semaphore | None = None


def _render_slots() -> asyncio.Semaphore:
    """Страниц печати одновременно: Chromium тяжёлый, остальные ждут."""
    global _slots
    if _slots is None:
        _slots = asyncio.Semaphore(max(1, settings().ENGINE_RENDER_CONCURRENCY))
    return _slots


async def shared_browser() -> Browser:
    """Один Chromium на процесс движка; упавший запускается заново."""
    # Playwright и Chromium — группа `render` образа движка: импорт — при первом рендере
    from playwright.async_api import async_playwright

    global _playwright, _browser
    async with _browser_lock:
        if _browser is None or not _browser.is_connected():
            if _playwright is None:
                _playwright = await async_playwright().start()
            _browser = await _playwright.chromium.launch(args=CHROMIUM_ARGS)
            log.info("render.browser_started", version=_browser.version)
        return _browser


async def close_browser() -> None:
    global _playwright, _browser
    async with _browser_lock:
        if _browser is not None:
            await _browser.close()
            _browser = None
        if _playwright is not None:
            await _playwright.stop()
            _playwright = None


# ─── Печать ───────────────────────────────────────────────────────────────────


def content_width_px(orientation: str) -> int:
    """Ширина окна = ширина поля печати: графики и карты не растягиваются при печати."""
    page = A4_MM[1] if orientation == "landscape" else A4_MM[0]
    return round((page - MARGIN_MM["left"] - MARGIN_MM["right"]) * PX_PER_MM)


def count_pdf_pages(data: bytes) -> int | None:
    """Число страниц PDF Chromium: объекты `/Type /Page` (не `/Pages`)."""
    count = len(re.findall(rb"/Type\s*/Page(?![a-zA-Z])", data))
    return count or None


def header_template(text: str) -> str:
    return (
        "<div style=\"width:100%;margin:0 14mm;font-family:'DejaVu Sans',sans-serif;"
        f'font-size:8px;color:#555">{html.escape(text)}</div>'
    )


def footer_template(text: str, page: str, of: str) -> str:
    return (
        '<div style="width:100%;margin:0 14mm;display:flex;justify-content:space-between;'
        "font-family:'DejaVu Sans',sans-serif;font-size:8px;color:#555\">"
        f"<span>{html.escape(text)}</span>"
        f'<span>{html.escape(page)} <span class="pageNumber"></span> {html.escape(of)} '
        '<span class="totalPages"></span></span></div>'
    )


def appearance_state(web_url: str, locale: str) -> dict[str, Any]:
    """Оформление страницы печати: светлая тема и язык получателя (localStorage веба)."""
    value = {
        "state": {"theme": "light", "density": "comfortable", "fontSize": "m", "locale": locale},
        "version": 0,
    }
    origin = re.sub(r"^(https?://[^/]+).*$", r"\1", web_url)
    return {
        "cookies": [],
        "origins": [
            {
                "origin": origin,
                "localStorage": [{"name": "kchs.appearance", "value": json.dumps(value)}],
            }
        ],
    }


async def render_report(plan: dict[str, Any], workdir: Path) -> RenderOutput:
    """Страница печати запуска → PDF и DOCX в `workdir` по плану api."""
    from playwright.async_api import TimeoutError as PlaywrightTimeout

    from kchs_engine.render.docx_report import DocxLabels, build_docx

    contract = report_render_contract()["print"]
    web_url = settings().KCHS_WEB_URL.rstrip("/")
    orientation = "landscape" if plan.get("orientation") == "landscape" else "portrait"
    formats = [item["format"] for item in plan["files"]]
    timings: dict[str, int] = {}

    async with _render_slots():
        browser = await shared_browser()
        context = await browser.new_context(
            viewport={"width": content_width_px(orientation), "height": 1100},
            device_scale_factor=2,
            locale=str(plan.get("locale") or "ru"),
            timezone_id=str(plan.get("timezone") or "Asia/Dushanbe"),
            storage_state=appearance_state(web_url, str(plan.get("locale") or "ru")),  # type: ignore[arg-type]
        )
        try:
            await context.add_cookies(
                [
                    {
                        "name": contract["cookie"],
                        "value": plan["token"],
                        "url": web_url,
                        "httpOnly": True,
                        "sameSite": "Strict",
                    }
                ]
            )
            page = await context.new_page()
            page.on("pageerror", lambda error: log.warning("render.page_error", error=str(error)))
            await page.emulate_media(media="print")

            started = time.monotonic()
            await page.goto(f"{web_url}{plan['printPath']}", wait_until="domcontentloaded")
            attribute = contract["stateAttribute"]
            try:
                await page.wait_for_selector(
                    f'html[{attribute}="ready"], html[{attribute}="error"]',
                    state="attached",
                    timeout=contract["readyTimeoutMs"],
                )
            except PlaywrightTimeout as error:
                raise RuntimeError("страница печати не дорисовалась вовремя") from error
            timings["ready"] = int((time.monotonic() - started) * 1000)
            state = await page.get_attribute("html", attribute)
            model: dict[str, Any] = await page.evaluate(f"() => window.{contract['modelGlobal']}")
            if state != "ready" or not isinstance(model, dict):
                reason = model.get("error") if isinstance(model, dict) else None
                raise PermanentJobError(str(reason or "страница печати не открылась"))

            files: list[RenderedFile] = []
            by_format = {item["format"]: item for item in plan["files"]}
            pages: int | None = None
            if "pdf" in formats:
                mark = time.monotonic()
                labels = plan.get("labels") or {}
                pdf = await page.pdf(
                    format="A4",
                    landscape=orientation == "landscape",
                    print_background=True,
                    display_header_footer=True,
                    header_template=header_template(str(plan.get("header") or "")),
                    footer_template=footer_template(
                        str(plan.get("footer") or ""),
                        str(labels.get("page") or ""),
                        str(labels.get("of") or ""),
                    ),
                    margin={side: f"{value}mm" for side, value in MARGIN_MM.items()},
                )
                pages = count_pdf_pages(pdf)
                path = workdir / "report.pdf"
                path.write_bytes(pdf)
                item = by_format["pdf"]
                files.append(RenderedFile("pdf", item["key"], item["contentType"], path))
                timings["pdf"] = int((time.monotonic() - mark) * 1000)

            if "docx" in formats:
                mark = time.monotonic()
                images: dict[str, bytes] = {}
                figure = contract["figureAttribute"]
                for block in model.get("blocks", []):
                    if not isinstance(block, dict) or block.get("kind") != "figure":
                        continue
                    locator = page.locator(f'[{figure}="{block.get("id")}"]')
                    if await locator.count() == 0:
                        continue
                    images[str(block.get("id"))] = await locator.first.screenshot(type="png")
                labels = plan.get("labels") or {}
                data = await asyncio.to_thread(
                    build_docx,
                    model,
                    images.get,
                    DocxLabels(
                        header=str(plan.get("header") or ""),
                        footer=str(plan.get("footer") or ""),
                        page=str(labels.get("page") or ""),
                        of=str(labels.get("of") or ""),
                    ),
                )
                path = workdir / "report.docx"
                path.write_bytes(data)
                item = by_format["docx"]
                files.append(RenderedFile("docx", item["key"], item["contentType"], path))
                timings["docx"] = int((time.monotonic() - mark) * 1000)
            return RenderOutput(files=files, pages=pages, timings=timings)
        finally:
            await context.close()


@handler("render", "report.render")
async def report_render(data: dict[str, Any]) -> dict[str, Any]:
    run_id = str(data["runId"])
    started = time.monotonic()
    plan = await report_render_start(run_id)
    if plan.get("status") != "render":
        log.info("report.skipped", run_id=run_id, reason=plan.get("reason"))
        return {"skipped": plan.get("reason")}

    with tempfile.TemporaryDirectory(prefix="kchs-report-") as tmp:
        try:
            output = await asyncio.wait_for(
                render_report(plan, Path(tmp)), timeout=settings().ENGINE_RENDER_TIMEOUT_S
            )
        except TimeoutError as error:
            raise RuntimeError("рендер отчёта не уложился в отведённое время") from error
        uploaded: list[dict[str, Any]] = []
        for file in output.files:
            await upload(plan["bucket"], file.key, file.path, file.content_type)
            uploaded.append(
                {"format": file.format, "key": file.key, "size": file.path.stat().st_size}
            )

    duration = int((time.monotonic() - started) * 1000)
    await report_rendered(
        run_id,
        {
            "files": uploaded,
            "pages": output.pages,
            "durationMs": duration,
            "timings": output.timings,
        },
    )
    log.info(
        "report.rendered",
        run_id=run_id,
        pages=output.pages,
        duration_ms=duration,
        timings=output.timings,
    )
    return {"files": len(uploaded), "pages": output.pages, "durationMs": duration}
