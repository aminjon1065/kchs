"""Рендеры модуля документов (ADR-0085): задание `render:document.render`.

Движок не читает базу и не решает о правах: по идентификатору рендера он берёт
у api план (`/internal/documents/renders/<id>/start`), собранный с правами
заказчика в этот момент, и сообщает результат (`…/done`). Виды плана:

- `html` — печатная форма: страница, собранная api, печатается Chromium в PDF A4
  с колонтитулом «Лист N из M»; сеть страницы закрыта, скрипты выключены;
- `overlay` — штамп или водяной знак: страница наложения печатается под размер
  каждого листа (одна на каждый размер) и накладывается на PDF (pypdf); не-PDF
  сначала переводится в PDF, как PDF-представление версии;
- `docx` — заполнение шаблона docxtpl в песочнице Jinja (`SandboxedEnvironment`,
  автоэкранирование XML): шаблон пишет администратор справочника, но из шаблона
  нельзя добраться до Python;
- `inspect` — разбор шаблона: пути плейсхолдеров (`doc.subject`,
  `doc.fields.addressee`) без переменных циклов.
"""

from __future__ import annotations

import asyncio
import io
import tempfile
import time
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

from kchs_engine.api import document_render_done, document_render_start
from kchs_engine.config import settings
from kchs_engine.contracts import document_render_contract
from kchs_engine.files.pdf import to_pdf
from kchs_engine.files.processing import ToolError
from kchs_engine.jobs.registry import handler
from kchs_engine.logging import log
from kchs_engine.render.report import (
    MARGIN_MM,
    count_pdf_pages,
    footer_template,
    render_slots,
    shared_browser,
)
from kchs_engine.storage import download, object_size, upload

if TYPE_CHECKING:
    from jinja2 import nodes as jinja_nodes

PDF_MIME = "application/pdf"


class RenderContentError(Exception):
    """Сбой из-за содержимого (шаблон, файл): повтор не поможет, рендер — «не удался».

    Текст — причина по-русски, её увидит пользователь.
    """


# ─── Разбор и заполнение шаблона DOCX ────────────────────────────────────────


def _sandbox() -> Any:
    """Песочница Jinja: без доступа к внутренностям Python; неизвестный путь
    (`{{ unknown.path }}`) — пустая строка, а не ошибка заполнения."""
    from jinja2 import ChainableUndefined
    from jinja2.sandbox import SandboxedEnvironment

    return SandboxedEnvironment(autoescape=True, undefined=ChainableUndefined)


def _unreadable() -> tuple[type[BaseException], ...]:
    """Ошибки чтения файла шаблона: не ZIP, не пакет Word, битый XML."""
    from docx.opc.exceptions import PackageNotFoundError
    from lxml.etree import XMLSyntaxError

    return (zipfile.BadZipFile, PackageNotFoundError, XMLSyntaxError, KeyError, ValueError)


def _template_source(path: Path) -> str:
    """Текст шаблона для Jinja: тело, верхние и нижние колонтитулы (как у docxtpl)."""
    from docx import Document
    from docx.oxml import parse_xml
    from docxtpl import DocxTemplate

    template = DocxTemplate(str(path))
    document = Document(str(path))
    xml = template.patch_xml(template.xml_to_string(document._element.body))
    for uri in (template.HEADER_URI, template.FOOTER_URI):
        for relation in document.part.rels.values():
            if relation.reltype == uri and relation.target_part.blob:
                part = template.xml_to_string(parse_xml(relation.target_part.blob))
                xml += template.patch_xml(part)
    return xml


def _chain(node: jinja_nodes.Node) -> list[str] | None:
    """`doc.fields.addressee` / `doc['fields']` → ['doc', 'fields', 'addressee']."""
    from jinja2 import nodes

    parts: list[str] = []
    current: Any = node
    while True:
        if isinstance(current, nodes.Getattr):
            parts.append(current.attr)
            current = current.node
        elif (
            isinstance(current, nodes.Getitem)
            and isinstance(current.arg, nodes.Const)
            and isinstance(current.arg.value, str)
        ):
            parts.append(current.arg.value)
            current = current.node
        elif isinstance(current, nodes.Name):
            parts.append(current.name)
            return list(reversed(parts))
        else:
            return None


def _names(target: Any) -> set[str]:
    """Имена, которые объявляет цикл или присваивание (`for a, b in …`)."""
    from jinja2 import nodes

    if isinstance(target, nodes.Name):
        return {target.name}
    if isinstance(target, nodes.Tuple):
        return set().union(*(_names(item) for item in target.items))
    return set()


def collect_placeholders(source: str) -> list[str]:
    """Пути плейсхолдеров шаблона: самые длинные цепочки атрибутов от корня контекста.

    Переменные циклов и присваиваний шаблона (и `loop`) — не контекст: их пути
    не возвращаются, а выражение цикла (`doc.attachments`) — возвращается.
    """
    from jinja2 import nodes

    found: set[str] = set()

    def visit(node: Any, bound: frozenset[str]) -> None:
        if isinstance(node, (nodes.Getattr, nodes.Getitem)):
            chain = _chain(node)
            if chain is not None:
                if chain[0] not in bound:
                    found.add(".".join(chain))
                return
        if isinstance(node, nodes.Name):
            if node.ctx == "load" and node.name not in bound:
                found.add(node.name)
            return
        if isinstance(node, nodes.For):
            visit(node.iter, bound)
            inner = bound | _names(node.target) | {"loop"}
            if node.test is not None:
                visit(node.test, inner)
            for child in [*node.body, *node.else_]:
                visit(child, inner)
            return
        if isinstance(node, nodes.Assign):
            visit(node.node, bound)
            return
        for child in node.iter_child_nodes():
            visit(child, bound)

    tree = _sandbox().parse(source)
    # Присваивания верхнего уровня видны дальше по шаблону
    bound: set[str] = set()
    for statement in tree.body:
        if isinstance(statement, nodes.Assign):
            bound |= _names(statement.target)
    visit(tree, frozenset(bound))
    return sorted(found)


def _template_error(error: Exception) -> RenderContentError:
    from jinja2 import TemplateError

    if isinstance(error, TemplateError):
        return RenderContentError(f"Ошибка в шаблоне: {error}")
    return RenderContentError("Файл шаблона не читается как документ Word (.docx)")


def inspect_template(path: Path) -> list[str]:
    """Разбор шаблона: пути плейсхолдеров; синтаксическая ошибка — причина для автора."""
    from jinja2 import TemplateError

    try:
        return collect_placeholders(_template_source(path))
    except (TemplateError, *_unreadable()) as error:
        raise _template_error(error) from error


def fill_template(path: Path, context: dict[str, Any], target: Path) -> Path:
    """Заполнение шаблона в песочнице: значения экранируются для XML Word."""
    from docxtpl import DocxTemplate
    from jinja2 import TemplateError

    try:
        template = DocxTemplate(str(path))
        template.render(context, jinja_env=_sandbox(), autoescape=True)
        template.save(str(target))
    except (TemplateError, *_unreadable()) as error:
        raise _template_error(error) from error
    return target


# ─── Наложение на PDF ────────────────────────────────────────────────────────


def _open_pdf(path: Path) -> Any:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted and not reader.decrypt(""):
            raise RenderContentError("PDF защищён паролем — наложение невозможно")
        _ = len(reader.pages)
    except PdfReadError as error:
        raise RenderContentError("PDF не читается") from error
    return reader


def page_sizes(path: Path, pages: str) -> list[tuple[float, float]]:
    """Размеры листов (pt) с учётом поворота: те, на которые ляжет наложение."""
    from pypdf import PdfWriter

    writer = PdfWriter(clone_from=_open_pdf(path))
    targets = [0] if pages == "first" else range(len(writer.pages))
    sizes: list[tuple[float, float]] = []
    for index in targets:
        page = writer.pages[index]
        page.transfer_rotation_to_content()
        box = page.cropbox
        sizes.append((float(box.width), float(box.height)))
    return sizes


def size_key(size: tuple[float, float]) -> tuple[float, float]:
    return (round(size[0], 1), round(size[1], 1))


def merge_overlays(
    source: Path,
    overlays: dict[tuple[float, float], bytes],
    pages: str,
    target: Path,
) -> tuple[Path, int]:
    """Наложение на листы PDF: поворот листа переносится в содержимое, наложение
    масштабируется под лист (Chromium округляет размер до пикселя) и ставится в
    угол видимой области. Исходный файл не меняется — результат в `target`."""
    from pypdf import PdfReader, PdfWriter, Transformation

    writer = PdfWriter(clone_from=_open_pdf(source))
    targets = [0] if pages == "first" else range(len(writer.pages))
    for index in targets:
        page = writer.pages[index]
        page.transfer_rotation_to_content()
        box = page.cropbox
        width, height = float(box.width), float(box.height)
        overlay = PdfReader(io.BytesIO(overlays[size_key((width, height))])).pages[0]
        scale_x = width / float(overlay.mediabox.width)
        scale_y = height / float(overlay.mediabox.height)
        page.merge_transformed_page(
            overlay,
            Transformation().scale(scale_x, scale_y).translate(float(box.left), float(box.bottom)),
        )
    with target.open("wb") as stream:
        writer.write(stream)
    return target, len(writer.pages)


# ─── Chromium ────────────────────────────────────────────────────────────────


async def _print_page(html: str, options: dict[str, Any]) -> bytes:
    """Страница, собранная api, — в PDF: без скриптов и без сети (все запросы отклоняются).

    Страниц печати одновременно — не больше, чем у рендера отчётов (общий семафор)."""
    async with render_slots():
        browser = await shared_browser()
        context = await browser.new_context(java_script_enabled=False)
        try:
            await context.route("**/*", lambda route: route.abort())
            page = await context.new_page()
            await page.set_content(html, wait_until="load")
            await page.emulate_media(media="print")
            data: bytes = await page.pdf(**options)
            return data
        finally:
            await context.close()


async def render_html(plan: dict[str, Any], workdir: Path) -> tuple[Path, int | None]:
    labels = plan.get("labels") or {}
    data = await _print_page(
        str(plan["html"]),
        {
            "format": "A4",
            "landscape": plan.get("orientation") == "landscape",
            "print_background": True,
            "display_header_footer": True,
            "header_template": "<span></span>",
            "footer_template": footer_template(
                str(plan.get("footer") or ""),
                str(labels.get("page") or ""),
                str(labels.get("of") or ""),
            ),
            "margin": {side: f"{value}mm" for side, value in MARGIN_MM.items()},
        },
    )
    path = workdir / "print.pdf"
    path.write_bytes(data)
    return path, count_pdf_pages(data)


async def render_overlay(plan: dict[str, Any], workdir: Path) -> tuple[Path, int]:
    contract = document_render_contract()
    source_meta = plan["source"]
    size = await object_size(str(source_meta["bucket"]), str(source_meta["storageKey"]))
    if size > int(contract["maxSourceBytes"]):
        raise RenderContentError("Файл слишком большой для наложения")
    name = str(source_meta.get("name") or "source")
    mime = str(source_meta.get("mime") or "application/octet-stream")
    suffix = Path(name).suffix.lower() or ".bin"
    source = await download(
        str(source_meta["bucket"]), str(source_meta["storageKey"]), workdir / f"source{suffix}"
    )
    if mime != PDF_MIME and suffix != ".pdf":
        try:
            # Не-PDF (офисный файл, скан) — сначала в PDF, как PDF-представление версии
            source = await asyncio.to_thread(to_pdf, source, mime, name, workdir)
        except ToolError as error:
            raise RenderContentError(f"Файл не переводится в PDF: {error}") from error
    pages = str(plan.get("pages") or "first")
    sizes = await asyncio.to_thread(page_sizes, source, pages)
    overlays: dict[tuple[float, float], bytes] = {}
    for width, height in sizes:
        key = size_key((width, height))
        if key in overlays:
            continue
        overlays[key] = await _print_page(
            str(plan["html"]),
            {
                "width": f"{width / 72:.4f}in",
                "height": f"{height / 72:.4f}in",
                "print_background": True,
                "margin": {"top": "0", "right": "0", "bottom": "0", "left": "0"},
                "page_ranges": "1",
            },
        )
    return await asyncio.to_thread(merge_overlays, source, overlays, pages, workdir / "result.pdf")


async def _template(plan: dict[str, Any], workdir: Path) -> Path:
    template = plan["template"]
    size = await object_size(str(template["bucket"]), str(template["storageKey"]))
    if size > int(document_render_contract()["maxTemplateBytes"]):
        raise RenderContentError("Шаблон слишком большой")
    return await download(
        str(template["bucket"]), str(template["storageKey"]), workdir / "template.docx"
    )


async def _produce(plan: dict[str, Any], workdir: Path) -> tuple[Path, int | None]:
    kind = plan["kind"]
    if kind == "html":
        return await render_html(plan, workdir)
    if kind == "overlay":
        return await render_overlay(plan, workdir)
    if kind == "docx":
        source = await _template(plan, workdir)
        context = plan.get("context") or {}
        filled = await asyncio.to_thread(fill_template, source, context, workdir / "filled.docx")
        return filled, None
    raise RenderContentError(f"Неизвестный вид рендера: {kind}")


@handler("render", "document.render")
async def document_render(data: dict[str, Any]) -> dict[str, Any]:
    render_id = str(data["renderId"])
    started = time.monotonic()
    start = await document_render_start(render_id)
    if start.get("status") != "render":
        log.info("document.render_skipped", render_id=render_id, reason=start.get("reason"))
        return {"skipped": start.get("reason")}
    plan: dict[str, Any] = start["plan"]
    target: dict[str, Any] | None = start.get("target")

    with tempfile.TemporaryDirectory(prefix="kchs-render-") as tmp:
        workdir = Path(tmp)
        try:
            if plan["kind"] == "inspect":
                source = await _template(plan, workdir)
                placeholders = await asyncio.to_thread(inspect_template, source)
                await document_render_done(
                    render_id, {"status": "ready", "placeholders": placeholders}
                )
                return {"placeholders": len(placeholders)}
            output, pages = await asyncio.wait_for(
                _produce(plan, workdir), timeout=settings().ENGINE_RENDER_TIMEOUT_S
            )
        except RenderContentError as error:
            await document_render_done(render_id, {"status": "failed", "error": str(error)[:4000]})
            log.warning("document.render_failed", render_id=render_id, error=str(error))
            return {"failed": str(error)}
        except TimeoutError as error:
            raise RuntimeError("рендер не уложился в отведённое время") from error
        if target is None:
            raise RuntimeError("api не выдало ключ результата")
        await upload(
            str(target["bucket"]), str(target["storageKey"]), output, str(target["contentType"])
        )
        size = output.stat().st_size

    await document_render_done(render_id, {"status": "ready", "size": size, "pages": pages})
    duration = int((time.monotonic() - started) * 1000)
    log.info(
        "document.rendered",
        render_id=render_id,
        kind=plan["kind"],
        pages=pages,
        duration_ms=duration,
    )
    return {"kind": plan["kind"], "pages": pages, "size": size, "durationMs": duration}
