import {
  type DatasetFieldInput,
  SOURCE_MAX_ROWS,
  type SourceColumn,
  type SourceCreateInput,
  type SourceListItem,
  type SourceMode,
  type SourceQuery,
  type SourceRecord,
  type SourceRunRecord,
  type SourceRunResult,
  type SourceStatus,
  type SourceUpdateInput,
  type StoredFieldType,
} from '@kchs/contracts'
import { UnrecoverableError } from 'bullmq'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { nextRuns } from '~/kernel/schedules/index.js'
import { ExternalDatabase, externalValue, Integrations } from '~/modules/integrations/public.js'
import { actorId, type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { integrations, objects, sourceRuns, sources } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { Physical, type PhysicalColumn } from '../infra/physical.js'
import { DatasetService, type DatasetStorage, defaultSemantic } from './dataset-service.js'

export const SOURCE_SYNC_JOB = { queue: 'data', name: 'source.sync' } as const

const ACTIVE = new Set<SourceStatus>(['queued', 'running'])
/** Строк за раз из внешней базы — как пачка курсора импорта. */
const BATCH = 2000

export interface SourceJobData {
  sourceId: string
  runId: string
}

type SourceRow = typeof sources.$inferSelect
type ObjectRow = Pick<typeof objects.$inferSelect, 'title' | 'spaceId' | 'parentId'>
type LoadedObject = ObjectRow & { ownerId: string | null; createdAt: string; updatedAt: string }

/** Настройка источника поверх колонок таблицы: запрос, столбцы, ключ. */
interface SourceConfig {
  query: SourceQuery
  columns: SourceColumn[]
  cursorField: string | null
  keyFields: string[]
  datasetName: string
}

function configOf(row: SourceRow): SourceConfig {
  const raw = row.config as Partial<SourceConfig>
  return {
    query: raw.query as SourceQuery,
    columns: (raw.columns ?? []) as SourceColumn[],
    cursorField: raw.cursorField ?? null,
    keyFields: raw.keyFields ?? [],
    datasetName: raw.datasetName ?? '',
  }
}

/** Столбцы, которые загружаются: у них задан ключ поля датасета. */
const loaded = (columns: SourceColumn[]) => columns.filter((column) => Boolean(column.key))

function assertCron(pattern: string | null | undefined): void {
  if (!pattern) return
  try {
    nextRuns(pattern, 'UTC', 1)
  } catch {
    throw errors.validation('Не удалось разобрать расписание: нужно выражение cron из пяти полей')
  }
}

function assertMode(mode: SourceMode, config: { cursorField: string | null; keyFields: string[] }) {
  if (mode !== 'incremental') return
  if (!config.cursorField) throw errors.validation('Для инкремента нужно поле-курсор')
  if (config.keyFields.length === 0) {
    throw errors.validation('Для инкремента нужен ключ: по нему строки обновляются')
  }
}

async function load(
  id: string,
  executor: Executor = db(),
): Promise<{ row: SourceRow; object: LoadedObject }> {
  const [found] = await executor
    .select({
      row: sources,
      object: {
        title: objects.title,
        spaceId: objects.spaceId,
        parentId: objects.parentId,
        ownerId: objects.ownerId,
        createdAt: objects.createdAt,
        updatedAt: objects.updatedAt,
      },
    })
    .from(sources)
    .innerJoin(objects, eq(objects.id, sources.id))
    .where(eq(sources.id, id))
    .limit(1)
  if (!found?.object.spaceId) throw errors.notFound('Источник')
  return found
}

const eventObject = (id: string, object: ObjectRow) => ({
  id,
  type: 'source' as const,
  spaceId: object.spaceId,
  title: object.title,
})

async function integrationBrief(id: string): Promise<{ name: string | null; kind: string | null }> {
  const [row] = await db()
    .select({ name: objects.title, kind: integrations.kind })
    .from(integrations)
    .innerJoin(objects, eq(objects.id, integrations.id))
    .where(eq(integrations.id, id))
    .limit(1)
  return { name: row?.name ?? null, kind: row?.kind ?? null }
}

async function toRecord(
  row: SourceRow,
  object: LoadedObject,
  canManage: boolean,
): Promise<SourceRecord> {
  const config = configOf(row)
  const integration = await integrationBrief(row.integrationId)
  return {
    id: row.id,
    name: object.title,
    description: row.description,
    spaceId: object.spaceId as string,
    parentId: object.parentId,
    kind: 'database',
    integrationId: row.integrationId,
    integrationName: integration.name,
    integrationKind: integration.kind,
    query: config.query,
    mode: row.mode as SourceMode,
    cursorField: config.cursorField,
    cursorValue: row.cursorValue,
    keyFields: config.keyFields,
    columns: config.columns,
    datasetId: row.datasetId,
    schedule: row.schedule,
    enabled: row.enabled,
    status: row.status as SourceStatus,
    statusMessage: row.statusMessage,
    lastCheckAt: row.lastCheckAt,
    lastRunAt: row.lastRunAt,
    rowCount: row.rowCount,
    jobId: row.jobId,
    canManage,
    createdAt: object.createdAt,
    updatedAt: row.updatedAt,
  }
}

function runRecord(row: typeof sourceRuns.$inferSelect): SourceRunRecord {
  return {
    id: row.id,
    sourceId: row.sourceId,
    jobId: row.jobId,
    status: row.status as SourceRunRecord['status'],
    mode: row.mode as SourceMode,
    stats: row.stats,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }
}

/** Поля датасета по столбцам источника. */
function datasetFieldsOf(columns: SourceColumn[]): DatasetFieldInput[] {
  return loaded(columns).map(
    (column, index) =>
      ({
        key: column.key as string,
        label: column.label ?? { ru: column.name },
        type: column.type,
        semantic: defaultSemantic(column.type as StoredFieldType),
        order: index,
      }) as DatasetFieldInput,
  )
}

/**
 * Источник датасета из внешней СУБД (14-automation-integrations.md §5,
 * ADR-0107): объект реестра `source` с подключением-интеграцией и выборкой.
 * Загрузка — задание: чтение потоком → staging (`COPY`) → полная замена
 * (снимок) или обновление по ключу (инкремент) → новая версия датасета и
 * событие `dataset.imported`, как у импорта файла.
 */
export const SourceService = {
  async create(ctx: UserCtx, input: SourceCreateInput): Promise<string> {
    assertCron(input.schedule)
    assertMode(input.mode, { cursorField: input.cursorField ?? null, keyFields: input.keyFields })
    const fields = datasetFieldsOf(input.columns)
    if (fields.length === 0) throw errors.validation('Выберите хотя бы один столбец')
    const keys = new Set(fields.map((field) => field.key))
    for (const key of input.keyFields) {
      if (!keys.has(key)) throw errors.validation(`Ключевого поля «${key}» нет среди столбцов`)
    }
    // Право вести подключение проверяется у интеграции, а не здесь
    await authorize(ctx, 'view', input.integrationId)

    return db().transaction(async (tx) => {
      const object = await ObjectService.create(tx, ctx, {
        type: 'source',
        spaceId: input.spaceId,
        parentId: input.parentId ?? null,
        title: input.name,
        subtitle: input.description ?? null,
        meta: { mode: input.mode },
      })
      const datasetId = await DatasetService.create(tx, ctx, {
        name: input.datasetName ?? input.name,
        description: `Данные источника «${input.name}»`,
        spaceId: input.spaceId,
        parentId: input.parentId ?? null,
        kind: 'table',
        fields,
        primaryKey: input.keyFields,
        // Снимок внешней базы: строки заменяет синхронизация
        settings: { editable: false, trackHistory: false },
      })
      const config: SourceConfig = {
        query: input.query,
        columns: input.columns,
        cursorField: input.cursorField ?? null,
        keyFields: input.keyFields,
        datasetName: input.datasetName ?? input.name,
      }
      await tx.insert(sources).values({
        id: object.id,
        kind: 'database',
        integrationId: input.integrationId,
        config: config as unknown as Record<string, unknown>,
        description: input.description ?? null,
        mode: input.mode,
        datasetId,
        schedule: input.schedule ?? null,
        enabled: input.enabled,
        status: 'draft',
      })
      await tx.update(objects).set({ updatedAt: sql`now()` }).where(eq(objects.id, object.id))
      // Происхождение: датасет ← источник ← интеграция (ADR-0102)
      await LinkService.setDependencies(tx, object.id, [input.integrationId], 'uses')
      await LinkService.setDependencies(tx, datasetId, [object.id], 'derives_from')
      await LinkService.link(tx, ctx, datasetId, object.id, 'source')
      await publishEvent(tx, ctx, {
        type: 'source.created',
        object: eventObject(object.id, {
          title: input.name,
          spaceId: object.spaceId,
          parentId: input.parentId ?? null,
        }),
        payload: { kind: 'database', integrationId: input.integrationId, mode: input.mode },
      })
      return object.id
    })
  },

  async get(ctx: Ctx, id: string): Promise<SourceRecord> {
    const { row, object } = await load(id)
    const decision = await authorize(ctx, 'edit', id, { soft: true })
    return toRecord(row, object, decision.allowed)
  },

  async list(ctx: Ctx, limit: number): Promise<SourceListItem[]> {
    const rows = await db()
      .select({ row: sources, title: objects.title, spaceId: objects.spaceId })
      .from(sources)
      .innerJoin(objects, eq(objects.id, sources.id))
      .where(isNull(objects.deletedAt))
      .orderBy(desc(sources.updatedAt))
      .limit(limit)
    const visible: SourceListItem[] = []
    for (const item of rows) {
      const decision = await authorize(ctx, 'view', item.row.id, { soft: true })
      if (!decision.allowed) continue
      visible.push({
        id: item.row.id,
        name: item.title,
        spaceId: item.spaceId as string,
        kind: 'database',
        mode: item.row.mode as SourceMode,
        status: item.row.status as SourceStatus,
        schedule: item.row.schedule,
        enabled: item.row.enabled,
        datasetId: item.row.datasetId,
        rowCount: item.row.rowCount,
        lastRunAt: item.row.lastRunAt,
      })
    }
    return visible
  },

  async update(ctx: UserCtx, id: string, input: SourceUpdateInput): Promise<SourceRecord> {
    const current = await load(id)
    const config = configOf(current.row)
    assertCron(input.schedule)
    const next: SourceConfig = {
      query: input.query ?? config.query,
      columns: input.columns ?? config.columns,
      cursorField: input.cursorField === undefined ? config.cursorField : input.cursorField,
      keyFields: input.keyFields ?? config.keyFields,
      datasetName: config.datasetName,
    }
    assertMode((input.mode ?? current.row.mode) as SourceMode, next)
    const changed: string[] = []
    for (const key of ['name', 'description', 'query', 'mode', 'columns', 'schedule', 'enabled']) {
      if ((input as Record<string, unknown>)[key] !== undefined) changed.push(key)
    }
    await db().transaction(async (tx) => {
      if (input.name !== undefined || input.description !== undefined) {
        await ObjectService.update(
          tx,
          ctx,
          id,
          {
            ...(input.name === undefined ? {} : { title: input.name }),
            ...(input.description === undefined ? {} : { subtitle: input.description }),
          },
          { silent: true },
        )
      }
      await tx
        .update(sources)
        .set({
          config: next as unknown as Record<string, unknown>,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.mode === undefined ? {} : { mode: input.mode }),
          ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          updatedAt: sql`now()`,
        })
        .where(eq(sources.id, id))
      await publishEvent(tx, ctx, {
        type: 'source.updated',
        object: eventObject(id, current.object),
        payload: { changed },
      })
    })
    return SourceService.get(ctx, id)
  },

  /** Постановка синхронизации: запись журнала, задание и событие — одной транзакцией. */
  async schedule(tx: Executor, ctx: Ctx, id: string, row: SourceRow, object: ObjectRow) {
    const runId = newId()
    const jobId = await JobService.schedule(tx, ctx, {
      ...SOURCE_SYNC_JOB,
      objectId: id,
      data: { sourceId: id, runId } satisfies SourceJobData as unknown as Record<string, unknown>,
    })
    await tx.insert(sourceRuns).values({
      id: runId,
      sourceId: id,
      jobId,
      status: 'queued',
      mode: row.mode,
      createdBy: actorId(ctx),
    })
    await tx
      .update(sources)
      .set({ status: 'queued', jobId, statusMessage: null, updatedAt: sql`now()` })
      .where(eq(sources.id, id))
    await publishEvent(tx, ctx, {
      type: 'source.queued',
      object: eventObject(id, object),
      payload: { jobId, runId, mode: row.mode },
    })
    return { jobId, runId }
  },

  async run(ctx: Ctx, id: string) {
    const current = await load(id)
    if (!current.row.enabled) throw errors.conflict('Источник выключен')
    return db().transaction(async (tx) => {
      const [locked] = await tx
        .select({ status: sources.status, jobId: sources.jobId })
        .from(sources)
        .where(eq(sources.id, id))
        .for('update')
      if (!locked) throw errors.notFound('Источник')
      if (ACTIVE.has(locked.status as SourceStatus) && locked.jobId) {
        const job = await JobService.get(locked.jobId)
        if (job && (job.status === 'queued' || job.status === 'running')) {
          throw errors.conflict('Синхронизация уже выполняется')
        }
      }
      return SourceService.schedule(tx, ctx, id, current.row, current.object)
    })
  },

  /** Запуск от имени владельца — по расписанию. */
  async runAsOwner(sourceId: string): Promise<string | null> {
    const { row, object } = await load(sourceId)
    if (!row.enabled || !object.ownerId) return null
    const ctx = await buildUserCtxFor(object.ownerId)
    if (!ctx) {
      logger().warn({ sourceId }, 'владелец источника не найден — синхронизация пропущена')
      return null
    }
    const started = await SourceService.run(ctx, sourceId)
    return started.runId
  },

  async runs(id: string, limit: number): Promise<SourceRunRecord[]> {
    const rows = await db()
      .select()
      .from(sourceRuns)
      .where(eq(sourceRuns.sourceId, id))
      .orderBy(desc(sourceRuns.startedAt))
      .limit(limit)
    return rows.map(runRecord)
  },

  /** Проверка связи источника: подключение интеграции и его выборка. */
  async check(ctx: UserCtx, id: string): Promise<{ ok: boolean; message: string }> {
    const { row, object } = await load(id)
    const config = configOf(row)
    let result: { ok: boolean; message: string }
    try {
      const columns = await ExternalDatabase.columns(row.integrationId, config.query)
      result = { ok: true, message: `Выборка читается, столбцов: ${columns.length}` }
    } catch (error) {
      result = {
        ok: false,
        message: error instanceof Error ? error.message : 'Выборка не читается',
      }
    }
    await db().transaction(async (tx) => {
      await tx
        .update(sources)
        .set({
          status: result.ok ? row.status : 'error',
          statusMessage: result.message,
          lastCheckAt: sql`now()`,
        })
        .where(eq(sources.id, id))
      if (!result.ok) {
        await publishEvent(tx, ctx, {
          type: 'source.updated',
          object: eventObject(id, object),
          payload: { changed: ['status'] },
        })
      }
    })
    return result
  },

  /** Задание `data:source.sync`: чтение внешней базы и запись версии датасета. */
  async execute(
    data: SourceJobData,
    helpers: { recordId: string; progress: (value: number, message?: string) => Promise<void> },
  ): Promise<SourceRunResult> {
    const job = await JobService.get(helpers.recordId)
    const { row, object } = await load(data.sourceId)
    const config = configOf(row)
    if (!row.datasetId) throw new UnrecoverableError('У источника нет датасета')
    const ctx = job?.initiatorId
      ? ((await buildUserCtxFor(job.initiatorId)) ?? systemCtx('source-sync'))
      : systemCtx('source-sync')

    const mode = row.mode as SourceMode
    const columns = loaded(config.columns)
    const storage = await DatasetService.storage(row.datasetId)
    const byKey = new Map(storage.fields.map((field) => [field.key, field]))
    const physical: PhysicalColumn[] = columns.map((column) => {
      const field = byKey.get(column.key as string)
      if (!field) {
        throw new UnrecoverableError(`Поля «${column.key}» нет в датасете — обновите столбцы`)
      }
      return {
        name: field.physical,
        type: field.type as StoredFieldType,
        ...(field.format?.precision !== undefined ? { precision: field.format.precision } : {}),
      }
    })
    const keyColumns = config.keyFields.map((key) => {
      const field = byKey.get(key)
      if (!field) throw new UnrecoverableError(`Ключевого поля «${key}» нет в датасете`)
      return field.physical
    })

    await db().transaction(async (tx) => {
      await tx
        .update(sources)
        .set({ status: 'running', jobId: helpers.recordId, updatedAt: sql`now()` })
        .where(eq(sources.id, row.id))
      await tx.update(sourceRuns).set({ status: 'running' }).where(eq(sourceRuns.id, data.runId))
    })

    const staging = await Physical.createStaging(data.runId, physical)
    let read = 0
    let cursorValue = row.cursorValue
    try {
      await ExternalDatabase.stream(
        row.integrationId,
        {
          query: config.query,
          ...(mode === 'incremental' ? { cursorField: config.cursorField } : {}),
          ...(mode === 'incremental' ? { cursorValue: row.cursorValue ?? '' } : {}),
        },
        async (batch) => {
          if (read + batch.length > SOURCE_MAX_ROWS) {
            throw new UnrecoverableError(
              `Источник отдал больше ${SOURCE_MAX_ROWS} строк — сузьте выборку`,
            )
          }
          const records = batch.map((source) =>
            Object.fromEntries(
              columns.map((column, index) => [
                physical[index]?.name as string,
                externalValue(source[column.name], column.type),
              ]),
            ),
          )
          await Physical.insertStagingJson(staging, physical, records, read)
          if (mode === 'incremental' && config.cursorField) {
            const last = batch.at(-1)?.[config.cursorField]
            if (last !== undefined && last !== null) {
              cursorValue = String(externalValue(last, 'text'))
            }
          }
          read += batch.length
          await helpers.progress(0.5, `Прочитано строк: ${read}`)
        },
        BATCH,
      )

      const outcome = await db().transaction(async (tx) => {
        const counts = { inserted: 0, updated: 0, deleted: 0 }
        if (mode === 'snapshot') {
          counts.deleted = await Physical.clearRows(tx, storage.table)
          counts.inserted = await Physical.append(
            tx,
            storage.table,
            staging,
            physical.map((column) => column.name),
            data.runId,
            actorId(ctx),
          )
        } else {
          const applied = await Physical.upsert(
            tx,
            storage.table,
            staging,
            physical.map((column) => column.name),
            keyColumns,
            data.runId,
            actorId(ctx),
          )
          counts.inserted = applied.inserted
          counts.updated = applied.updated
        }
        const rowCount = await Physical.countRows(tx, storage.table)
        const version = await DatasetService.bumpVersion(tx, ctx, {
          datasetId: storage.id,
          origin: 'sync',
          rowCount,
          diff: { added: counts.inserted, updated: counts.updated, deleted: counts.deleted },
        })
        await publishEvent(tx, ctx, {
          type: 'dataset.imported',
          object: { id: storage.id, type: 'dataset', spaceId: object.spaceId, title: object.title },
          payload: {
            importId: data.runId,
            version,
            mode: mode === 'snapshot' ? 'replace' : 'upsert',
            rows: read,
            inserted: counts.inserted,
            updated: counts.updated,
            deleted: counts.deleted,
            errors: 0,
          },
        })
        await tx
          .update(sources)
          .set({
            status: 'ok',
            statusMessage: null,
            rowCount,
            cursorValue,
            lastRunAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(eq(sources.id, row.id))
        await tx
          .update(sourceRuns)
          .set({
            status: 'succeeded',
            stats: { rows: read, ...counts, version },
            finishedAt: sql`now()`,
          })
          .where(eq(sourceRuns.id, data.runId))
        await Integrations.recordSync(tx, ctx, {
          integrationId: row.integrationId,
          key: row.id,
          kind: 'database',
          status: 'ok',
          message: `Источник «${object.title}»: ${read} строк`,
          stats: { sourceId: row.id, rows: read, ...counts, version },
        })
        await publishEvent(tx, ctx, {
          type: 'source.synced',
          object: eventObject(row.id, object),
          payload: {
            jobId: helpers.recordId,
            runId: data.runId,
            datasetId: storage.id,
            rows: read,
            inserted: counts.inserted,
            updated: counts.updated,
            version,
          },
        })
        return { rows: read, ...counts, version }
      })
      await Physical.analyze(storage.table)
      return {
        datasetId: storage.id,
        rows: outcome.rows,
        inserted: outcome.inserted,
        updated: outcome.updated,
        version: outcome.version,
      }
    } catch (error) {
      if (error instanceof AppError) throw new UnrecoverableError(error.message)
      throw error
    } finally {
      await Physical.dropStaging(data.runId).catch(() => undefined)
    }
  },

  /** Окончательный сбой задания: состояние источника и журналы. */
  async markFailed(sourceId: string, jobId: string, message: string): Promise<void> {
    const ctx = systemCtx('source-sync-failed')
    await db().transaction(async (tx) => {
      const [updated] = await tx
        .update(sources)
        .set({
          status: 'error',
          statusMessage: message.slice(0, 1000),
          lastRunAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(sources.id, sourceId), eq(sources.jobId, jobId)))
        .returning({ id: sources.id, integrationId: sources.integrationId })
      if (!updated) return
      const [run] = await tx
        .update(sourceRuns)
        .set({ status: 'failed', error: message.slice(0, 1000), finishedAt: sql`now()` })
        .where(and(eq(sourceRuns.jobId, jobId), eq(sourceRuns.sourceId, sourceId)))
        .returning({ id: sourceRuns.id })
      const { object } = await load(sourceId, tx)
      await Integrations.recordSync(tx, ctx, {
        integrationId: updated.integrationId,
        key: sourceId,
        kind: 'database',
        status: 'error',
        message: message.slice(0, 1000),
        stats: { sourceId },
      })
      await publishEvent(tx, ctx, {
        type: 'source.failed',
        object: eventObject(sourceId, object),
        payload: { jobId, runId: run?.id ?? sourceId, error: message.slice(0, 1000) },
      })
    })
  },

  /** Источники с расписанием — планировщику и экрану «Расписания». */
  async scheduled() {
    const rows = await db()
      .select({
        id: sources.id,
        title: objects.title,
        cron: sources.schedule,
        enabled: sources.enabled,
        lastRunAt: sources.lastRunAt,
        status: sources.status,
      })
      .from(sources)
      .innerJoin(objects, eq(objects.id, sources.id))
      .where(and(isNull(objects.deletedAt), sql`${sources.schedule} is not null`))
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      cron: row.cron as string,
      enabled: row.enabled,
      lastRunAt: row.lastRunAt,
      status: row.status,
    }))
  },

  async setEnabled(ctx: UserCtx, id: string, enabled: boolean): Promise<void> {
    const current = await load(id)
    await db().transaction(async (tx) => {
      await tx.update(sources).set({ enabled, updatedAt: sql`now()` }).where(eq(sources.id, id))
      await publishEvent(tx, ctx, {
        type: 'source.updated',
        object: eventObject(id, current.object),
        payload: { changed: ['enabled'] },
      })
    })
  },
}

export type { DatasetStorage }
