import type { Readable } from 'node:stream'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import {
  type DatasetFieldInput,
  IMPORT_LIMITS,
  ImportAnalysis,
  type ImportAnalyzeInput,
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
import { config } from '~/shared/config/index.js'
import { type Ctx, systemCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { datasets, imports, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { Physical } from '../infra/physical.js'
import { DatasetService, type DatasetStorage, defaultSemantic } from './dataset-service.js'

/** Задания импорта (ADR-0046). */
export const NORMALIZE_JOB = { queue: 'imports', name: 'dataset.normalize' } as const
export const LOAD_JOB = { queue: 'data', name: 'dataset.load' } as const

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
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
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

async function engineAnalyze(body: unknown): Promise<unknown> {
  const env = config()
  if (!env.ENGINE_INTERNAL_URL || !env.INTERNAL_SERVICE_TOKEN) {
    throw errors.unavailable('Движок недоступен: не заданы ENGINE_INTERNAL_URL и сервисный токен')
  }
  let response: Response
  try {
    response = await fetch(`${env.ENGINE_INTERNAL_URL}/data/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kchs-service-token': env.INTERNAL_SERVICE_TOKEN,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(IMPORT_LIMITS.analyzeTimeoutMs + 5_000),
    })
  } catch (error) {
    throw errors.dependencyFailed('Движок не ответил', {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  if (response.status === 422) {
    // Движок не смог прочитать файл: это ошибка данных, а не сбой
    const detail = (await response.json().catch(() => ({}))) as { detail?: unknown }
    throw errors.validation(
      typeof detail.detail === 'string' ? detail.detail : 'Файл не удалось прочитать',
    )
  }
  if (!response.ok) {
    throw errors.dependencyFailed('Движок не разобрал файл', { status: response.status })
  }
  return response.json()
}

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
    const result = await engineAnalyze({
      bucket: source.bucket,
      key: source.storageKey,
      fileName: source.name,
      options: input.options,
    })
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
        createdBy: ctx.kind === 'user' ? ctx.userId : null,
      })
      .returning()
    const [object] = await tx
      .select({ spaceId: objects.spaceId, title: objects.title })
      .from(objects)
      .where(eq(objects.id, datasetId))
      .limit(1)
    await publishEvent(tx, ctx, {
      type: 'dataset.import_started',
      object: {
        id: datasetId,
        type: 'dataset',
        spaceId: object?.spaceId ?? null,
        title: object?.title,
      },
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
   * Итог нормализации от движка → задание загрузки. Повтор отчёта (движок
   * повторил задание) даёт то же задание: ключ идемпотентности — импорт.
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
      if (row.status !== 'normalizing' && row.status !== 'loading') {
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
          status: 'loading',
          stats,
          errorSample: report.errorSample,
          errorsKey: report.errorsKey,
          normalizedKey: report.normalizedKey,
        })
        .where(eq(imports.id, importId))
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

  /** Задание воркера: нормализованный CSV → staging → таблица датасета, версия, событие. */
  async load(
    data: unknown,
    progress: (value: number, message?: string) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const { importId } = LoadPayload.parse(data)
    const [row] = await db().select().from(imports).where(eq(imports.id, importId)).limit(1)
    if (!row) throw errors.notFound('Импорт')
    if (row.status === 'succeeded') return { skipped: true }
    if (!row.normalizedKey) throw errors.conflict('Нормализованный файл ещё не готов')

    const ctx = systemCtx('dataset-import', { initiatorId: row.createdBy })
    const userId = row.createdBy
    const storage = await DatasetService.storage(row.datasetId)
    const mapping = row.mapping as unknown as ImportMappingItem[]
    const columns = loadColumns(storage, mapping, row.geometryField ?? undefined)
    const physical = columns.map((field) => field.physical)
    const keyColumns = storage.primaryKey.map(
      (key) => storage.fields.find((field) => field.key === key)?.physical as string,
    )
    // Для diff версии при полной замене: сколько строк было до неё
    const [before] = await db()
      .select({ rows: datasets.rowCount })
      .from(datasets)
      .where(eq(datasets.id, row.datasetId))
      .limit(1)

    let replacement = false
    try {
      await Physical.dropStaging(importId)
      const staging = await Physical.createStaging(
        importId,
        columns.map((field) => ({
          name: field.physical,
          type: field.type as StoredFieldType,
          precision: field.format?.precision,
        })),
      )
      const object = await s3().send(
        new GetObjectCommand({ Bucket: buckets.files(), Key: row.normalizedKey }),
      )
      await Physical.copyIntoStaging(staging, physical, object.Body as Readable)
      await progress(0.6, 'Файл загружен во временную таблицу')

      const duplicates = await Physical.dropDuplicateKeys(staging, keyColumns)
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
        const [meta] = await tx
          .select({ spaceId: objects.spaceId, title: objects.title })
          .from(objects)
          .where(eq(objects.id, row.datasetId))
          .limit(1)
        await publishEvent(tx, ctx, {
          type: 'dataset.imported',
          object: {
            id: row.datasetId,
            type: 'dataset',
            spaceId: meta?.spaceId ?? null,
            title: meta?.title,
          },
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
        // Завершённый импорт не перетирается запоздалым сбоем повтора
        .where(and(eq(imports.id, importId), notInArray(imports.status, ['succeeded', 'failed'])))
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
  const [meta] = await tx
    .select({ spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, datasetId))
    .limit(1)
  await publishEvent(tx, ctx, {
    type: 'dataset.import_failed',
    object: { id: datasetId, type: 'dataset', spaceId: meta?.spaceId ?? null, title: meta?.title },
    payload: { importId, reason: reason.slice(0, 500) },
  })
}
