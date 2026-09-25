import { Writable } from 'node:stream'
import {
  QUERY_EXPORT_MAX_ROWS,
  type QueryExportFormat,
  type QueryExportInput,
  QuerySpec,
} from '@kchs/contracts'
import { authorize, requireCapability } from '~/kernel/access/authorize.js'
import { audit } from '~/kernel/audit/service.js'
import { safeName } from '~/kernel/storage/s3.js'
import type { Ctx } from '~/shared/context.js'
import { errors } from '~/shared/errors.js'
import {
  type ExportColumn,
  limitBatches,
  type RowLimit,
  writeExport,
} from '../infra/export-format.js'
import { QueryService } from './query-service.js'

const CONTENT_TYPES: Record<QueryExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** Геометрия в табличную выгрузку результата не идёт: для неё — экспорт датасета и карты. */
const SKIPPED = new Set(['geometry'])

export interface QueryExportFile {
  fileName: string
  contentType: string
  body: Buffer
  rows: number
  truncated: boolean
}

/** Сегодня на часах пользователя: `YYYY-MM-DD` для имени файла. */
function today(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
}

/**
 * Выгрузка результата запроса (ADR-0159): «Исследование», график, плитка дашборда.
 * Результат считается заново — компилятор с политиками строк и столбцов
 * запросившего, как у `/queries/run`; нужны способность `data.export` и действие
 * `export` на каждом датасете запроса (и за сохранёнными запросами). Файл —
 * тем же писателем CSV/XLSX, что экспорт датасета (ADR-0056), сразу в ответе.
 */
export const QueryExportService = {
  async export(ctx: Ctx, input: QueryExportInput): Promise<QueryExportFile> {
    if (ctx.kind !== 'user') throw errors.forbidden('Выгрузку запускает пользователь')
    requireCapability(ctx, 'data.export')
    const spec = QuerySpec.parse({
      ...input.spec,
      options: { ...input.spec.options, cache: false },
    })
    const sources = await QueryService.sources(ctx, spec)
    for (const id of sources.datasets) await authorize(ctx, 'export', id)
    const { compiled } = await QueryService.compile(ctx, spec, {
      params: input.params,
      maxRows: QUERY_EXPORT_MAX_ROWS,
    })
    const columns: ExportColumn[] = compiled.fields
      .filter((field) => !SKIPPED.has(field.type))
      .map((field) => ({
        name: field.name,
        type: field.type,
        label:
          input.labels[field.name] ?? field.label?.[ctx.locale] ?? field.label?.ru ?? field.name,
      }))
    if (columns.length === 0) throw errors.validation('В результате нет столбцов для выгрузки')

    const chunks: Buffer[] = []
    const out = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        callback()
      },
    })
    const limit: RowLimit = { rows: 0, truncated: false }
    await QueryService.stream(compiled, async (cursor) => {
      await writeExport(input.format, out, limitBatches(cursor, QUERY_EXPORT_MAX_ROWS, limit), {
        columns,
        timezone: ctx.timezone,
        sheetName: input.name,
      })
    })
    await new Promise<void>((resolve, reject) =>
      out.end((error?: Error | null) => (error ? reject(error) : resolve())),
    )

    await audit(ctx, {
      action: 'query.exported',
      ...(sources.datasets[0] ? { objectId: sources.datasets[0], objectType: 'dataset' } : {}),
      severity: 'notice',
      details: {
        format: input.format,
        name: input.name,
        rows: limit.rows,
        truncated: limit.truncated,
        datasets: sources.datasets,
        system: sources.system,
      },
    })
    return {
      fileName: `${safeName(input.name).normalize('NFC')} ${today(ctx.timezone)}.${input.format}`,
      contentType: CONTENT_TYPES[input.format],
      body: Buffer.concat(chunks),
      rows: limit.rows,
      truncated: limit.truncated,
    }
  },
}
