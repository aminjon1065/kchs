"""Задания движка по контракту (ADR-0190): нагрузка на входе, результат на выходе.

Источник — zod-схемы `packages/contracts/src/engine/jobs.ts`; `gen:engine` пишет их
JSON Schema в `jobs.json`, а `tests/test_engine_contracts.py` проверяет, что модели
здесь совместимы с ней: движок принимает всё, что может прислать api, и
присылает только то, что api примет. Поля называются как в JSON — словари
заданий и есть эти модели, обработчики читают их по тем же ключам.

Вход (`INBOUND`) — нагрузка задания: лишние поля не мешают (конверт задания,
поле новой версии api), обязательны только поля, без которых движку не обойтись.
Выход (`OUTBOUND`) — результат задания: строгая проверка, лишний ключ или
строка вместо числа — ошибка движка, а не api.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated, Any, Literal, NotRequired, TypedDict

from pydantic import ConfigDict, Field, TypeAdapter, ValidationError, with_config

from kchs_engine.contracts import users_import_contract

INBOUND = ConfigDict(extra="ignore")
OUTBOUND = ConfigDict(extra="forbid", strict=True)

if TYPE_CHECKING:
    UsersImportField = str
    UsersImportIssueCode = str
else:
    # Перечни — из сгенерированного контракта импорта пользователей
    UsersImportField = Literal[tuple(item["key"] for item in users_import_contract()["fields"])]
    UsersImportIssueCode = Literal[tuple(users_import_contract()["issueCodes"])]


@with_config(INBOUND)
class EngineJobEnvelope(TypedDict):
    """Что ядро добавляет к нагрузке при передаче в очередь (`JobService.dispatch`)."""

    jobRecordId: str
    initiatorId: NotRequired[str | None]
    # Токен обратных вызовов этого задания (ADR-0176)
    callbackToken: NotRequired[str]
    callbackScope: NotRequired[str]


# ─── Нагрузка ────────────────────────────────────────────────────────────────


@with_config(INBOUND)
class EngineEchoJob(TypedDict):
    message: str


@with_config(INBOUND)
class DemoGenerateJob(TypedDict):
    profile: str
    # Без seed — seed генератора по умолчанию
    seed: NotRequired[int]
    prefix: str
    bucket: str


@with_config(INBOUND)
class ColumnarColumn(TypedDict):
    name: str
    type: str


@with_config(INBOUND)
class ColumnarBuildJob(TypedDict):
    # Датасет и версию читает api по итогу сборки
    datasetId: NotRequired[str]
    version: NotRequired[int]
    table: str
    bucket: str
    key: str
    columns: list[ColumnarColumn]


@with_config(INBOUND)
class FileProcessJob(TypedDict):
    fileId: str
    versionId: str
    name: NotRequired[str]
    mime: NotRequired[str]
    bucket: str
    storageKey: str
    previewBucket: str
    previewPrefix: str


@with_config(INBOUND)
class DocumentPdfTarget(TypedDict):
    fileId: str
    versionId: str
    bucket: str
    storageKey: str


@with_config(INBOUND)
class DocumentPdfJob(TypedDict):
    documentId: NotRequired[str]
    versionId: str
    name: NotRequired[str]
    mime: NotRequired[str]
    bucket: str
    storageKey: str
    convert: NotRequired[bool]
    target: NotRequired[DocumentPdfTarget]


@with_config(INBOUND)
class DocumentRenderJob(TypedDict):
    renderId: str


@with_config(INBOUND)
class ReportRenderJob(TypedDict):
    runId: str


@with_config(INBOUND)
class MediaTranscribeJob(TypedDict):
    recordingId: str
    meetingId: NotRequired[str]
    bucket: str
    storageKey: str


@with_config(INBOUND)
class UsersParseJob(TypedDict):
    # Режим и файл api читает само, когда движок вернёт строки
    mode: NotRequired[str]
    fileId: NotRequired[str]
    versionId: NotRequired[str]
    bucket: str
    storageKey: str


@with_config(INBOUND)
class ImportOptions(TypedDict, total=False):
    format: str
    encoding: str
    delimiter: str
    sheet: str
    skipRows: int
    headerRows: int
    decimal: str
    thousands: str
    dateOrder: str
    layer: str
    crs: str


@with_config(INBOUND)
class LatLonGeometry(TypedDict):
    kind: Literal["latlon"]
    lat: int
    lon: int


@with_config(INBOUND)
class WktGeometry(TypedDict):
    kind: Literal["wkt"]
    column: int


@with_config(INBOUND)
class GeoJsonGeometry(TypedDict):
    kind: Literal["geojson"]
    column: int


@with_config(INBOUND)
class FeaturesGeometry(TypedDict):
    kind: Literal["features"]


ImportGeometry = Annotated[
    LatLonGeometry | WktGeometry | GeoJsonGeometry | FeaturesGeometry,
    Field(discriminator="kind"),
]


@with_config(INBOUND)
class LangText(TypedDict):
    ru: str
    tg: NotRequired[str]
    en: NotRequired[str]


@with_config(INBOUND)
class FieldFormat(TypedDict, total=False):
    precision: int
    thousands: bool
    dateFormat: str
    currency: str
    scale: str
    prefix: str
    suffix: str


@with_config(INBOUND)
class ImportMappingItem(TypedDict):
    column: int
    fieldKey: str
    # Подпись и семантику поля читает api, нормализации они не нужны
    label: NotRequired[LangText]
    type: str
    semantic: NotRequired[str]
    format: NotRequired[FieldFormat]
    required: NotRequired[bool]


@with_config(INBOUND)
class NormalizeOutput(TypedDict):
    bucket: str
    normalizedKey: str
    errorsKey: str


@with_config(INBOUND)
class DatasetNormalizeJob(TypedDict):
    importId: str
    bucket: str
    storageKey: str
    fileName: NotRequired[str]
    options: NotRequired[ImportOptions]
    mapping: list[ImportMappingItem]
    geometry: NotRequired[ImportGeometry | None]
    geometryField: NotRequired[str | None]
    territories: NotRequired[dict[str, str]]
    output: NormalizeOutput


# ─── Результат ───────────────────────────────────────────────────────────────

ProcessStatus = Literal["ready", "failed", "unsupported"]


@with_config(OUTBOUND)
class TooLarge(TypedDict):
    skipped: Literal["too_large"]
    size: int


@with_config(OUTBOUND)
class EngineEchoJobResult(TypedDict):
    echo: str
    engineVersion: str


@with_config(OUTBOUND)
class DemoGenerateJobResult(TypedDict):
    manifestKey: str
    reused: bool
    datasets: int
    rows: NotRequired[int]


@with_config(OUTBOUND)
class ColumnarBuildJobResult(TypedDict):
    rows: int
    size: int
    buildMs: int
    key: str


@with_config(OUTBOUND)
class FileProcessed(TypedDict):
    previews: int
    textChars: int
    previewStatus: ProcessStatus
    textStatus: ProcessStatus


@with_config(OUTBOUND)
class DocumentHashed(TypedDict):
    sha256: str
    converted: bool
    pages: NotRequired[int | None]


@with_config(OUTBOUND)
class RenderSkipped(TypedDict):
    skipped: str


@with_config(OUTBOUND)
class TemplateInspected(TypedDict):
    placeholders: int


@with_config(OUTBOUND)
class RenderFailed(TypedDict):
    failed: str


@with_config(OUTBOUND)
class DocumentRendered(TypedDict):
    kind: Literal["html", "overlay", "docx", "inspect"]
    pages: int | None
    size: int
    durationMs: int


@with_config(OUTBOUND)
class ReportRendered(TypedDict):
    files: int
    pages: int | None
    durationMs: int


@with_config(OUTBOUND)
class MediaTranscribeJobResult(TypedDict):
    status: Literal["ready", "unavailable", "failed"]
    segments: NotRequired[int]
    language: NotRequired[str | None]


@with_config(OUTBOUND)
class UsersParseJobResult(TypedDict):
    rows: int
    fileError: UsersImportIssueCode | None
    applyJobId: str


@with_config(OUTBOUND)
class DatasetNormalizeJobResult(TypedDict):
    rows: int
    errors: int
    normalizedKey: str
    errorsKey: str | None
    loadJobId: str | None


@dataclass(frozen=True)
class JobContract:
    """Нагрузка и результат задания `<очередь>:<имя>`."""

    payload: TypeAdapter[Any]
    result: TypeAdapter[Any]


def _job(payload: Any, result: Any) -> JobContract:
    return JobContract(TypeAdapter(payload), TypeAdapter(result))


#: Задания движка — те же ключи, что `ENGINE_JOBS` в `packages/contracts`.
JOB_CONTRACTS: dict[str, JobContract] = {
    "transform:engine.echo": _job(EngineEchoJob, EngineEchoJobResult),
    "transform:demo.generate": _job(DemoGenerateJob, DemoGenerateJobResult),
    "transform:columnar.build": _job(ColumnarBuildJob, ColumnarBuildJobResult),
    "render:file.process": _job(FileProcessJob, TooLarge | FileProcessed),
    "render:document.pdf": _job(DocumentPdfJob, TooLarge | DocumentHashed),
    "render:document.render": _job(
        DocumentRenderJob, RenderSkipped | TemplateInspected | RenderFailed | DocumentRendered
    ),
    "render:report.render": _job(ReportRenderJob, RenderSkipped | ReportRendered),
    "media:media.transcribe": _job(MediaTranscribeJob, MediaTranscribeJobResult),
    "imports:users.parse": _job(UsersParseJob, UsersParseJobResult),
    "imports:dataset.normalize": _job(DatasetNormalizeJob, DatasetNormalizeJobResult),
}

ENVELOPE: TypeAdapter[EngineJobEnvelope] = TypeAdapter(EngineJobEnvelope)


def contract_errors(error: ValidationError, limit: int = 5) -> str:
    """Расхождение с контрактом коротко: путь и причина первых ошибок."""
    parts = [
        f"{'.'.join(str(item) for item in issue['loc']) or '<корень>'}: {issue['msg']}"
        for issue in error.errors()[:limit]
    ]
    more = error.error_count() - limit
    return "; ".join(parts) + (f"; и ещё {more}" if more > 0 else "")
