import {
  type DatasetFieldInput,
  PIPELINE_MAX_ROWS,
  PIPELINE_PREVIEW_ROWS,
  type PipelineCreateInput,
  PipelineDefinition,
  type PipelineListItem,
  type PipelinePreviewInput,
  type PipelineRecord,
  type PipelineRunRecord,
  type PipelineRunResult,
  type PipelineStatus,
  type PipelineTrigger,
  type PipelineUpdateInput,
  type PipelineValidateResult,
  type QueryResult,
  type QueryResultField,
  type QuerySpec,
  STORED_FIELD_TYPES,
  type StoredFieldType,
} from '@kchs/contracts'
import { type CompiledQuery, collectSources } from '@kchs/query'
import { UnrecoverableError } from 'bullmq'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { nextRuns } from '~/kernel/schedules/index.js'
import { actorId, type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, pipelineRuns, pipelines } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { Physical, type PhysicalColumn } from '../infra/physical.js'
import { DatasetService, type DatasetStorage, defaultSemantic } from './dataset-service.js'
import { compilePipelineSpec, PipelineStepError } from './pipeline-compile.js'
import { QueryService } from './query-service.js'

/** Что умеет выполнить `QueryService.stream`: запрос компилятора или сырой SQL. */
type StreamableQuery = Pick<
  CompiledQuery,
  'sql' | 'params' | 'countSql' | 'countParams' | 'timeoutMs'
> & { timezone?: string }

export const PIPELINE_JOB = { queue: 'data', name: 'pipeline.run' } as const

/** Тайм-аут запроса пайплайна — как у анализа и экспорта (06-…md §5). */
const PIPELINE_TIMEOUT_MS = 600_000
const PROGRESS_EVERY = 10_000
const ACTIVE = new Set<PipelineStatus>(['queued', 'running'])
const STORED = new Set<string>(STORED_FIELD_TYPES)
const FIELD_KEY = /^[a-z_][a-z0-9_]*$/

export interface PipelineJobData {
  pipelineId: string
  runId: string
}

type PipelineRow = typeof pipelines.$inferSelect
type ObjectRow = Pick<typeof objects.$inferSelect, 'title' | 'spaceId' | 'parentId'>
type LoadedObject = ObjectRow & { ownerId: string | null; createdAt: string; updatedAt: string }

const definitionOf = (row: PipelineRow): PipelineDefinition =>
  PipelineDefinition.parse(row.definition)

/** Права или определение больше не позволяют запуск — повтор не поможет. */
function permanent(error: unknown): never {
  if (error instanceof PipelineStepError) throw new UnrecoverableError(error.message)
  if (error instanceof AppError) throw new UnrecoverableError(error.message)
  throw error
}

/** Ошибка шага — обычная ошибка проверки с понятным текстом. */
function asValidation(error: unknown): never {
  if (error instanceof PipelineStepError) {
    throw errors.validation(`Шаг «${error.stepId}»: ${error.message}`)
  }
  throw error
}

/** Запрос задания: без кэша, с тайм-аутом заданий. */
const jobSpec = (spec: QuerySpec): QuerySpec => ({
  ...spec,
  options: { ...spec.options, cache: false, timeoutMs: PIPELINE_TIMEOUT_MS },
})

/** Ключ поля результата: snake_case латиницей, уникальный в датасете. */
function fieldKey(name: string, taken: Set<string>): string {
  let key = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  if (!key || !FIELD_KEY.test(key)) key = `f_${key}`.slice(0, 60)
  if (!FIELD_KEY.test(key)) key = 'field'
  let unique = key
  for (let n = 2; taken.has(unique); n++) unique = `${key}_${n}`
  taken.add(unique)
  return unique
}

interface OutputField {
  source: string
  input: DatasetFieldInput
}

function outputFields(fields: QueryResultField[]): OutputField[] {
  const taken = new Set<string>()
  return fields.map((field) => {
    const type = (STORED.has(field.type) ? field.type : 'text') as StoredFieldType
    const semantic =
      field.semantic && field.semantic !== 'system' ? field.semantic : defaultSemantic(type)
    return {
      source: field.name,
      input: {
        key: fieldKey(field.name, taken),
        label: field.label ?? { ru: field.name },
        type,
        semantic,
        ...(field.format ? { format: field.format } : {}),
      } as DatasetFieldInput,
    }
  })
}

function sameSchema(storage: DatasetStorage, fields: OutputField[]): boolean {
  return (
    storage.fields.length === fields.length &&
    storage.fields.every(
      (field, index) =>
        field.key === fields[index]?.input.key && field.type === fields[index]?.input.type,
    )
  )
}

function jsonValue(value: unknown, type: StoredFieldType): unknown {
  if (value instanceof Date) {
    return type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString()
  }
  return value ?? null
}

async function load(
  id: string,
  executor: Executor = db(),
): Promise<{ row: PipelineRow; object: LoadedObject }> {
  const [found] = await executor
    .select({
      row: pipelines,
      object: {
        title: objects.title,
        spaceId: objects.spaceId,
        parentId: objects.parentId,
        ownerId: objects.ownerId,
        createdAt: objects.createdAt,
        updatedAt: objects.updatedAt,
      },
    })
    .from(pipelines)
    .innerJoin(objects, eq(objects.id, pipelines.id))
    .where(eq(pipelines.id, id))
    .limit(1)
  if (!found?.object.spaceId) throw errors.notFound('Пайплайн')
  return found
}

const eventObject = (id: string, object: ObjectRow) => ({
  id,
  type: 'pipeline' as const,
  spaceId: object.spaceId,
  title: object.title,
})

function toRecord(row: PipelineRow, object: LoadedObject, canManage: boolean): PipelineRecord {
  return {
    id: row.id,
    name: object.title,
    description: row.description,
    spaceId: object.spaceId as string,
    parentId: object.parentId,
    definition: definitionOf(row),
    schedule: row.schedule,
    enabled: row.enabled,
    runOnImport: row.runOnImport,
    inputDatasetIds: row.inputDatasetIds,
    outputDatasetId: row.outputDatasetId,
    status: row.status as PipelineStatus,
    jobId: row.jobId,
    rowCount: row.rowCount,
    error: row.error,
    lastRunAt: row.lastRunAt,
    canManage,
    createdAt: object.createdAt,
    updatedAt: row.updatedAt,
  }
}

function runRecord(row: typeof pipelineRuns.$inferSelect): PipelineRunRecord {
  return {
    id: row.id,
    pipelineId: row.pipelineId,
    jobId: row.jobId,
    status: row.status as PipelineRunRecord['status'],
    trigger: row.trigger as PipelineTrigger,
    stats: row.stats,
    error: row.error,
    rejected: row.rejected,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }
}

/** Проверка выражения cron: понятная ошибка вместо падения планировщика. */
function assertCron(pattern: string | null | undefined): void {
  if (!pattern) return
  try {
    nextRuns(pattern, 'UTC', 1)
  } catch {
    throw errors.validation('Не удалось разобрать расписание: нужно выражение cron из пяти полей')
  }
}

/** Поля результата префикса спецификации — компиляция без выполнения. */
const fieldsResolver = (ctx: Ctx) => async (spec: QuerySpec) => {
  const { compiled } = await QueryService.compile(
    ctx,
    { ...spec, options: spec.options },
    {
      maxRows: 1,
    },
  )
  return compiled.fields
}

/** Шаг «свой SQL», если он есть и включён. */
function sqlStepOf(definition: PipelineDefinition): { id: string; sql: string } | null {
  const step = definition.steps.find((item) => item.type === 'custom_sql' && !item.disabled)
  return step?.type === 'custom_sql' ? { id: step.id, sql: step.sql } : null
}

/**
 * Пайплайн преобразований (06-analytics-engine.md §16, ADR-0106): объект
 * реестра с цепочкой шагов, которая компилируется в `QuerySpec` и выполняется
 * заданием с правами запустившего. Результат материализуется в датасет: новая
 * версия при каждом успешном прогоне. Происхождение — зависимости `uses`
 * (пайплайн → входы) и `derives_from` (результат → пайплайн), поэтому узел
 * пайплайна виден в графе `GET /objects/{id}/lineage`.
 */
export const PipelineService = {
  /** Спецификация запроса пайплайна и поля результата — с правами вызывающего. */
  async build(
    ctx: Ctx,
    definition: PipelineDefinition,
    options: { untilStepId?: string | undefined } = {},
  ) {
    try {
      return await compilePipelineSpec(definition, fieldsResolver(ctx), options)
    } catch (error) {
      return asValidation(error)
    }
  },

  /** Проверка определения для конструктора: поля результата или причина отказа. */
  async validate(ctx: Ctx, definition: PipelineDefinition): Promise<PipelineValidateResult> {
    try {
      const sqlStep = sqlStepOf(definition)
      if (sqlStep) {
        const compiled = await QueryService.compileSql(ctx, sqlStep.sql, {
          maxRows: PIPELINE_PREVIEW_ROWS,
        })
        const fields = await QueryService.sqlFields(compiled)
        return {
          ok: true,
          fields: fields.map((field) => ({ name: field.name, type: field.type })),
          stepId: null,
          message: null,
          spec: null,
        }
      }
      const built = await compilePipelineSpec(definition, fieldsResolver(ctx))
      return {
        ok: true,
        fields: built.fields.map((field) => ({ name: field.name, type: field.type })),
        stepId: null,
        message: null,
        spec: built.spec,
      }
    } catch (error) {
      if (error instanceof PipelineStepError) {
        return { ok: false, fields: [], stepId: error.stepId, message: error.message, spec: null }
      }
      if (error instanceof AppError) {
        return { ok: false, fields: [], stepId: null, message: error.message, spec: null }
      }
      throw error
    }
  },

  /** Предпросмотр результата шага на выборке — с политиками смотрящего. */
  async preview(ctx: Ctx, input: PipelinePreviewInput): Promise<QueryResult> {
    const sqlStep = sqlStepOf(input.definition)
    if (sqlStep) {
      const result = await QueryService.runSql(ctx, { sql: sqlStep.sql, params: {} })
      return { ...result, rows: result.rows.slice(0, input.limit) }
    }
    const built = await PipelineService.build(ctx, input.definition, {
      untilStepId: input.untilStepId,
    })
    return QueryService.run(
      ctx,
      { ...built.spec, options: { ...built.spec.options, cache: false } },
      {
        maxRows: input.limit,
      },
    )
  },

  async create(ctx: UserCtx, input: PipelineCreateInput): Promise<string> {
    assertCron(input.schedule)
    const built = await PipelineService.build(ctx, input.definition)
    const sources = collectSources(built.spec)
    const inputs = sources.datasets
    return db().transaction(async (tx) => {
      const object = await ObjectService.create(tx, ctx, {
        type: 'pipeline',
        spaceId: input.spaceId,
        parentId: input.parentId ?? null,
        title: input.name,
        subtitle: input.description ?? null,
        meta: { steps: input.definition.steps.length },
      })
      await tx.insert(pipelines).values({
        id: object.id,
        definition: input.definition as unknown as Record<string, unknown>,
        description: input.description ?? null,
        schedule: input.schedule ?? null,
        enabled: input.enabled,
        runOnImport: input.runOnImport,
        inputDatasetIds: inputs,
        status: 'draft',
      })
      await LinkService.setDependencies(tx, object.id, [...inputs, ...sources.queries], 'uses')
      await publishEvent(tx, ctx, {
        type: 'pipeline.created',
        object: eventObject(object.id, {
          title: input.name,
          spaceId: object.spaceId,
          parentId: input.parentId ?? null,
        }),
        payload: { steps: input.definition.steps.length, datasetIds: inputs },
      })
      return object.id
    })
  },

  async get(ctx: Ctx, id: string): Promise<PipelineRecord> {
    const { row, object } = await load(id)
    const decision = await authorize(ctx, 'edit', id, { soft: true })
    return toRecord(row, object, decision.allowed)
  },

  async list(ctx: Ctx, limit: number): Promise<PipelineListItem[]> {
    const rows = await db()
      .select({ row: pipelines, title: objects.title, spaceId: objects.spaceId })
      .from(pipelines)
      .innerJoin(objects, eq(objects.id, pipelines.id))
      .where(isNull(objects.deletedAt))
      .orderBy(desc(pipelines.updatedAt))
      .limit(limit)
    const visible: PipelineListItem[] = []
    for (const item of rows) {
      const decision = await authorize(ctx, 'view', item.row.id, { soft: true })
      if (!decision.allowed) continue
      visible.push({
        id: item.row.id,
        name: item.title,
        spaceId: item.spaceId as string,
        status: item.row.status as PipelineStatus,
        schedule: item.row.schedule,
        enabled: item.row.enabled,
        outputDatasetId: item.row.outputDatasetId,
        rowCount: item.row.rowCount,
        lastRunAt: item.row.lastRunAt,
      })
    }
    return visible
  },

  async update(ctx: UserCtx, id: string, input: PipelineUpdateInput): Promise<PipelineRecord> {
    const current = await load(id)
    assertCron(input.schedule)
    const definition = input.definition ?? definitionOf(current.row)
    const built = input.definition ? await PipelineService.build(ctx, definition) : null
    const sources = built ? collectSources(built.spec) : null
    const changed: string[] = []
    for (const key of ['name', 'description', 'definition', 'schedule', 'runOnImport', 'enabled']) {
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
        .update(pipelines)
        .set({
          ...(input.definition === undefined
            ? {}
            : { definition: input.definition as unknown as Record<string, unknown> }),
          ...(sources ? { inputDatasetIds: sources.datasets } : {}),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
          ...(input.runOnImport === undefined ? {} : { runOnImport: input.runOnImport }),
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          updatedAt: sql`now()`,
        })
        .where(eq(pipelines.id, id))
      if (sources) {
        await LinkService.setDependencies(tx, id, [...sources.datasets, ...sources.queries], 'uses')
      }
      await publishEvent(tx, ctx, {
        type: 'pipeline.updated',
        object: eventObject(id, current.object),
        payload: { changed },
      })
    })
    return PipelineService.get(ctx, id)
  },

  /** Постановка прогона: запись журнала, задание и событие — одной транзакцией. */
  async schedule(
    tx: Executor,
    ctx: Ctx,
    id: string,
    object: ObjectRow,
    trigger: PipelineTrigger,
  ): Promise<{ jobId: string; runId: string }> {
    const runId = newId()
    const jobId = await JobService.schedule(tx, ctx, {
      ...PIPELINE_JOB,
      objectId: id,
      data: { pipelineId: id, runId } satisfies PipelineJobData as unknown as Record<
        string,
        unknown
      >,
    })
    await tx.insert(pipelineRuns).values({
      id: runId,
      pipelineId: id,
      jobId,
      status: 'queued',
      trigger,
      createdBy: actorId(ctx),
    })
    await tx
      .update(pipelines)
      .set({ status: 'queued', jobId, error: null, updatedAt: sql`now()` })
      .where(eq(pipelines.id, id))
    await publishEvent(tx, ctx, {
      type: 'pipeline.queued',
      object: eventObject(id, object),
      payload: { jobId, runId, trigger },
    })
    return { jobId, runId }
  },

  /** Ручной запуск: определение проверяется сразу, выполняется — заданием. */
  async run(ctx: Ctx, id: string, trigger: PipelineTrigger = 'manual') {
    const current = await load(id)
    await PipelineService.build(ctx, definitionOf(current.row))
    return db().transaction(async (tx) => {
      const [locked] = await tx
        .select({ status: pipelines.status, jobId: pipelines.jobId })
        .from(pipelines)
        .where(eq(pipelines.id, id))
        .for('update')
      if (!locked) throw errors.notFound('Пайплайн')
      if (ACTIVE.has(locked.status as PipelineStatus) && locked.jobId) {
        const job = await JobService.get(locked.jobId)
        if (job && (job.status === 'queued' || job.status === 'running')) {
          throw errors.conflict('Пайплайн уже выполняется')
        }
      }
      return PipelineService.schedule(tx, ctx, id, current.object, trigger)
    })
  },

  async runs(id: string, limit: number): Promise<PipelineRunRecord[]> {
    const rows = await db()
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.pipelineId, id))
      .orderBy(desc(pipelineRuns.startedAt))
      .limit(limit)
    return rows.map(runRecord)
  },

  /** Задание `data:pipeline.run`: права и данные — на момент выполнения. */
  async execute(
    data: PipelineJobData,
    helpers: { recordId: string; progress: (value: number, message?: string) => Promise<void> },
  ): Promise<PipelineRunResult> {
    const job = await JobService.get(helpers.recordId)
    if (!job?.initiatorId) throw new UnrecoverableError('У прогона пайплайна нет инициатора')
    const ctx = await buildUserCtxFor(job.initiatorId)
    if (!ctx) throw new UnrecoverableError('Инициатор прогона не найден')

    let compiled: StreamableQuery
    let resultFields: QueryResultField[]
    let pipeline: Awaited<ReturnType<typeof load>>
    let definition: PipelineDefinition
    try {
      pipeline = await load(data.pipelineId)
      await authorize(ctx, 'run', data.pipelineId)
      definition = definitionOf(pipeline.row)
      const sqlStep = sqlStepOf(definition)
      if (sqlStep) {
        const raw = await QueryService.compileSql(ctx, sqlStep.sql, {
          maxRows: PIPELINE_MAX_ROWS,
          timeoutMs: PIPELINE_TIMEOUT_MS,
        })
        compiled = raw
        resultFields = await QueryService.sqlFields(raw)
      } else {
        const built = await compilePipelineSpec(definition, fieldsResolver(ctx))
        const query = await QueryService.compile(ctx, jobSpec(built.spec), {
          maxRows: PIPELINE_MAX_ROWS,
        })
        compiled = query.compiled
        resultFields = query.compiled.fields
      }
    } catch (error) {
      permanent(error)
    }
    const { row, object } = pipeline
    const fields = outputFields(resultFields)
    if (fields.length === 0) {
      throw new UnrecoverableError('Результат пайплайна без полей — уточните шаги')
    }

    await db().transaction(async (tx) => {
      await tx
        .update(pipelines)
        .set({ status: 'running', jobId: helpers.recordId, updatedAt: sql`now()` })
        .where(eq(pipelines.id, row.id))
      await tx
        .update(pipelineRuns)
        .set({ status: 'running' })
        .where(eq(pipelineRuns.id, data.runId))
      await publishEvent(tx, ctx, {
        type: 'pipeline.started',
        object: eventObject(row.id, object),
        payload: { jobId: helpers.recordId, runId: data.runId },
      })
    })

    const outcome = await db().transaction(async (tx) => {
      let storage = await reusableOutput(tx, ctx, row.outputDatasetId, fields)
      const created = storage === null
      let previous = 0
      if (storage) {
        previous = await Physical.clearRows(tx, storage.table)
      } else {
        try {
          await authorize(ctx, 'create_child', object.parentId ?? (object.spaceId as string))
        } catch (error) {
          permanent(error)
        }
        const datasetId = await DatasetService.create(
          tx,
          ctx,
          {
            name: definition.outputName,
            description: `Результат пайплайна «${object.title}»`,
            spaceId: object.spaceId as string,
            parentId: object.parentId,
            kind: 'table',
            fields: fields.map((field) => field.input),
            primaryKey: [],
            settings: { editable: false, trackHistory: false },
          },
          { accessMode: 'restricted' },
        )
        storage = await DatasetService.storage(datasetId, tx)
      }
      const target = storage
      const columns: PhysicalColumn[] = target.fields.map((field) => ({
        name: field.physical,
        type: field.type as StoredFieldType,
        ...(field.format?.precision !== undefined ? { precision: field.format.precision } : {}),
      }))
      const rows = await QueryService.stream(compiled, async (batches, total) => {
        if (total > PIPELINE_MAX_ROWS) {
          throw new UnrecoverableError(
            `Результат пайплайна — ${total} строк, больше предела ${PIPELINE_MAX_ROWS}`,
          )
        }
        let written = 0
        let reported = 0
        for await (const batch of batches) {
          const records = batch.map((source) =>
            Object.fromEntries(
              fields.map((field, index) => [
                target.fields[index]?.physical as string,
                jsonValue(source[field.source], field.input.type as StoredFieldType),
              ]),
            ),
          )
          written += await Physical.insertJson(tx, target.table, columns, records, actorId(ctx))
          if (written - reported >= PROGRESS_EVERY) {
            reported = written
            await helpers.progress(total > 0 ? Math.min(written / total, 0.99) : 0)
          }
        }
        return written
      })
      const version = await DatasetService.bumpVersion(tx, ctx, {
        datasetId: target.id,
        origin: 'pipeline',
        rowCount: rows,
        diff: { added: rows, updated: 0, deleted: previous },
      })
      await publishEvent(tx, ctx, {
        type: 'dataset.version_created',
        object: {
          id: target.id,
          type: 'dataset',
          spaceId: object.spaceId,
          title: definition.outputName,
        },
        payload: { version, origin: 'pipeline' },
      })
      // Происхождение: результат ← пайплайн ← входы (ADR-0102)
      await LinkService.setDependencies(tx, target.id, [row.id], 'derives_from')
      if (created) await LinkService.link(tx, ctx, target.id, row.id, 'source')
      await tx
        .update(pipelines)
        .set({
          status: 'succeeded',
          outputDatasetId: target.id,
          rowCount: rows,
          error: null,
          lastRunAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(pipelines.id, row.id))
      await tx
        .update(pipelineRuns)
        .set({
          status: 'succeeded',
          stats: { rows, version, datasetId: target.id, created },
          finishedAt: sql`now()`,
        })
        .where(eq(pipelineRuns.id, data.runId))
      await publishEvent(tx, ctx, {
        type: 'pipeline.finished',
        object: eventObject(row.id, object),
        payload: {
          jobId: helpers.recordId,
          runId: data.runId,
          status: 'succeeded',
          datasetId: target.id,
          rows,
          error: null,
        },
      })
      return { datasetId: target.id, rows, created, table: target.table, version }
    })
    await Physical.analyze(outcome.table)
    return {
      datasetId: outcome.datasetId,
      rows: outcome.rows,
      version: outcome.version,
      created: outcome.created,
    }
  },

  /** Окончательный сбой задания (`job.failed`): статус и причина — у пайплайна. */
  async markFailed(pipelineId: string, jobId: string, message: string): Promise<void> {
    const ctx = systemCtx('pipeline-failed')
    await db().transaction(async (tx) => {
      const [updated] = await tx
        .update(pipelines)
        .set({
          status: 'failed',
          error: message.slice(0, 1000),
          lastRunAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(pipelines.id, pipelineId), eq(pipelines.jobId, jobId)))
        .returning({ id: pipelines.id })
      if (!updated) return
      const [run] = await tx
        .update(pipelineRuns)
        .set({ status: 'failed', error: message.slice(0, 1000), finishedAt: sql`now()` })
        .where(and(eq(pipelineRuns.jobId, jobId), eq(pipelineRuns.pipelineId, pipelineId)))
        .returning({ id: pipelineRuns.id })
      const { object } = await load(pipelineId, tx)
      await publishEvent(tx, ctx, {
        type: 'pipeline.finished',
        object: eventObject(pipelineId, object),
        payload: {
          jobId,
          runId: run?.id ?? pipelineId,
          status: 'failed',
          datasetId: null,
          rows: null,
          error: message.slice(0, 1000),
        },
      })
    })
  },

  /**
   * Запуск от имени владельца пайплайна: по расписанию и по событию импорта.
   * Права владельца решают, что увидит запрос, — как `run_as` у правил (ADR-0096).
   */
  async runAsOwner(pipelineId: string, trigger: PipelineTrigger): Promise<string | null> {
    const { row, object } = await load(pipelineId)
    if (!row.enabled) return null
    if (!object.ownerId) {
      logger().warn({ pipelineId }, 'у пайплайна нет владельца — запуск пропущен')
      return null
    }
    const ctx = await buildUserCtxFor(object.ownerId)
    if (!ctx) {
      logger().warn({ pipelineId }, 'владелец пайплайна не найден — запуск пропущен')
      return null
    }
    const started = await PipelineService.run(ctx, pipelineId, trigger)
    return started.runId
  },

  /** Пайплайны, которые ждут события импорта своего входного датасета. */
  async onImport(datasetId: string): Promise<string[]> {
    const rows = await db()
      .select({ id: pipelines.id })
      .from(pipelines)
      .innerJoin(objects, eq(objects.id, pipelines.id))
      .where(
        and(
          isNull(objects.deletedAt),
          eq(pipelines.enabled, true),
          eq(pipelines.runOnImport, true),
          sql`${pipelines.inputDatasetIds} @> ARRAY[${datasetId}]::uuid[]`,
        ),
      )
    return rows.map((row) => row.id)
  },

  /** Строки пайплайна с расписанием — для планировщика и экрана «Расписания». */
  async scheduled(): Promise<
    {
      id: string
      title: string
      cron: string
      enabled: boolean
      lastRunAt: string | null
      status: string
    }[]
  > {
    const rows = await db()
      .select({
        id: pipelines.id,
        title: objects.title,
        cron: pipelines.schedule,
        enabled: pipelines.enabled,
        lastRunAt: pipelines.lastRunAt,
        status: pipelines.status,
      })
      .from(pipelines)
      .innerJoin(objects, eq(objects.id, pipelines.id))
      .where(and(isNull(objects.deletedAt), sql`${pipelines.schedule} is not null`))
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
      await tx.update(pipelines).set({ enabled, updatedAt: sql`now()` }).where(eq(pipelines.id, id))
      await publishEvent(tx, ctx, {
        type: 'pipeline.updated',
        object: eventObject(id, current.object),
        payload: { changed: ['enabled'] },
      })
    })
  },
}

/** Датасет-результат прежнего прогона, пригодный для записи новой версии. */
async function reusableOutput(
  tx: Executor,
  ctx: Ctx,
  outputId: string | null,
  fields: OutputField[],
): Promise<DatasetStorage | null> {
  if (!outputId) return null
  const [object] = await tx
    .select({ deletedAt: objects.deletedAt })
    .from(objects)
    .where(eq(objects.id, outputId))
    .limit(1)
  if (!object || object.deletedAt) return null
  const storage = await DatasetService.storage(outputId, tx)
  if (!sameSchema(storage, fields)) return null
  const decision = await authorize(ctx, 'edit', outputId, { soft: true })
  return decision.allowed ? storage : null
}
