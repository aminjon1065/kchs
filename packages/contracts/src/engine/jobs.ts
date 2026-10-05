import { z } from 'zod'
import { UsersImportIssueCode, UsersImportMode } from '../admin/users-import.js'
import { Uuid } from '../common/primitives.js'
import { COLUMNAR_FIELD_TYPES } from '../data/field-storage.js'
import { ImportGeometry, ImportMappingItem, ImportOptions } from '../data/import.js'
import { DOCUMENT_RENDER_PLAN_KINDS } from '../documents/print.js'
import type { QueueName } from '../jobs/job.js'
import { TRANSCRIBE_JOB, TranscriptResult } from '../meetings/recording.js'

/**
 * Задания Python-движка (ADR-0190): нагрузка, которую api кладёт в очередь, и
 * результат, который движок возвращает реестру заданий. Api проверяет нагрузку
 * схемой до записи в реестр (`JobService.schedule`), движок — моделью на входе
 * обработчика; модели движка сверяет с JSON Schema отсюда `tests/test_engine_contracts.py`
 * (`pnpm --filter @kchs/contracts gen:engine` → `kchs_engine/contracts/jobs.json`).
 */

/**
 * Поля, которые ядро добавляет к нагрузке при передаче задания в очередь
 * (`JobService.dispatch`): запись реестра, инициатор, токен обратных вызовов и
 * ресурс, который токен открывает (ADR-0176).
 */
export const EngineJobEnvelope = z.object({
  jobRecordId: Uuid,
  initiatorId: Uuid.nullable(),
  callbackToken: z.string().min(1),
  /** `<вид>:<id>` — ресурс маршрута обратного вызова, например `import:<id>`. */
  callbackScope: z.string().optional(),
})
export type EngineJobEnvelope = z.infer<typeof EngineJobEnvelope>

const Bucket = z.string().min(1)
const StorageKey = z.string().min(1).max(1024)

/** Проверка сквозного пути api → очередь → движок → результат. */
export const EngineEchoJob = z.object({ message: z.string().max(1000) })
export const EngineEchoJobResult = z.object({ echo: z.string(), engineVersion: z.string() })

/** Профили демо-данных генератора движка (ADR-0063). */
export const DEMO_PROFILES = ['small', 'demo'] as const
export type DemoProfile = (typeof DEMO_PROFILES)[number]

/** Файлы демо-данных и `manifest.json` под префиксом профиля и seed. */
export const DemoGenerateJob = z.object({
  profile: z.enum(DEMO_PROFILES),
  seed: z.number().int(),
  prefix: z.string().min(1),
  bucket: Bucket,
})
export const DemoGenerateJobResult = z.object({
  manifestKey: z.string(),
  /** Манифест того же профиля и seed уже был — файлы не генерировались. */
  reused: z.boolean(),
  datasets: z.number().int().nonnegative(),
  /** Строк сгенерировано; нет, если файлы уже были. */
  rows: z.number().int().nonnegative().optional(),
})

/** Колоночная копия версии датасета (ADR-0109). */
export const ColumnarBuildJob = z.object({
  datasetId: Uuid,
  /** Версия данных, с которой снимается копия. */
  version: z.number().int().nonnegative(),
  /** Таблица датасета в схеме `ds`. */
  table: z.string().min(1).max(63),
  bucket: Bucket,
  key: StorageKey,
  /** Системные столбцы и хранимые поля; тип — из реестра хранения полей. */
  columns: z
    .array(z.object({ name: z.string().min(1).max(63), type: z.enum(COLUMNAR_FIELD_TYPES) }))
    .min(1),
})
export const ColumnarBuildJobResult = z.object({
  rows: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  buildMs: z.number().int().nonnegative(),
  key: StorageKey,
})
export type ColumnarBuildJobResult = z.infer<typeof ColumnarBuildJobResult>

/** Превью и текст версии файла (09-files.md §3–4). */
export const FileProcessJob = z.object({
  fileId: Uuid,
  versionId: Uuid,
  name: z.string(),
  mime: z.string(),
  bucket: Bucket,
  storageKey: StorageKey,
  previewBucket: Bucket,
  /** Каталог превью версии: ключи превью движок кладёт только под ним. */
  previewPrefix: StorageKey,
})
const ProcessStatus = z.enum(['ready', 'failed', 'unsupported'])
/** Файл больше предела обработки — превью не строились. */
const TooLarge = z.object({ skipped: z.literal('too_large'), size: z.number().int().nonnegative() })
export const FileProcessJobResult = z.union([
  TooLarge,
  z.object({
    previews: z.number().int().nonnegative(),
    textChars: z.number().int().nonnegative(),
    previewStatus: ProcessStatus,
    textStatus: ProcessStatus,
  }),
])

/** Хэш версии документа и её PDF-представление (ADR-0080). */
export const DocumentPdfJob = z.object({
  documentId: Uuid,
  versionId: Uuid,
  name: z.string(),
  mime: z.string(),
  bucket: Bucket,
  storageKey: StorageKey,
  /** Перевести в PDF (офисные форматы, изображения); иначе — только хэш. */
  convert: z.boolean(),
  /** Файл PDF-представления: идентификаторы и ключ api выдаёт заранее. */
  target: z
    .object({ fileId: Uuid, versionId: Uuid, bucket: Bucket, storageKey: StorageKey })
    .optional(),
})
export const DocumentPdfJobResult = z.union([
  TooLarge,
  z.object({
    sha256: z.string(),
    converted: z.boolean(),
    pages: z.number().int().nonnegative().nullable().optional(),
  }),
])

/** Рендер модуля документов (ADR-0085): план движок берёт у api, когда начинает. */
export const DocumentRenderJob = z.object({ renderId: Uuid })
export const DocumentRenderJobResult = z.union([
  /** api ответило `skip`: рендер не нужен. */
  z.object({ skipped: z.string() }),
  /** Разбор шаблона: найдено плейсхолдеров. */
  z.object({ placeholders: z.number().int().nonnegative() }),
  /** Содержимое не рендерится (шаблон, файл) — сбой сообщён api, повтор не нужен. */
  z.object({ failed: z.string() }),
  z.object({
    kind: z.enum(DOCUMENT_RENDER_PLAN_KINDS),
    pages: z.number().int().nonnegative().nullable(),
    size: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
])

/** Печать запуска отчёта (ADR-0078): параметры движок берёт у api, когда начинает. */
export const ReportRenderJob = z.object({ runId: Uuid })
export const ReportRenderJobResult = z.union([
  z.object({ skipped: z.string() }),
  z.object({
    files: z.number().int().min(1),
    pages: z.number().int().nonnegative().nullable(),
    durationMs: z.number().int().nonnegative(),
  }),
])

/** Расшифровка записи встречи (ADR-0092). */
export const MediaTranscribeJob = z.object({
  recordingId: Uuid,
  meetingId: Uuid,
  bucket: Bucket,
  storageKey: StorageKey,
})
export const MediaTranscribeJobResult = z.object({
  status: TranscriptResult.shape.status,
  /** Нет, если модель распознавания не настроена (`unavailable`). */
  segments: z.number().int().nonnegative().optional(),
  language: z.string().nullable().optional(),
})

/**
 * Разбор XLSX импорта пользователей (ADR-0041). `mode` и `fileId` читает api,
 * когда движок вернёт строки; движку нужны запись задания и файл.
 */
export const UsersParseJob = z.object({
  mode: UsersImportMode,
  fileId: Uuid,
  versionId: Uuid,
  bucket: Bucket,
  storageKey: StorageKey,
})
export const UsersParseJobResult = z.object({
  rows: z.number().int().nonnegative(),
  fileError: UsersImportIssueCode.nullable(),
  applyJobId: Uuid,
})

/** Нормализация файла импорта датасета (ADR-0046): CSV для загрузки и CSV ошибок. */
export const DatasetNormalizeJob = z.object({
  importId: Uuid,
  bucket: Bucket,
  storageKey: StorageKey,
  fileName: z.string(),
  options: ImportOptions,
  mapping: z.array(ImportMappingItem).min(1),
  geometry: ImportGeometry.nullable(),
  /** Поле геометрии датасета; `null` — геометрия не загружается. */
  geometryField: z.string().nullable(),
  /** Справочник полей-территорий: ключ сопоставления → идентификатор, `""` — неоднозначно (ADR-0057). */
  territories: z.record(z.string(), z.string()).optional(),
  /** Куда положить нормализованный CSV и CSV ошибок. */
  output: z.object({ bucket: Bucket, normalizedKey: StorageKey, errorsKey: StorageKey }),
})
export const DatasetNormalizeJobResult = z.object({
  rows: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  normalizedKey: StorageKey,
  errorsKey: StorageKey.nullable(),
  /** Задание загрузки воркеру; `null` — api её не поставило (импорт закрыт). */
  loadJobId: Uuid.nullable(),
})

function job<
  const Q extends QueueName,
  const N extends string,
  P extends z.ZodObject,
  R extends z.ZodType,
>(queue: Q, name: N, payload: P, result: R) {
  return { queue, name, payload, result }
}

/**
 * Все задания движка: ключ — `<очередь>:<имя>`, как у реестра обработчиков в
 * обоих процессах. Обработчик движка без записи здесь не регистрируется.
 */
export const ENGINE_JOBS = {
  'transform:engine.echo': job('transform', 'engine.echo', EngineEchoJob, EngineEchoJobResult),
  'transform:demo.generate': job(
    'transform',
    'demo.generate',
    DemoGenerateJob,
    DemoGenerateJobResult,
  ),
  'transform:columnar.build': job(
    'transform',
    'columnar.build',
    ColumnarBuildJob,
    ColumnarBuildJobResult,
  ),
  'render:file.process': job('render', 'file.process', FileProcessJob, FileProcessJobResult),
  'render:document.pdf': job('render', 'document.pdf', DocumentPdfJob, DocumentPdfJobResult),
  'render:document.render': job(
    'render',
    'document.render',
    DocumentRenderJob,
    DocumentRenderJobResult,
  ),
  'render:report.render': job('render', 'report.render', ReportRenderJob, ReportRenderJobResult),
  'media:media.transcribe': job(
    TRANSCRIBE_JOB.queue,
    TRANSCRIBE_JOB.name,
    MediaTranscribeJob,
    MediaTranscribeJobResult,
  ),
  'imports:users.parse': job('imports', 'users.parse', UsersParseJob, UsersParseJobResult),
  'imports:dataset.normalize': job(
    'imports',
    'dataset.normalize',
    DatasetNormalizeJob,
    DatasetNormalizeJobResult,
  ),
} as const

export type EngineJobKey = keyof typeof ENGINE_JOBS
export type EngineJobSpec<K extends EngineJobKey = EngineJobKey> = (typeof ENGINE_JOBS)[K]
/** Нагрузка задания, как её передаёт вызывающий код (до значений по умолчанию). */
export type EngineJobInput<K extends EngineJobKey> = z.input<EngineJobSpec<K>['payload']>

/** Задание движка по очереди и имени; `undefined` — такого задания у движка нет. */
export function engineJobSpec(queue: string, name: string): EngineJobSpec | undefined {
  return (ENGINE_JOBS as Record<string, EngineJobSpec>)[`${queue}:${name}`]
}

/** Очередь и имя задания — для сравнения с записью реестра заданий. */
export function engineJobRef<K extends EngineJobKey>(
  key: K,
): { readonly queue: EngineJobSpec<K>['queue']; readonly name: EngineJobSpec<K>['name'] } {
  const { queue, name } = ENGINE_JOBS[key]
  return { queue, name }
}
