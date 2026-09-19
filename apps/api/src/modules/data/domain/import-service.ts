import type { Readable } from 'node:stream'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import {
  type DatasetFieldInput,
  IMPORT_FINAL_STATUSES,
  IMPORT_LIMITS,
  ImportAnalysis,
  type ImportAnalyzeInput,
  type ImportDiff,
  type ImportMappingItem,
  type ImportRecord,
  type ImportRunInput,
  type ImportStats,
  type StoredFieldType,
} from '@kchs/contracts'
import { and, desc, eq, notInArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import { buckets, deleteObject, s3 } from '~/kernel/storage/s3.js'
import { fileSource } from '~/modules/files/public.js'
import { territoryIndex } from '~/modules/gis/public.js'
import { type Ctx, systemCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { datasets, imports, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { postEngine } from '../infra/engine.js'
import { Physical } from '../infra/physical.js'
import type { DatasetGrant } from './dataset-access.js'
import { DatasetService, type DatasetStorage, defaultSemantic } from './dataset-service.js'

/** Задания импорта (ADR-0046); сравнение с датасетом перед публикацией — ADR-0068. */
export const NORMALIZE_JOB = { queue: 'imports', name: 'dataset.normalize' } as const
export const LOAD_JOB = { queue: 'data', name: 'dataset.load' } as const
export const COMPARE_JOB = { queue: 'data', name: 'dataset.compare' } as const

const ERROR_SAMPLE_LIMIT = 50

/** Итог нормализации от движка. */
export const NormalizedReport = z.object({
  jobRecordId: z.string(),
  rows: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  normalizedKey: z.string().min(1),
  errorsKey: z.string().nullable(),
  errorSample: z
    .array(
      z.object({
        row: z.number().int(),
        column: z.string(),
        value: z.string().nullable(),
        reason: z.string(),
      }),
    )
    .max(ERROR_SAMPLE_LIMIT),
})
export type NormalizedReport = z.infer<typeof NormalizedReport>

type ImportRow = typeof imports.$inferSelect

function toRecord(row: ImportRow): ImportRecord {
  const stats = row.stats as Partial<ImportStats>
  return {
    id: row.id,
    datasetId: row.datasetId,
    fileId: row.fileId,
    status: row.status as ImportRecord['status'],
    stats: {
      rows: stats.rows ?? 0,
      inserted: stats.inserted ?? 0,
      updated: stats.updated ?? 0,
      deleted: stats.deleted ?? 0,
      errors: stats.errors ?? 0,
    },
    errorsFileId: row.errorsFileId,
    errorSample: (row.errorSample as ImportRecord['errorSample']).slice(0, ERROR_SAMPLE_LIMIT),
    jobId: row.jobId,
    version: row.version,
    message: row.message,
    review: row.review,
    diff: (row.diff as ImportDiff | null) ?? null,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
  }
}

/** Физические столбцы файла для staging и сравнения: поля сопоставления и геометрия. */
function stagingColumns(storage: DatasetStorage, row: ImportRow) {
  return loadColumns(
    storage,
    row.mapping as unknown as ImportMappingItem[],
    row.geometryField ?? undefined,
  )
}

/** Staging-таблица импорта из нормализованного файла; повторы ключа — отброшены. */
async function fillStaging(
  row: ImportRow,
  storage: DatasetStorage,
  keyColumns: string[],
): Promise<{ staging: string; duplicates: number[] }> {
  const columns = stagingColumns(storage, row)
  await Physical.dropStaging(row.id)
  const staging = await Physical.createStaging(
    row.id,
    columns.map((field) => ({
      name: field.physical,
      type: field.type as StoredFieldType,
      precision: field.format?.precision,
    })),
  )
  const object = await s3().send(
    new GetObjectCommand({ Bucket: buckets.files(), Key: row.normalizedKey as string }),
  )
  await Physical.copyIntoStaging(
    staging,
    columns.map((field) => field.physical),
    object.Body as Readable,
  )
  const duplicates = await Physical.dropDuplicateKeys(staging, keyColumns)
  return { staging, duplicates }
}

/** Физические столбцы ключа датасета. */
function keyColumnsOf(storage: DatasetStorage): string[] {
  return storage.primaryKey.map(
    (key) => storage.fields.find((field) => field.key === key)?.physical as string,
  )
}

async function objectMeta(tx: Executor, datasetId: string) {
  const [meta] = await tx
    .select({ spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, datasetId))
    .limit(1)
  return {
    id: datasetId,
    type: 'dataset' as const,
    spaceId: meta?.spaceId ?? null,
    title: meta?.title,
  }
}

/** Поля нового датасета из сопоставления импорта (+ геометрия). */
function fieldsFromMapping(
  input: ImportRunInput,
  geometryField: string | null,
): DatasetFieldInput[] {
  const fields: DatasetFieldInput[] = input.mapping.map((item, index) => ({
    key: item.fieldKey,
    label: item.label,
    type: item.type,
    semantic: item.semantic ?? defaultSemantic(item.type as StoredFieldType),
    required: item.required,
    unique: input.key.includes(item.fieldKey),
    indexed: input.key.includes(item.fieldKey),
    sensitive: false,
    readOnly: false,
    nullable: !item.required,
    order: index,
    ...(item.format ? { format: item.format } : {}),
  }))
  if (geometryField) {
    fields.push({
      key: geometryField,
      label: { ru: 'Геометрия', en: 'Geometry' },
      type: 'geometry',
      semantic: 'geometry',
      required: false,
      unique: false,
      indexed: false,
      sensitive: false,
      readOnly: false,
      nullable: true,
      order: fields.length,
    })
  }
  return fields
}

/** Порядок столбцов нормализованного CSV: поля сопоставления, геометрия последней. */
function loadColumns(
  storage: DatasetStorage,
  mapping: ImportMappingItem[],
  geometryField?: string,
) {
  const byKey = new Map(storage.fields.map((field) => [field.key, field]))
  const keys = [...mapping.map((item) => item.fieldKey), ...(geometryField ? [geometryField] : [])]
  return keys.map((key) => {
    const field = byKey.get(key)
    if (!field) throw errors.validation(`В датасете нет поля «${key}»`)
    return field
  })
}

const LoadPayload = z.object({ importId: z.uuid() })

/**
 * Импорт файла в датасет (06-analytics-engine.md §2, ADR-0046): анализ —
 * синхронно в движке; выполнение — нормализация в движке, загрузка воркером.
 */
export const ImportService = {
  async analyze(input: ImportAnalyzeInput): Promise<ImportAnalysis> {
    const source = await fileSource(input.fileId)
    if (!source) throw errors.notFound('Файл')
    if (source.size > IMPORT_LIMITS.maxFileBytes) {
      throw errors.payloadTooLarge('Файл больше 2 ГБ')
    }
    const result = await postEngine(
      '/data/analyze',
      {
        bucket: source.bucket,
        key: source.storageKey,
        fileName: source.name,
        options: input.options,
      },
      IMPORT_LIMITS.analyzeTimeoutMs + 5_000,
    )
    return ImportAnalysis.parse(result)
  },

  /** Запуск: новый датасет (или проверка существующего), запись импорта, задание движку. */
  async start(tx: Executor, ctx: Ctx, input: ImportRunInput): Promise<ImportRecord> {
    const source = await fileSource(input.fileId)
    if (!source) throw errors.notFound('Файл')

    const mapped = new Set(input.mapping.map((item) => item.fieldKey))
    let datasetId: string
    let mode: string
    // Поле, в которое движок соберёт геометрию; в нормализованном CSV оно последнее
    let geometryField: string | null = null
    if (input.target.kind === 'new') {
      if (input.geometry) {
        geometryField = input.geometryField ?? 'geometry'
        if (mapped.has(geometryField)) {
          throw errors.validation(`Поле геометрии «${geometryField}» совпадает с полем столбца`)
        }
      }
      datasetId = await DatasetService.create(tx, ctx, {
        name: input.target.name,
        description: input.target.description ?? null,
        spaceId: input.target.spaceId,
        parentId: input.target.parentId ?? null,
        kind: 'table',
        fields: fieldsFromMapping(input, geometryField),
        primaryKey: input.key,
        timeField: input.mapping.find((item) => item.semantic === 'time')?.fieldKey ?? null,
        territoryField: null,
      })
      mode = 'replace'
    } else {
      datasetId = input.target.datasetId
      mode = input.target.mode
      const storage = await DatasetService.storage(datasetId, tx)
      // Сопоставление должно попасть в существующие поля того же типа
      const byKey = new Map(storage.fields.map((field) => [field.key, field]))
      for (const item of input.mapping) {
        const field = byKey.get(item.fieldKey)
        if (!field) throw errors.validation(`В датасете нет поля «${item.fieldKey}»`)
        if (field.type !== item.type) {
          throw errors.validation(
            `Поле «${item.fieldKey}» имеет тип ${field.type}, а не ${item.type}`,
          )
        }
      }
      if (mode === 'upsert' || mode === 'sync') {
        if (storage.primaryKey.length === 0) {
          throw errors.validation('Обновление по ключу: у датасета нет ключевых полей')
        }
        const missing = storage.primaryKey.filter((key) => !mapped.has(key))
        if (missing.length > 0) {
          throw errors.validation(`Ключевые поля не сопоставлены: ${missing.join(', ')}`)
        }
      }
      if (input.geometry) {
        const field = input.geometryField
          ? byKey.get(input.geometryField)
          : storage.fields.find((item) => item.type === 'geometry')
        if (field?.type !== 'geometry') {
          throw errors.validation('В датасете нет поля геометрии')
        }
        if (mapped.has(field.key)) {
          throw errors.validation(`Поле геометрии «${field.key}» уже сопоставлено со столбцом`)
        }
        geometryField = field.key
      }
    }

    const id = newId()
    const prefix = `imports/${id}`
    // Поле-территория: движок сопоставляет коды и названия по справочнику (ADR-0057)
    const territories = input.mapping.some((item) => item.type === 'territory')
      ? (await territoryIndex()).matchTable()
      : null
    const jobId = await JobService.schedule(tx, ctx, {
      queue: NORMALIZE_JOB.queue,
      name: NORMALIZE_JOB.name,
      objectId: datasetId,
      data: {
        importId: id,
        bucket: source.bucket,
        storageKey: source.storageKey,
        fileName: source.name,
        options: input.options,
        mapping: input.mapping,
        geometry: input.geometry ?? null,
        geometryField,
        ...(territories ? { territories } : {}),
        onError: input.onError,
        output: {
          bucket: buckets.files(),
          normalizedKey: `${prefix}/normalized.csv`,
          errorsKey: `${prefix}/errors.csv`,
        },
      },
      options: { attempts: 2, backoff: { type: 'exponential', delay: 10_000 } },
    })
    const [row] = await tx
      .insert(imports)
      .values({
        id,
        datasetId,
        fileId: input.fileId,
        status: 'normalizing',
        mode,
        options: input.options,
        mapping: input.mapping as unknown as Record<string, unknown>[],
        key: input.key,
        onError: input.onError,
        geometry: (input.geometry as Record<string, unknown> | undefined) ?? null,
        geometryField,
        stats: { rows: 0, inserted: 0, updated: 0, deleted: 0, errors: 0 },
        jobId,
        review: input.review,
        createdBy: ctx.kind === 'user' ? ctx.userId : null,
      })
      .returning()
    await publishEvent(tx, ctx, {
      type: 'dataset.import_started',
      object: await objectMeta(tx, datasetId),
      payload: { importId: id, mode },
    })
    return toRecord(row as ImportRow)
  },

  async get(importId: string): Promise<ImportRecord> {
    const [row] = await db().select().from(imports).where(eq(imports.id, importId)).limit(1)
    if (!row) throw errors.notFound('Импорт')
    return toRecord(row)
  },

  async list(datasetId: string): Promise<ImportRecord[]> {
    const rows = await db()
      .select()
      .from(imports)
      .where(eq(imports.datasetId, datasetId))
      .orderBy(desc(imports.createdAt))
      .limit(50)
    return rows.map(toRecord)
  },

  /**
   * Итог нормализации от движка → задание загрузки (с предпросмотром —
   * сравнения). Повтор отчёта (движок повторил задание) даёт то же задание:
   * ключ идемпотентности — импорт.
   */
  async acceptNormalized(importId: string, report: NormalizedReport): Promise<string | null> {
    return db().transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(imports)
        .where(eq(imports.id, importId))
        .limit(1)
        .for('update')
      if (!row) throw errors.notFound('Импорт')
      if (!['normalizing', 'comparing', 'loading'].includes(row.status)) {
        throw errors.conflict('Импорт уже завершён')
      }
      const stats = {
        ...(row.stats as Record<string, number>),
        rows: report.rows,
        errors: report.errors,
      }
      const ctx = systemCtx('dataset-import', { initiatorId: row.createdBy })
      if (row.onError === 'stop' && report.errors > 0) {
        await tx
          .update(imports)
          .set({
            status: 'failed',
            stats,
            errorSample: report.errorSample,
            errorsKey: report.errorsKey,
            normalizedKey: report.normalizedKey,
            message: 'В файле есть ошибки — импорт остановлен',
            finishedAt: sql`now()`,
          })
          .where(eq(imports.id, importId))
        await publishFailed(tx, ctx, row.datasetId, importId, 'errors')
        return null
      }
      await tx
        .update(imports)
        .set({
          status: row.review ? 'comparing' : 'loading',
          stats,
          errorSample: report.errorSample,
          errorsKey: report.errorsKey,
          normalizedKey: report.normalizedKey,
        })
        .where(eq(imports.id, importId))
      if (row.review) {
        // Предпросмотр: сначала сравнение с датасетом, загрузка — после публикации
        return JobService.schedule(tx, ctx, {
          queue: COMPARE_JOB.queue,
          name: COMPARE_JOB.name,
          objectId: row.datasetId,
          idempotencyKey: `dataset.compare:${importId}`,
          data: { importId },
          options: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        })
      }
      return JobService.schedule(tx, ctx, {
        queue: LOAD_JOB.queue,
        name: LOAD_JOB.name,
        objectId: row.datasetId,
        idempotencyKey: `dataset.load:${importId}`,
        data: { importId },
        options: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
      })
    })
  },

  /**
   * Задание воркера (ADR-0068): файл сравнивается с датасетом по ключу так же,
   * как его применил бы `upsert`/`sync`; сводка с примерами сохраняется, и импорт
   * ждёт публикации. Нормализованный файл остаётся — его загрузит публикация.
   */
  async compare(
    data: unknown,
    progress: (value: number, message?: string) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const { importId } = LoadPayload.parse(data)
    const [row] = await db().select().from(imports).where(eq(imports.id, importId)).limit(1)
    if (!row) throw errors.notFound('Импорт')
    if (row.status !== 'comparing') return { skipped: true }
    if (!row.normalizedKey) throw errors.conflict('Нормализованный файл ещё не готов')

    const storage = await DatasetService.storage(row.datasetId)
    const keyColumns = keyColumnsOf(storage)
    try {
      const { staging, duplicates } = await fillStaging(row, storage, keyColumns)
      await progress(0.6, 'Файл загружен во временную таблицу')
      const counts = await Physical.importDiff({
        table: storage.table,
        staging,
        columns: stagingColumns(storage, row).map((field) => ({
          physical: field.physical,
          key: field.key,
          type: field.type as StoredFieldType,
        })),
        keyColumns,
        sync: row.mode === 'sync',
        sampleRows: IMPORT_LIMITS.diffSampleRows,
      })
      const [dataset] = await db()
        .select({ version: datasets.currentVersion })
        .from(datasets)
        .where(eq(datasets.id, row.datasetId))
        .limit(1)
      const diff: ImportDiff = {
        baseVersion: dataset?.version ?? 0,
        added: counts.added,
        changed: counts.changed,
        deleted: counts.deleted,
        unchanged: counts.unchanged,
        duplicates: duplicates.length,
        samples: counts.samples,
      }
      const ctx = systemCtx('dataset-import', { initiatorId: row.createdBy })
      await db().transaction(async (tx) => {
        const [updated] = await tx
          .update(imports)
          .set({ status: 'review', diff: diff as unknown as Record<string, unknown> })
          .where(and(eq(imports.id, importId), eq(imports.status, 'comparing')))
          .returning({ id: imports.id })
        if (!updated) return
        await publishEvent(tx, ctx, {
          type: 'dataset.import_review',
          object: await objectMeta(tx, row.datasetId),
          payload: {
            importId,
            added: diff.added,
            changed: diff.changed,
            deleted: diff.deleted,
          },
        })
      })
      return { added: diff.added, changed: diff.changed, deleted: diff.deleted }
    } catch (error) {
      logger().error({ err: error, importId }, 'сравнение импорта с датасетом не выполнено')
      throw error
    } finally {
      await Physical.dropStaging(importId).catch(() => undefined)
    }
  },

  /** Публикация после предпросмотра: загрузка в датасет обычным заданием (ADR-0068). */
  async publish(ctx: Ctx, importId: string): Promise<ImportRecord> {
    const row = await db().transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(imports)
        .where(eq(imports.id, importId))
        .limit(1)
        .for('update')
      if (!current) throw errors.notFound('Импорт')
      if (current.status !== 'review') {
        throw errors.conflict('Импорт не ждёт публикации')
      }
      await JobService.schedule(tx, ctx, {
        queue: LOAD_JOB.queue,
        name: LOAD_JOB.name,
        objectId: current.datasetId,
        idempotencyKey: `dataset.load:${importId}`,
        data: { importId },
        options: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
      })
      const [updated] = await tx
        .update(imports)
        .set({ status: 'loading' })
        .where(eq(imports.id, importId))
        .returning()
      await publishEvent(tx, ctx, {
        type: 'dataset.import_published',
        object: await objectMeta(tx, current.datasetId),
        payload: { importId },
      })
      return updated as ImportRow
    })
    return toRecord(row)
  },

  /** Отмена после предпросмотра: датасет не меняется, нормализованный файл удаляется. */
  async cancel(ctx: Ctx, importId: string): Promise<ImportRecord> {
    const row = await db().transaction(async (tx) => {
      const [updated] = await tx
        .update(imports)
        .set({ status: 'cancelled', finishedAt: sql`now()` })
        .where(and(eq(imports.id, importId), eq(imports.status, 'review')))
        .returning()
      if (!updated) {
        const [exists] = await tx
          .select({ id: imports.id })
          .from(imports)
          .where(eq(imports.id, importId))
          .limit(1)
        if (!exists) throw errors.notFound('Импорт')
        throw errors.conflict('Импорт не ждёт публикации')
      }
      await publishEvent(tx, ctx, {
        type: 'dataset.import_cancelled',
        object: await objectMeta(tx, updated.datasetId),
        payload: { importId },
      })
      return updated
    })
    if (row.normalizedKey) {
      await deleteObject(row.normalizedKey, buckets.files()).catch(() => undefined)
    }
    return toRecord(row)
  },

  /**
   * Импорт глазами пользователя: примеры изменений — только тем, кто вправе
   * загружать в датасет и видит все его строки; скрытые поля убираются,
   * маскируемые — без значений, как и значения ключа, если его поле скрыто или
   * маскируется (политики столбцов, ADR-0055).
   */
  visible(
    record: ImportRecord,
    grant: DatasetGrant,
    canImport: boolean,
    keyFields: string[],
  ): ImportRecord {
    if (!record.diff) return record
    const samples = record.diff.samples
    if (!canImport || (!grant.unrestricted && grant.rows.kind !== 'all')) {
      return {
        ...record,
        diff: { ...record.diff, samples: { added: [], changed: [], deleted: [] } },
      }
    }
    if (grant.hidden.size === 0 && grant.masked.size === 0) return record
    const keyHidden = keyFields.some((key) => grant.hidden.has(key) || grant.masked.has(key))
    const clean = (rows: ImportDiff['samples']['added']) =>
      rows.map((row) => ({
        ...row,
        key: keyHidden ? row.key.map(() => null) : row.key,
        changes: row.changes
          .filter((change) => !grant.hidden.has(change.field))
          .map((change) =>
            grant.masked.has(change.field)
              ? { field: change.field, before: null, after: null, masked: true }
              : change,
          ),
      }))
    return {
      ...record,
      diff: {
        ...record.diff,
        samples: {
          added: clean(samples.added),
          changed: clean(samples.changed),
          deleted: clean(samples.deleted),
        },
      },
    }
  },

  /** Список импортов — без примеров изменений (их показывает запись импорта). */
  withoutSamples(record: ImportRecord): ImportRecord {
    if (!record.diff) return record
    return { ...record, diff: { ...record.diff, samples: { added: [], changed: [], deleted: [] } } }
  },

  /** Задание воркера: нормализованный CSV → staging → таблица датасета, версия, событие. */
  async load(
    data: unknown,
    progress: (value: number, message?: string) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const { importId } = LoadPayload.parse(data)
    const [row] = await db().select().from(imports).where(eq(imports.id, importId)).limit(1)
    if (!row) throw errors.notFound('Импорт')
    // Завершённый, отменённый или ждущий публикации импорт загрузка не трогает
    if (row.status !== 'loading') return { skipped: true }
    if (!row.normalizedKey) throw errors.conflict('Нормализованный файл ещё не готов')

    const ctx = systemCtx('dataset-import', { initiatorId: row.createdBy })
    const userId = row.createdBy
    const storage = await DatasetService.storage(row.datasetId)
    const physical = stagingColumns(storage, row).map((field) => field.physical)
    const keyColumns = keyColumnsOf(storage)
    // Для diff версии при полной замене: сколько строк было до неё
    const [before] = await db()
      .select({ rows: datasets.rowCount })
      .from(datasets)
      .where(eq(datasets.id, row.datasetId))
      .limit(1)

    let replacement = false
    try {
      const { staging, duplicates } = await fillStaging(row, storage, keyColumns)
      await progress(0.6, 'Файл загружен во временную таблицу')

      const counts = { inserted: 0, updated: 0, deleted: 0 }
      if (row.mode === 'replace') {
        await Physical.prepareReplacement(row.datasetId, staging, physical, importId, userId)
        replacement = true
      }
      await progress(0.8, 'Применение изменений')

      const version = await db().transaction(async (tx) => {
        if (row.mode === 'replace') {
          await Physical.swapReplacement(tx, row.datasetId)
        } else if (row.mode === 'append') {
          counts.inserted = await Physical.append(
            tx,
            storage.table,
            staging,
            physical,
            importId,
            userId,
          )
        } else {
          const result = await Physical.upsert(
            tx,
            storage.table,
            staging,
            physical,
            keyColumns,
            importId,
            userId,
          )
          counts.inserted = result.inserted
          counts.updated = result.updated
          if (row.mode === 'sync') {
            counts.deleted = await Physical.markMissingDeleted(
              tx,
              storage.table,
              staging,
              keyColumns,
              userId,
            )
          }
        }
        const rowCount = await Physical.countRows(tx, storage.table)
        if (row.mode === 'replace') {
          counts.inserted = rowCount
          counts.deleted = before?.rows ?? 0
        }
        const stats = {
          ...(row.stats as Record<string, number>),
          ...counts,
          errors: ((row.stats as Record<string, number>).errors ?? 0) + duplicates.length,
        }
        const number = await DatasetService.bumpVersion(tx, ctx, {
          datasetId: row.datasetId,
          origin: 'import',
          rowCount,
          diff: { added: counts.inserted, updated: counts.updated, deleted: counts.deleted },
          importId,
        })
        const sample = [
          ...(row.errorSample as Record<string, unknown>[]),
          ...duplicates.map((rowNumber) => ({
            row: rowNumber,
            column: storage.primaryKey.join(', '),
            value: null,
            reason: 'duplicate_key',
          })),
        ].slice(0, ERROR_SAMPLE_LIMIT)
        await tx
          .update(imports)
          .set({
            status: 'succeeded',
            stats,
            errorSample: sample,
            version: number,
            finishedAt: sql`now()`,
          })
          .where(eq(imports.id, importId))
        await publishEvent(tx, ctx, {
          type: 'dataset.imported',
          object: await objectMeta(tx, row.datasetId),
          payload: {
            importId,
            version: number,
            mode: row.mode,
            rows: (row.stats as Record<string, number>).rows ?? 0,
            inserted: counts.inserted,
            updated: counts.updated,
            deleted: counts.deleted,
            errors: stats.errors,
          },
        })
        return number
      })
      replacement = false
      await Physical.analyze(storage.table)
      await deleteObject(row.normalizedKey, buckets.files()).catch(() => undefined)
      return { version, ...counts, duplicates: duplicates.length }
    } catch (error) {
      logger().error({ err: error, importId }, 'импорт датасета не выполнен')
      if (replacement) await Physical.dropReplacement(row.datasetId).catch(() => undefined)
      throw error
    } finally {
      await Physical.dropStaging(importId).catch(() => undefined)
    }
  },

  /** Последняя попытка задания загрузки не удалась — импорт помечается ошибкой. */
  async markFailed(importId: string, reason: string): Promise<void> {
    await db().transaction(async (tx) => {
      const [row] = await tx
        .update(imports)
        .set({ status: 'failed', message: reason.slice(0, 1000), finishedAt: sql`now()` })
        // Завершённый или отменённый импорт не перетирается запоздалым сбоем повтора
        .where(
          and(eq(imports.id, importId), notInArray(imports.status, [...IMPORT_FINAL_STATUSES])),
        )
        .returning()
      if (!row) return
      await publishFailed(
        tx,
        systemCtx('dataset-import', { initiatorId: row.createdBy }),
        row.datasetId,
        importId,
        reason,
      )
    })
  },
}

async function publishFailed(
  tx: Executor,
  ctx: Ctx,
  datasetId: string,
  importId: string,
  reason: string,
): Promise<void> {
  await publishEvent(tx, ctx, {
    type: 'dataset.import_failed',
    object: await objectMeta(tx, datasetId),
    payload: { importId, reason: reason.slice(0, 500) },
  })
}
