/**
 * Контракты для Python-движка: TypeScript-схемы — источник правды,
 * движок читает сгенерированные JSON-файлы (contracts/README.md).
 * Запуск: pnpm --filter @kchs/contracts gen:engine; CI проверяет, что результат закоммичен.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  USERS_IMPORT_FIELDS,
  USERS_IMPORT_ISSUE_CODES,
  USERS_IMPORT_MAX_BYTES,
  USERS_IMPORT_MAX_ROWS,
} from '../src/admin/users-import.js'
import { DATASET_ENGINE_EXPORT_FORMATS, DATASET_EXPORT_MAX_ROWS } from '../src/data/export.js'
import {
  ARROW_TYPES,
  COLUMNAR_DECIMAL,
  DURATION_UNIT,
  EXPORT_FAMILIES,
  FIELD_STORAGE,
} from '../src/data/field-storage.js'
import {
  IMPORT_ERROR_CODES,
  IMPORT_FIELD_TYPES,
  IMPORT_FORMATS,
  IMPORT_LAYER_FORMATS,
  IMPORT_LIMITS,
  NORMALIZED_VALUE_FORMATS,
} from '../src/data/import.js'
import {
  PRINT_MODEL_VERSION,
  REPORT_CONTENT_TYPES,
  REPORT_FORMATS,
  REPORT_PRINT,
} from '../src/data/report.js'
import {
  DOCUMENT_RENDER_KINDS,
  DOCUMENT_RENDER_MAX_SOURCE_BYTES,
  DOCUMENT_RENDER_PLAN_KINDS,
  DOCUMENT_TEMPLATE_MAX_BYTES,
  RENDER_ORIENTATIONS,
  RENDER_OVERLAY_PAGES,
} from '../src/documents/print.js'
import { ENGINE_CALLBACKS } from '../src/engine/callbacks.js'
import { DEMO_PROFILES, ENGINE_JOBS, EngineJobEnvelope } from '../src/engine/jobs.js'
import { FIELD_SEMANTICS } from '../src/fields/field-def.js'
import { BOOLEAN_WORDS, NULL_WORDS } from '../src/fields/values.js'
import { QUEUE_RUNTIME } from '../src/jobs/job.js'
import {
  RECORDING_MIME,
  TRANSCRIBE_JOB,
  TRANSCRIPT_LANGUAGES,
  TRANSCRIPT_MAX_SEGMENTS,
} from '../src/meetings/recording.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, '../../../apps/engine/kchs_engine/contracts')

function write(name: string, data: unknown): void {
  mkdirSync(outDir, { recursive: true })
  const body = {
    $comment:
      'Сгенерировано из packages/contracts командой `pnpm --filter @kchs/contracts gen:engine`. Не редактировать вручную.',
    ...(data as Record<string, unknown>),
  }
  writeFileSync(path.join(outDir, name), `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  process.stdout.write(`contracts → engine: ${name}\n`)
}

write('queues.json', { queues: QUEUE_RUNTIME })
write('users_import.json', {
  fields: USERS_IMPORT_FIELDS,
  maxRows: USERS_IMPORT_MAX_ROWS,
  maxBytes: USERS_IMPORT_MAX_BYTES,
  issueCodes: USERS_IMPORT_ISSUE_CODES,
})
write('data_import.json', {
  formats: IMPORT_FORMATS,
  layerFormats: IMPORT_LAYER_FORMATS,
  fieldTypes: IMPORT_FIELD_TYPES,
  semantics: FIELD_SEMANTICS,
  limits: IMPORT_LIMITS,
  errorCodes: IMPORT_ERROR_CODES,
  normalizedValueFormats: NORMALIZED_VALUE_FORMATS,
})
write('data_export.json', {
  engineFormats: DATASET_ENGINE_EXPORT_FORMATS,
  maxRows: DATASET_EXPORT_MAX_ROWS,
})
write('report_render.json', {
  formats: REPORT_FORMATS,
  contentTypes: REPORT_CONTENT_TYPES,
  print: REPORT_PRINT,
  printModelVersion: PRINT_MODEL_VERSION,
})
write('media_transcribe.json', {
  job: TRANSCRIBE_JOB,
  languages: TRANSCRIPT_LANGUAGES,
  maxSegments: TRANSCRIPT_MAX_SEGMENTS,
  recordingMime: RECORDING_MIME,
})
write('document_render.json', {
  kinds: DOCUMENT_RENDER_KINDS,
  planKinds: DOCUMENT_RENDER_PLAN_KINDS,
  orientations: RENDER_ORIENTATIONS,
  overlayPages: RENDER_OVERLAY_PAGES,
  maxSourceBytes: DOCUMENT_RENDER_MAX_SOURCE_BYTES,
  maxTemplateBytes: DOCUMENT_TEMPLATE_MAX_BYTES,
})
/**
 * JSON Schema того, что движок получает (нагрузка, ответ api), — как её отдаёт
 * zod после разбора (`output`: значения по умолчанию уже подставлены); того, что
 * движок отправляет (результат, тело обратного вызова), — как её принимает api
 * (`input`). Модели движка сверяет с ними `tests/test_engine_contracts.py`.
 */
const received = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'output' })
const sent = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input' })

// Задания движка и его обратные вызовы (ADR-0190)
write('jobs.json', {
  envelope: received(EngineJobEnvelope),
  jobs: Object.fromEntries(
    Object.entries(ENGINE_JOBS).map(([key, job]) => [
      key,
      {
        queue: job.queue,
        name: job.name,
        payload: received(job.payload),
        result: sent(job.result),
      },
    ]),
  ),
  callbacks: Object.fromEntries(
    Object.entries(ENGINE_CALLBACKS).map(([name, callback]) => [
      name,
      {
        method: callback.method,
        path: callback.path,
        body: callback.body ? sent(callback.body) : null,
        reply: received(callback.reply),
      },
    ]),
  ),
  demoProfiles: DEMO_PROFILES,
})
// Хранение полей и слова «да/нет» — один реестр для api, компилятора и движка (ADR-0190)
write('field_types.json', {
  storage: FIELD_STORAGE,
  arrowTypes: ARROW_TYPES,
  exportFamilies: EXPORT_FAMILIES,
  columnarDecimal: COLUMNAR_DECIMAL,
  durationUnit: DURATION_UNIT,
  booleanWords: BOOLEAN_WORDS,
  nullWords: NULL_WORDS,
})
