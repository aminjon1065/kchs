"""Превью и текст версии файла (09-files.md §3–4).

Чистые функции над локальными файлами: скачивание, загрузку и отчёт в api
выполняет задание `render:file.process`. Внешние программы (poppler,
LibreOffice, tesseract) вызываются с тайм-аутами — недоверенный файл не должен
подвесить воркер.
"""

import re
import shutil
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from PIL import Image, ImageOps

Kind = Literal["image", "pdf", "office", "text", "other"]
Status = Literal["ready", "failed", "unsupported"]

THUMBNAIL_WIDTH = 320
PAGE_WIDTH = 1240
WEB_MAX_SIDE = 2048
PAGE_LIMIT = 30
OCR_PAGE_LIMIT = 10
TEXT_LIMIT = 2_000_000
TEXT_FILE_LIMIT = 4 * 1024 * 1024

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff"}
OFFICE_EXTENSIONS = {
    ".doc", ".docx", ".odt", ".rtf",
    ".xls", ".xlsx", ".ods",
    ".ppt", ".pptx", ".odp",
}  # fmt: skip
TEXT_EXTENSIONS = {".txt", ".csv", ".tsv", ".md", ".json", ".xml", ".log", ".geojson"}

TAJIK_LETTERS = re.compile(r"[ӣӯҳқғҷӢӮҲҚҒҶ]")
CYRILLIC = re.compile(r"[А-Яа-яЁё]")
LATIN = re.compile(r"[A-Za-z]")


@dataclass
class Preview:
    kind: Literal["thumbnail", "page", "web"]
    path: Path
    width: int
    height: int
    page: int | None = None
    mime: str = "image/webp"


@dataclass
class ProcessResult:
    preview_status: Status
    text_status: Status
    previews: list[Preview] = field(default_factory=list)
    text: str | None = None
    lang: str | None = None
    pages: int | None = None
    error: str | None = None


class ToolError(RuntimeError):
    """Внешняя программа завершилась ошибкой или не уложилась в тайм-аут."""


def classify(mime: str, name: str) -> Kind:
    suffix = Path(name).suffix.lower()
    if mime.startswith("image/") or suffix in IMAGE_EXTENSIONS:
        return "image"
    if mime == "application/pdf" or suffix == ".pdf":
        return "pdf"
    if suffix in OFFICE_EXTENSIONS or "officedocument" in mime or "opendocument" in mime:
        return "office"
    if mime.startswith("text/") or suffix in TEXT_EXTENSIONS or mime == "application/json":
        return "text"
    return "other"


def detect_lang(text: str) -> str | None:
    sample = text[:20_000]
    if TAJIK_LETTERS.search(sample):
        return "tg"
    cyrillic = len(CYRILLIC.findall(sample))
    latin = len(LATIN.findall(sample))
    if cyrillic == 0 and latin == 0:
        return None
    return "ru" if cyrillic >= latin else "en"


def run(args: list[str], timeout: int, cwd: Path | None = None) -> str:
    """Запуск программы без оболочки (имя файла не интерпретируется)."""
    try:
        # Аргументы формируем сами, оболочка не используется
        completed = subprocess.run(
            args,
            cwd=cwd,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        raise ToolError(f"{args[0]}: превышено время {timeout} с") from error
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", errors="replace").strip()
        raise ToolError(f"{args[0]}: код {completed.returncode}: {stderr[:500]}")
    return completed.stdout.decode("utf-8", errors="replace")


def save_webp(image: Image.Image, target: Path, max_width: int) -> tuple[int, int]:
    image = ImageOps.exif_transpose(image)
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
    if image.width > max_width:
        height = max(1, round(image.height * max_width / image.width))
        image = image.resize((max_width, height), Image.Resampling.LANCZOS)
    image.save(target, "WEBP", quality=82, method=4)
    return image.width, image.height


def image_previews(source: Path, workdir: Path) -> list[Preview]:
    with Image.open(source) as opened:
        opened.seek(0)  # многокадровые GIF/TIFF — первый кадр
        frame = opened.copy()
    thumb = workdir / "thumbnail.webp"
    tw, th = save_webp(frame, thumb, THUMBNAIL_WIDTH)
    web = workdir / "web.webp"
    longest = max(frame.width, frame.height)
    scale_width = (
        frame.width if longest <= WEB_MAX_SIDE else round(frame.width * WEB_MAX_SIDE / longest)
    )
    ww, wh = save_webp(frame, web, max(1, scale_width))
    return [
        Preview(kind="thumbnail", path=thumb, width=tw, height=th),
        Preview(kind="web", path=web, width=ww, height=wh),
    ]


def pdf_page_count(pdf: Path) -> int:
    info = run(["pdfinfo", str(pdf)], timeout=30)
    match = re.search(r"^Pages:\s+(\d+)", info, re.MULTILINE)
    return int(match.group(1)) if match else 0


def pdf_text(pdf: Path) -> str:
    return run(["pdftotext", "-layout", "-enc", "UTF-8", str(pdf), "-"], timeout=120)


def render_pdf_pages(pdf: Path, workdir: Path, pages: int) -> list[Path]:
    """Страницы в PNG (poppler), затем в WebP нужной ширины."""
    last = min(pages, PAGE_LIMIT)
    if last == 0:
        return []
    prefix = workdir / "page"
    run(
        ["pdftoppm", "-r", "110", "-png", "-f", "1", "-l", str(last), str(pdf), str(prefix)],
        timeout=180,
    )
    return sorted(workdir.glob("page-*.png"), key=lambda p: int(p.stem.split("-")[-1]))


def ocr_pdf(pdf: Path, workdir: Path, pages: int) -> str:
    """OCR страниц без текстового слоя: rus+tgk+eng, если языки установлены."""
    languages = ocr_languages()
    if not languages:
        return ""
    chunks: list[str] = []
    for page in range(1, min(pages, OCR_PAGE_LIMIT) + 1):
        page_dir = workdir / f"ocr-{page}"
        page_dir.mkdir()
        page_arg = str(page)
        run(
            [
                "pdftoppm",
                "-r",
                "200",
                "-png",
                "-f",
                page_arg,
                "-l",
                page_arg,
                str(pdf),
                str(page_dir / "p"),
            ],
            timeout=120,
        )
        for image in sorted(page_dir.glob("*.png")):
            chunks.append(run(["tesseract", str(image), "stdout", "-l", languages], timeout=180))
    return "\n".join(chunks)


def ocr_languages() -> str:
    if shutil.which("tesseract") is None:
        return ""
    available = set(run(["tesseract", "--list-langs"], timeout=30).split())
    wanted = [lang for lang in ("rus", "tgk", "eng") if lang in available]
    return "+".join(wanted)


def office_to_pdf(source: Path, workdir: Path) -> Path:
    """LibreOffice без интерфейса. Отдельный профиль на каждый вызов: параллельные
    конвертации с общим профилем блокируют друг друга."""
    profile = workdir / f"lo-{uuid.uuid4().hex}"
    run(
        [
            "soffice",
            f"-env:UserInstallation=file://{profile}",
            "--headless",
            "--norestore",
            "--convert-to",
            "pdf",
            "--outdir",
            str(workdir),
            str(source),
        ],
        timeout=180,
    )
    produced = workdir / f"{source.stem}.pdf"
    if not produced.exists():
        raise ToolError("soffice: PDF не создан")
    return produced


def process_pdf(pdf: Path, workdir: Path) -> ProcessResult:
    pages = pdf_page_count(pdf)
    text = pdf_text(pdf)
    if len(text.strip()) < 20 and pages > 0:
        text = ocr_pdf(pdf, workdir, pages)

    previews: list[Preview] = []
    rendered = render_pdf_pages(pdf, workdir, pages)
    for index, png in enumerate(rendered, start=1):
        with Image.open(png) as page_image:
            target = workdir / f"page-{index}.webp"
            width, height = save_webp(page_image, target, PAGE_WIDTH)
            previews.append(
                Preview(kind="page", path=target, width=width, height=height, page=index)
            )
            if index == 1:
                thumb = workdir / "thumbnail.webp"
                tw, th = save_webp(page_image, thumb, THUMBNAIL_WIDTH)
                previews.append(Preview(kind="thumbnail", path=thumb, width=tw, height=th))

    clean = text.strip()
    return ProcessResult(
        preview_status="ready" if previews else "failed",
        text_status="ready" if clean else "unsupported",
        previews=previews,
        text=clean[:TEXT_LIMIT] if clean else None,
        lang=detect_lang(clean) if clean else None,
        pages=pages,
    )


def read_text_file(source: Path) -> str:
    raw = source.read_bytes()[:TEXT_FILE_LIMIT]
    for encoding in ("utf-8", "cp1251"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def process(source: Path, mime: str, name: str, workdir: Path) -> ProcessResult:
    """Превью и текст одной версии файла. Исключения внешних программ превращаются
    в статус `failed` — сбой разбора не должен бесконечно повторяться."""
    kind = classify(mime, name)
    try:
        if kind == "image":
            return ProcessResult(
                preview_status="ready",
                text_status="unsupported",
                previews=image_previews(source, workdir),
            )
        if kind == "pdf":
            return process_pdf(source, workdir)
        if kind == "office":
            return process_pdf(office_to_pdf(source, workdir), workdir)
        if kind == "text":
            text = read_text_file(source).strip()
            return ProcessResult(
                preview_status="unsupported",
                text_status="ready" if text else "unsupported",
                text=text[:TEXT_LIMIT] if text else None,
                lang=detect_lang(text) if text else None,
            )
        return ProcessResult(preview_status="unsupported", text_status="unsupported")
    except Exception as error:  # недоверенный файл: любой сбой разбора — статус failed
        return ProcessResult(
            preview_status="failed",
            text_status="failed",
            error=f"{type(error).__name__}: {error}"[:4000],
        )
