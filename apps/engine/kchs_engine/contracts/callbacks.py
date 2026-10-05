"""Обратные вызовы движка по контракту (ADR-0176, ADR-0190): тело и ответ.

Источник — zod-схемы `ENGINE_CALLBACKS` (`packages/contracts/src/engine/callbacks.ts`),
те же, что у внутренних маршрутов api. Тело — выход движка, проверяется строго;
ответ — вход, лишние поля не мешают. Совместимость с JSON Schema из `jobs.json`
проверяет `tests/test_engine_contracts.py`.
"""

from dataclasses import dataclass
from typing import Annotated, Any, Literal, NotRequired, TypedDict

from pydantic import Field, TypeAdapter, with_config

from kchs_engine.contracts.jobs import (
    INBOUND,
    OUTBOUND,
    ProcessStatus,
    UsersImportField,
    UsersImportIssueCode,
)

# ─── Тела ────────────────────────────────────────────────────────────────────


@with_config(OUTBOUND)
class JobStatusReport(TypedDict):
    status: Literal["running", "succeeded", "failed"]
    progress: NotRequired[float]
    message: NotRequired[str | None]
    result: NotRequired[dict[str, Any]]
    error: NotRequired[str]
    final: NotRequired[bool]


@with_config(OUTBOUND)
class FilePreview(TypedDict):
    kind: Literal["thumbnail", "page", "web"]
    page: NotRequired[int | None]
    storageKey: str
    width: NotRequired[int | None]
    height: NotRequired[int | None]
    mime: NotRequired[str]


@with_config(OUTBOUND)
class FileProcessedInput(TypedDict):
    versionId: str
    previewStatus: ProcessStatus
    textStatus: ProcessStatus
    pages: NotRequired[int | None]
    previews: NotRequired[list[FilePreview]]
    text: NotRequired[str | None]
    lang: NotRequired[str | None]
    error: NotRequired[str | None]


@with_config(OUTBOUND)
class DocumentPdfResult(TypedDict):
    status: Literal["ready", "failed", "unsupported", "skipped"]
    sha256: NotRequired[str | None]
    pdfFileId: NotRequired[str | None]
    pdfVersionId: NotRequired[str | None]
    storageKey: NotRequired[str | None]
    size: NotRequired[int | None]
    pages: NotRequired[int | None]
    error: NotRequired[str | None]


@with_config(OUTBOUND)
class TranscriptSegment(TypedDict):
    start: float
    end: float
    text: str
    speaker: NotRequired[str | None]


@with_config(OUTBOUND)
class TranscriptResult(TypedDict):
    status: Literal["ready", "unavailable", "failed"]
    language: NotRequired[str | None]
    model: NotRequired[str | None]
    durationSeconds: NotRequired[float | None]
    segments: NotRequired[list[TranscriptSegment]]
    error: NotRequired[str | None]


@with_config(OUTBOUND)
class UsersImportIssue(TypedDict):
    code: UsersImportIssueCode
    field: NotRequired[UsersImportField | None]
    params: NotRequired[dict[str, str | int]]


@with_config(OUTBOUND)
class UsersImportRowValues(TypedDict):
    row: int
    values: dict[UsersImportField, str | None]


@with_config(OUTBOUND)
class UsersImportParsed(TypedDict):
    rows: list[UsersImportRowValues]
    columns: dict[UsersImportField, str]
    warnings: NotRequired[list[UsersImportIssue]]
    fileError: NotRequired[UsersImportIssue | None]
    totalRows: int


@with_config(OUTBOUND)
class ImportErrorSample(TypedDict):
    row: int
    column: str
    value: str | None
    reason: str


@with_config(OUTBOUND)
class NormalizedReport(TypedDict):
    jobRecordId: str
    rows: int
    errors: int
    normalizedKey: str
    errorsKey: str | None
    errorSample: list[ImportErrorSample]


@with_config(OUTBOUND)
class ReportRenderedFile(TypedDict):
    format: Literal["pdf", "docx"]
    key: str
    size: int


@with_config(OUTBOUND)
class ReportRenderResult(TypedDict):
    files: list[ReportRenderedFile]
    pages: int | None
    durationMs: int
    timings: NotRequired[dict[str, float]]


@with_config(OUTBOUND)
class DocumentRenderResult(TypedDict):
    status: Literal["ready", "failed"]
    size: NotRequired[int | None]
    pages: NotRequired[int | None]
    placeholders: NotRequired[list[str] | None]
    error: NotRequired[str | None]


# ─── Ответы ──────────────────────────────────────────────────────────────────


@with_config(INBOUND)
class Ok(TypedDict):
    ok: bool


@with_config(INBOUND)
class OkStale(TypedDict):
    ok: bool
    # Результат относится к устаревшей версии: api его не применило
    stale: bool


@with_config(INBOUND)
class TranscriptSaved(TypedDict):
    ok: Literal[True]


@with_config(INBOUND)
class UsersImportParsedReply(TypedDict):
    applyJobId: str


@with_config(INBOUND)
class NormalizedReply(TypedDict):
    loadJobId: str | None


@with_config(INBOUND)
class PrintLabels(TypedDict):
    page: str
    of: str


@with_config(INBOUND)
class ReportRenderFile(TypedDict):
    format: str
    key: str
    fileName: str
    contentType: str


@with_config(INBOUND)
class ReportRenderPlan(TypedDict):
    status: Literal["render"]
    token: str
    printPath: str
    locale: str
    timezone: str
    title: str
    pageSize: str
    orientation: str
    header: str
    footer: str
    labels: PrintLabels
    bucket: str
    files: list[ReportRenderFile]


@with_config(INBOUND)
class RenderSkip(TypedDict):
    status: Literal["skip"]
    reason: str


ReportRenderStart = Annotated[ReportRenderPlan | RenderSkip, Field(discriminator="status")]


@with_config(INBOUND)
class StoredObject(TypedDict):
    bucket: str
    storageKey: str


@with_config(INBOUND)
class OverlaySource(TypedDict):
    bucket: str
    storageKey: str
    name: str
    mime: str


@with_config(INBOUND)
class HtmlPlan(TypedDict):
    kind: Literal["html"]
    html: str
    title: str
    orientation: str
    footer: str
    labels: PrintLabels


@with_config(INBOUND)
class OverlayPlan(TypedDict):
    kind: Literal["overlay"]
    source: OverlaySource
    html: str
    pages: str


@with_config(INBOUND)
class DocxPlan(TypedDict):
    kind: Literal["docx"]
    template: StoredObject
    context: dict[str, Any]


@with_config(INBOUND)
class InspectPlan(TypedDict):
    kind: Literal["inspect"]
    template: StoredObject


DocumentRenderPlan = Annotated[
    HtmlPlan | OverlayPlan | DocxPlan | InspectPlan, Field(discriminator="kind")
]


@with_config(INBOUND)
class DocumentRenderTarget(TypedDict):
    bucket: str
    storageKey: str
    fileName: str
    contentType: str


@with_config(INBOUND)
class DocumentRenderGo(TypedDict):
    status: Literal["render"]
    plan: DocumentRenderPlan
    # Нет у разбора шаблона: результат — список плейсхолдеров, а не файл
    target: DocumentRenderTarget | None


DocumentRenderStart = Annotated[RenderSkip | DocumentRenderGo, Field(discriminator="status")]


@dataclass(frozen=True)
class CallbackContract:
    """Тело (`None` — вызов без тела) и ответ обратного вызова."""

    body: TypeAdapter[Any] | None
    reply: TypeAdapter[Any]


def _callback(body: Any, reply: Any) -> CallbackContract:
    return CallbackContract(None if body is None else TypeAdapter(body), TypeAdapter(reply))


#: Те же имена, что `ENGINE_CALLBACKS` в `packages/contracts`; пути — в `jobs.json`.
CALLBACK_CONTRACTS: dict[str, CallbackContract] = {
    "jobStatus": _callback(JobStatusReport, Ok),
    "fileProcessed": _callback(FileProcessedInput, OkStale),
    "documentPdf": _callback(DocumentPdfResult, OkStale),
    "recordingTranscript": _callback(TranscriptResult, TranscriptSaved),
    "usersImportParsed": _callback(UsersImportParsed, UsersImportParsedReply),
    "importNormalized": _callback(NormalizedReport, NormalizedReply),
    "reportRenderStart": _callback(None, ReportRenderStart),
    "reportRendered": _callback(ReportRenderResult, Ok),
    "documentRenderStart": _callback(None, DocumentRenderStart),
    "documentRenderDone": _callback(DocumentRenderResult, OkStale),
}
