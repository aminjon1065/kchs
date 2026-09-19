import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import {
  DATASET_ENGINE_EXPORT_FORMATS,
  DATASET_EXPORT_MAX_ROWS,
  DATASET_GEO_EXPORT_FORMATS,
  type DatasetEngineExportFormat,
  type DatasetExportDownload,
  type DatasetExportFormat,
  type DatasetExportInput,
  type DatasetExportResult,
  type FilterNode,
  type Locale,
  type QueryResultField,
  QuerySpec,
} from '@kchs/contracts'
import type { CompiledQuery } from '@kchs/query'
import { UnrecoverableError } from 'bullmq'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { audit } from '~/kernel/audit/service.js'
import { JobService } from '~/kernel/jobs/service.js'
import {
  buckets,
  deleteObject,
  headObject,
  s3,
  safeName,
  signedGetUrl,
} from '~/kernel/storage/s3.js'
import type { Ctx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { AppError, errors } from '~/shared/errors.js'
import { postEngine } from '../infra/engine.js'
import {
  type ExportColumn,
  limitBatches,
  type RowLimit,
  type WrittenFormat,
  writeExport,
} from '../infra/export-format.js'
import { DatasetAccess } from './dataset-access.js'
import { DatasetService } from './dataset-service.js'
import { QueryService } from './query-service.js'
import { tableFilter } from './row-service.js'

export const EXPORT_JOB = { queue: 'exports', name: 'dataset.export' } as const

/** Тайм-аут запроса задания (06-analytics-engine.md §5: 10 мин для экспорта). */
const EXPORT_TIMEOUT_MS = 600_000
/** Прогресс задания — раз в столько строк. */
const PROGRESS_EVERY = 20_000

const EXTENSIONS: Record<DatasetExportFormat, string> = {
  csv: 'csv',
  xlsx: 'xlsx',
  json: 'json',
  geojson: 'geojson',
  gpkg: 'gpkg',
  shp: 'shp.zip',
  kml: 'kml',
}

const CONTENT_TYPES: Record<DatasetExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  json: 'application/json',
  geojson: 'application/geo+json',
  gpkg: 'application/geopackage+sqlite3',
  shp: 'application/zip',
  kml: 'application/vnd.google-earth.kml+xml',
}

const GEO_FORMATS = new Set<DatasetExportFormat>(DATASET_GEO_EXPORT_FORMATS)
const ENGINE_FORMATS = new Set<DatasetExportFormat>(DATASET_ENGINE_EXPORT_FORMATS)
const isEngineFormat = (format: DatasetExportFormat): format is DatasetEngineExportFormat =>
  ENGINE_FORMATS.has(format)

/** Ответ движка на сборку геоформата. */
const GeoExportReply = z.object({ rows: z.number().int(), size: z.number().int().nonnegative() })

/**
 * GeoPackage, Shapefile и KML собирает движок (ADR-0068): воркер кладёт рядом с
 * результатом выгрузку строк с политиками (GeoJSONSeq), движок пишет файл
 * формата по ключу результата; выгрузка удаляется. Ошибка данных — без повтора.
 */
async function convertOnEngine(input: {
  sourceKey: string
  targetKey: string
  format: DatasetEngineExportFormat
  layer: string
  columns: ExportColumn[]
}): Promise<number> {
  try {
    const reply = GeoExportReply.parse(
      await postEngine(
        '/data/geo-export',
        {
          bucket: buckets.exports(),
          sourceKey: input.sourceKey,
          targetKey: input.targetKey,
          format: input.format,
          layer: input.layer,
          contentType: CONTENT_TYPES[input.format],
          fields: input.columns.map((column) => ({
            name: column.name,
            label: column.label,
            type: column.type,
          })),
        },
        EXPORT_TIMEOUT_MS,
      ),
    )
    return reply.size
  } catch (error) {
    if (error instanceof AppError && error.code === 'validation_failed') {
      throw new UnrecoverableError(error.message)
    }
    throw error
  }
}

/** Данные задания: спецификация и поля фиксируются при постановке, права — при выполнении. */
export interface ExportJobData {
  datasetId: string
  format: DatasetExportFormat
  spec: QuerySpec
  /** Поля в порядке выгрузки; null — все видимые на момент выполнения. */
  fields: string[] | null
  fileName: string
  sheetName: string
}

/** Результат задания: ключ файла в хранилище экспортов — только для выдачи ссылки. */
type ExportJobResult = DatasetExportResult & { key: string }

/** Права или спецификация больше не позволяют выгрузку — повтор не поможет. */
function permanent(error: unknown): never {
  if (error instanceof AppError) throw new UnrecoverableError(error.message)
  throw error
}

/** Выгрузка «как в таблице»: фильтр, поиск, выделенные строки, сортировка с `_id` в конце. */
function exportSpec(
  datasetId: string,
  where: FilterNode | null,
  input: DatasetExportInput,
): QuerySpec {
  const conditions: FilterNode[] = where ? [where] : []
  if (input.ids) conditions.push({ field: '_id', op: 'in', value: input.ids.map(Number) })
  return QuerySpec.parse({
    version: 1,
    source: { kind: 'dataset', id: datasetId },
    steps: [
      ...(conditions.length > 0
        ? [{ type: 'filter', where: conditions.length === 1 ? conditions[0] : { and: conditions } }]
        : []),
      {
        type: 'sort',
        by: [...input.sort.filter((item) => item.field !== '_id'), { field: '_id', dir: 'asc' }],
      },
    ],
    options: { timeoutMs: EXPORT_TIMEOUT_MS, cache: false },
  })
}

/** Столбцы выгрузки: запрошенные поля в их порядке или все видимые; подписи — на языке пользователя. */
function exportColumns(
  fields: QueryResultField[],
  requested: string[] | null,
  locale: Locale,
): ExportColumn[] {
  const byName = new Map(fields.map((field) => [field.name, field]))
  const names = requested ?? fields.map((field) => field.name)
  return names.map((name) => {
    const field = byName.get(name)
    if (!field) throw errors.validation(`Нет поля «${name}»`)
    return { name, type: field.type, label: field.label?.[locale] ?? field.label?.ru ?? name }
  })
}

/** Сегодня на часах пользователя: `YYYY-MM-DD` для имени файла. */
function today(timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())
}

/**
 * Экспорт датасета (P1-E03 S04, ADR-0056): постановка проверяет права и
 * спецификацию сразу, задание `exports:dataset.export` читает строки с
 * политиками запросившего на момент выполнения, пишет файл во временный
 * каталог и кладёт его в хранилище экспортов; скачивает только запросивший.
 */
export const ExportService = {
  async start(ctx: Ctx, datasetId: string, input: DatasetExportInput): Promise<{ jobId: string }> {
    if (ctx.kind !== 'user') throw errors.forbidden('Экспорт запускает пользователь')
    const grant = await DatasetAccess.resolve(ctx, datasetId, 'export')
    const [storage, record] = await Promise.all([
      DatasetService.storage(datasetId),
      DatasetService.get(datasetId),
    ])
    const spec = exportSpec(datasetId, tableFilter(storage, grant, input), input)
    const { compiled } = await QueryService.compile(ctx, spec, {
      maxRows: DATASET_EXPORT_MAX_ROWS,
    })
    const columns = exportColumns(compiled.fields, input.fields ?? null, ctx.locale)
    if (GEO_FORMATS.has(input.format) && !columns.some((column) => column.type === 'geometry')) {
      throw errors.validation(`Для ${input.format.toUpperCase()} нужно поле геометрии`)
    }
    const data: ExportJobData = {
      datasetId,
      format: input.format,
      spec,
      fields: input.fields ?? null,
      fileName: `${safeName(record.name)} ${today(ctx.timezone)}.${EXTENSIONS[input.format]}`,
      sheetName: record.name,
    }
    const jobId = await db().transaction((tx) =>
      JobService.schedule(tx, ctx, {
        ...EXPORT_JOB,
        objectId: datasetId,
        data: data as unknown as Record<string, unknown>,
      }),
    )
    return { jobId }
  },

  async run(
    data: ExportJobData,
    helpers: { recordId: string; progress: (value: number, message?: string) => Promise<void> },
  ): Promise<ExportJobResult> {
    const job = await JobService.get(helpers.recordId)
    if (!job?.initiatorId) throw new UnrecoverableError('У экспорта нет инициатора')
    const ctx = await buildUserCtxFor(job.initiatorId)
    if (!ctx) throw new UnrecoverableError('Инициатор экспорта не найден')

    // Права и политики — на момент выполнения, а не постановки
    let compiled: CompiledQuery
    let columns: ExportColumn[]
    try {
      await authorize(ctx, 'export', data.datasetId)
      ;({ compiled } = await QueryService.compile(ctx, QuerySpec.parse(data.spec), {
        maxRows: DATASET_EXPORT_MAX_ROWS,
      }))
      columns = exportColumns(compiled.fields, data.fields, ctx.locale)
    } catch (error) {
      permanent(error)
    }
    const geometry = columns.find((column) => column.type === 'geometry')?.name
    if (GEO_FORMATS.has(data.format) && !geometry) {
      throw new UnrecoverableError(`Для ${data.format.toUpperCase()} нужно поле геометрии`)
    }
    const engine = isEngineFormat(data.format)
    // Геоформаты GDAL воркер выгружает построчным GeoJSON — файл собирает движок
    const output: WrittenFormat = isEngineFormat(data.format) ? 'geojsonseq' : data.format

    const dir = await mkdtemp(join(tmpdir(), 'kchs-export-'))
    const path = join(dir, 'export')
    const out = createWriteStream(path)
    const limit: RowLimit = { rows: 0, truncated: false }
    try {
      await QueryService.stream(compiled, async (cursor, total) => {
        const expected = Math.min(total, DATASET_EXPORT_MAX_ROWS)
        let reported = 0
        const batches = limitBatches(cursor, DATASET_EXPORT_MAX_ROWS, limit, async (rows) => {
          if (rows - reported < PROGRESS_EVERY) return
          reported = rows
          await helpers.progress(expected > 0 ? Math.min(rows / expected, 0.99) : 0)
        })
        await writeExport(output, out, batches, {
          columns,
          timezone: ctx.timezone,
          sheetName: data.sheetName,
          ...(geometry ? { geometry } : {}),
        })
      })
      out.end()
      await finished(out)
      const written = (await stat(path)).size
      const folder = `datasets/${data.datasetId}/${helpers.recordId}`
      const key = `${folder}/${safeName(data.fileName)}`
      const uploadKey = engine ? `${folder}/source.geojsonl` : key
      await s3().send(
        new PutObjectCommand({
          Bucket: buckets.exports(),
          Key: uploadKey,
          Body: createReadStream(path),
          ContentLength: written,
          ContentType: engine ? 'application/geo+json-seq' : CONTENT_TYPES[data.format],
        }),
      )
      let size = written
      if (isEngineFormat(data.format)) {
        try {
          size = await convertOnEngine({
            sourceKey: uploadKey,
            targetKey: key,
            format: data.format,
            layer: data.sheetName,
            columns: columns.filter((column) => column.name !== geometry),
          })
        } finally {
          await deleteObject(uploadKey, buckets.exports()).catch(() => undefined)
        }
      }
      await audit(ctx, {
        action: 'dataset.exported',
        objectId: data.datasetId,
        objectType: 'dataset',
        severity: 'notice',
        details: {
          format: data.format,
          rows: limit.rows,
          truncated: limit.truncated,
          jobId: helpers.recordId,
        },
      })
      return {
        fileName: data.fileName,
        format: data.format,
        rows: limit.rows,
        size,
        truncated: limit.truncated,
        key,
      }
    } catch (error) {
      out.destroy()
      throw error
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },

  /** Ссылка на файл: только запросившему и пока у него есть право экспорта. */
  async download(ctx: Ctx, jobId: string): Promise<DatasetExportDownload> {
    if (ctx.kind !== 'user') throw errors.notFound('Экспорт')
    const job = await JobService.get(jobId)
    if (
      !job ||
      job.queue !== EXPORT_JOB.queue ||
      job.name !== EXPORT_JOB.name ||
      job.initiatorId !== ctx.userId ||
      !job.objectId
    ) {
      throw errors.notFound('Экспорт')
    }
    await authorize(ctx, 'export', job.objectId)
    if (job.status !== 'succeeded') throw errors.conflict('Экспорт ещё не готов')
    const result = job.result as Partial<ExportJobResult> | null
    if (!result?.key || !result.fileName) throw errors.notFound('Экспорт')
    try {
      await headObject(result.key, buckets.exports())
    } catch {
      throw new AppError('not_found', 'Файл экспорта удалён: он хранится 30 дней', 404)
    }
    return {
      url: await signedGetUrl(result.key, { bucket: buckets.exports(), filename: result.fileName }),
    }
  },
}
