/**
 * Контракты для Python-движка: TypeScript-схемы — источник правды,
 * движок читает сгенерированные JSON-файлы (contracts/README.md).
 * Запуск: pnpm --filter @kchs/contracts gen:engine; CI проверяет, что результат закоммичен.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  USERS_IMPORT_FIELDS,
  USERS_IMPORT_ISSUE_CODES,
  USERS_IMPORT_MAX_BYTES,
  USERS_IMPORT_MAX_ROWS,
} from '../src/admin/users-import.js'
import { DATASET_ENGINE_EXPORT_FORMATS, DATASET_EXPORT_MAX_ROWS } from '../src/data/export.js'
import {
  IMPORT_ERROR_CODES,
  IMPORT_FIELD_TYPES,
  IMPORT_FORMATS,
  IMPORT_LAYER_FORMATS,
  IMPORT_LIMITS,
  NORMALIZED_VALUE_FORMATS,
} from '../src/data/import.js'
import { FIELD_SEMANTICS } from '../src/fields/field-def.js'
import { QUEUE_RUNTIME } from '../src/jobs/job.js'

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
