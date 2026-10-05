import { z } from 'zod'
import { UsersImportParsed } from '../admin/users-import.js'
import { Uuid } from '../common/primitives.js'
import { IMPORT_LIMITS, ImportErrorSample } from '../data/import.js'
import { ReportRenderResult, ReportRenderStart } from '../data/report.js'
import { DocumentPdfResult } from '../documents/document.js'
import { DocumentRenderResult, DocumentRenderStart } from '../documents/print.js'
import { FileProcessedInput } from '../files/file.js'
import { TranscriptResult } from '../meetings/recording.js'

/**
 * Обратные вызовы движка (ADR-0176, ADR-0190): внутренние маршруты api, которыми
 * движок сообщает состояние и итог задания. Движок не пишет в базу — он отчитывается.
 * Каждый вызов несёт токен своего задания; тело и ответ — схемы отсюда, их же
 * использует маршрут api (`apps/api/test/engine-contracts.test.ts`).
 */

/** Состояние, прогресс и исход задания (`/internal/jobs/:id/status`). */
export const JobStatusReport = z.object({
  status: z.enum(['running', 'succeeded', 'failed']),
  progress: z.number().min(0).max(1).optional(),
  message: z.string().max(500).nullable().optional(),
  /** Результат задания — схема `result` задания в `ENGINE_JOBS`. */
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(4000).optional(),
  /** Последняя попытка: после неё движок задание не повторит. */
  final: z.boolean().default(true),
})
export type JobStatusReport = z.infer<typeof JobStatusReport>

/** Итог нормализации файла импорта: файлы в хранилище и первые ошибки (ADR-0046). */
export const NormalizedReport = z.object({
  jobRecordId: z.string(),
  rows: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  normalizedKey: z.string().min(1),
  errorsKey: z.string().nullable(),
  errorSample: z.array(ImportErrorSample).max(IMPORT_LIMITS.errorSampleRows),
})
export type NormalizedReport = z.infer<typeof NormalizedReport>

const Ok = z.object({ ok: z.boolean() })
/** `stale` — результат относится к устаревшей версии, api его не применило. */
const OkStale = z.object({ ok: z.boolean(), stale: z.boolean() })

function callback<B extends z.ZodType | null, R extends z.ZodType>(
  path: string,
  body: B,
  reply: R,
) {
  return { method: 'POST' as const, path, body, reply }
}

/**
 * Все обратные вызовы движка. Путь — как у маршрута api (без префикса `/api/v1`);
 * `body: null` — вызов без тела. Ответ движок проверяет так же, как нагрузку задания.
 */
export const ENGINE_CALLBACKS = {
  jobStatus: callback('/internal/jobs/:id/status', JobStatusReport, Ok),
  fileProcessed: callback('/internal/files/:id/processed', FileProcessedInput, OkStale),
  documentPdf: callback('/internal/documents/versions/:id/pdf', DocumentPdfResult, OkStale),
  recordingTranscript: callback(
    '/internal/meetings/recordings/:id/transcript',
    TranscriptResult,
    z.object({ ok: z.literal(true) }),
  ),
  usersImportParsed: callback(
    '/internal/users-import/:importId/parsed',
    UsersImportParsed,
    z.object({ applyJobId: Uuid }),
  ),
  importNormalized: callback(
    '/internal/data/imports/:id/normalized',
    NormalizedReport,
    z.object({ loadJobId: Uuid.nullable() }),
  ),
  reportRenderStart: callback('/internal/reports/runs/:runId/start', null, ReportRenderStart),
  reportRendered: callback('/internal/reports/runs/:runId/rendered', ReportRenderResult, Ok),
  documentRenderStart: callback('/internal/documents/renders/:id/start', null, DocumentRenderStart),
  documentRenderDone: callback(
    '/internal/documents/renders/:id/done',
    DocumentRenderResult,
    OkStale,
  ),
} as const

export type EngineCallbackName = keyof typeof ENGINE_CALLBACKS
