import {
  ANALYSIS_MAX_ROWS,
  ANALYSIS_PREVIEW_ROWS,
  type AnalysisCreateInput,
  type AnalysisKind,
  type AnalysisPreviewInput,
  type AnalysisRecord,
  type AnalysisRunResult,
  type AnalysisStatus,
  ChoroplethParams,
  DatasetFieldInput,
  type QueryResult,
  type QueryResultField,
  QuerySpec,
  STORED_FIELD_TYPES,
  type StoredFieldType,
} from '@kchs/contracts'
import { type CompiledQuery, collectSources } from '@kchs/query'
import { UnrecoverableError } from 'bullmq'
import { eq, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { buildUserCtxFor } from '~/kernel/access/explain.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { JobService } from '~/kernel/jobs/service.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { actorId, type Ctx, systemCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { analyses, objects } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { Physical, type PhysicalColumn } from '../infra/physical.js'
import { type ChoroplethFieldMeta, choroplethQuery } from './choropleth.js'
import { DatasetService, type DatasetStorage, defaultSemantic } from './dataset-service.js'
import { QueryService } from './query-service.js'

export const ANALYSIS_JOB = { queue: 'data', name: 'analysis.run' } as const

/** Тайм-аут запроса задания — как у экспорта (06-analytics-engine.md §5: до 10 мин). */
const ANALYSIS_TIMEOUT_MS = 600_000
/** Прогресс задания — раз в столько строк. */
const PROGRESS_EVERY = 10_000
const ACTIVE = new Set<AnalysisStatus>(['queued', 'running'])
const STORED = new Set<string>(STORED_FIELD_TYPES)
const FIELD_KEY = /^[a-z_][a-z0-9_]*$/

/** Данные задания: только идентификатор — параметры и права читаются при выполнении. */
export interface AnalysisJobData {
  analysisId: string
}

/** Подписи и форматы полей результата по ключу (хороплет, ADR-0077). */
type FieldMeta = Record<string, ChoroplethFieldMeta>

/**
 * Воспроизводимые параметры анализа (`analyses.params`): запрос, название
 * результата; у хороплета — ещё его параметры и подписи полей результата.
 */
interface AnalysisParams {
  query: QuerySpec
  outputName: string
  choropleth?: ChoroplethParams
  fields?: FieldMeta
}

/** Запрос анализа, его вид и подписи полей — из запроса или параметров хороплета. */
interface PreparedAnalysis {
  query: QuerySpec
  kind: AnalysisKind
  choropleth: ChoroplethParams | null
  fields: FieldMeta | null
}

type AnalysisRow = typeof analyses.$inferSelect
type ObjectRow = Pick<typeof objects.$inferSelect, 'title' | 'spaceId' | 'parentId'>

/** Вид анализа — операция последнего шага `spatial`; без него анализа нет. */
function kindOf(query: QuerySpec): AnalysisKind {
  const steps = query.steps ?? []
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]
    if (step?.type === 'spatial') return step.op
  }
  throw errors.validation('В анализе нужен шаг spatial — пространственная операция')
}

/** Запрос задания: без кэша, с тайм-аутом заданий. */
function jobSpec(query: QuerySpec): QuerySpec {
  return { ...query, options: { ...query.options, cache: false, timeoutMs: ANALYSIS_TIMEOUT_MS } }
}

function paramsOf(row: AnalysisRow): AnalysisParams {
  const params = row.params as Partial<AnalysisParams>
  const choropleth = params.choropleth ? ChoroplethParams.safeParse(params.choropleth) : null
  return {
    query: QuerySpec.parse(params.query),
    outputName: String(params.outputName ?? ''),
    ...(choropleth?.success ? { choropleth: choropleth.data } : {}),
    ...(params.fields ? { fields: params.fields } : {}),
  }
}

/** Подписи и форматы полей результата запроса — из параметров анализа (хороплет). */
function withMeta(fields: QueryResultField[], meta: FieldMeta | null | undefined) {
  if (!meta) return fields
  return fields.map((field) => {
    const own = meta[field.name]
    return own ? { ...field, label: own.label, format: own.format ?? field.format } : field
  })
}

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
  /** Имя поля в результате запроса. */
  source: string
  input: DatasetFieldInput
}

/** Поля датасета-результата — из полей результата запроса (тип, подпись, формат). */
function outputFields(fields: QueryResultField[]): OutputField[] {
  const taken = new Set<string>()
  return fields.map((field) => {
    const type = (STORED.has(field.type) ? field.type : 'text') as StoredFieldType
    const semantic =
      field.semantic && field.semantic !== 'system' ? field.semantic : defaultSemantic(type)
    return {
      source: field.name,
      input: DatasetFieldInput.parse({
        key: fieldKey(field.name, taken),
        label: field.label ?? { ru: field.name },
        type,
        semantic,
        ...(field.format ? { format: field.format } : {}),
      }),
    }
  })
}

/** Схема прежнего результата подходит новому: те же ключи и типы полей в том же порядке. */
function sameSchema(storage: DatasetStorage, fields: OutputField[]): boolean {
  return (
    storage.fields.length === fields.length &&
    storage.fields.every(
      (field, index) =>
        field.key === fields[index]?.input.key && field.type === fields[index]?.input.type,
    )
  )
}

/** Значение строки результата → JSON для записи (дата — без времени). */
function jsonValue(value: unknown, type: StoredFieldType): unknown {
  if (value instanceof Date) {
    return type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString()
  }
  return value ?? null
}

/** Права или параметры больше не позволяют запуск — повтор не поможет. */
function permanent(error: unknown): never {
  if (error instanceof AppError) throw new UnrecoverableError(error.message)
  throw error
}

function toRecord(row: AnalysisRow, object: ObjectRow & { createdAt: string; updatedAt: string }) {
  const params = paramsOf(row)
  return {
    id: row.id,
    name: object.title,
    spaceId: object.spaceId as string,
    parentId: object.parentId,
    kind: row.kind as AnalysisKind,
    query: params.query,
    choropleth: params.choropleth ?? null,
    outputName: params.outputName,
    inputDatasetIds: row.inputDatasetIds,
    outputDatasetId: row.outputDatasetId,
    status: row.status as AnalysisStatus,
    jobId: row.jobId,
    rowCount: row.rowCount,
    error: row.error,
    lastRunAt: row.lastRunAt,
    createdAt: object.createdAt,
    updatedAt: row.updatedAt,
  } satisfies AnalysisRecord
}

async function load(
  id: string,
  executor: Executor = db(),
): Promise<{ row: AnalysisRow; object: ObjectRow & { createdAt: string; updatedAt: string } }> {
  const [found] = await executor
    .select({
      row: analyses,
      object: {
        title: objects.title,
        spaceId: objects.spaceId,
        parentId: objects.parentId,
        createdAt: objects.createdAt,
        updatedAt: objects.updatedAt,
      },
    })
    .from(analyses)
    .innerJoin(objects, eq(objects.id, analyses.id))
    .where(eq(analyses.id, id))
    .limit(1)
  if (!found?.object.spaceId) throw errors.notFound('Анализ')
  return found
}

const eventObject = (id: string, object: ObjectRow) => ({
  id,
  type: 'analysis' as const,
  spaceId: object.spaceId,
  title: object.title,
})

/** Постановка запуска в той же транзакции: статус «в очереди», задание, событие. */
async function schedule(tx: Executor, ctx: Ctx, id: string, object: ObjectRow): Promise<string> {
  const jobId = await JobService.schedule(tx, ctx, {
    ...ANALYSIS_JOB,
    objectId: id,
    data: { analysisId: id } satisfies AnalysisJobData as unknown as Record<string, unknown>,
  })
  await tx
    .update(analyses)
    .set({ status: 'queued', jobId, error: null, updatedAt: sql`now()` })
    .where(eq(analyses.id, id))
  await publishEvent(tx, ctx, {
    type: 'analysis.queued',
    object: eventObject(id, object),
    payload: { jobId },
  })
  return jobId
}

/**
 * Датасет-результат прежнего запуска, в который можно записать новый результат:
 * существует, не в корзине, схема та же, у запустившего есть право правки.
 * Чужой результат (права правки нет) не перезаписывается — запустивший получит свой.
 */
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

/**
 * Пространственный анализ (07-gis-engine.md §10, ADR-0069): объект реестра с
 * воспроизводимыми параметрами — запросом с шагом `spatial`. Создание проверяет
 * запрос компилятором с правами автора; запуск — задание `data:analysis.run`,
 * которое выполняет запрос с правами запустившего на момент выполнения (как
 * экспорт) и материализует результат в датасет: новый или прежний результат
 * (строки заменяются, если схема не изменилась). Происхождение — зависимости
 * `derives_from` и связь «Источник» датасета с анализом.
 */
export const AnalysisService = {
  /**
   * Запрос анализа: заданный или построенный по параметрам хороплета — с правом
   * видеть датасет-источник и по его схеме (ADR-0077).
   */
  async prepare(
    ctx: Ctx,
    input: { query?: QuerySpec | undefined; choropleth?: ChoroplethParams | undefined },
  ): Promise<PreparedAnalysis> {
    if (input.choropleth) {
      await authorize(ctx, 'view', input.choropleth.datasetId)
      const dataset = await DatasetService.get(input.choropleth.datasetId)
      const built = choroplethQuery(input.choropleth, dataset.fields)
      return {
        query: built.query,
        kind: 'choropleth',
        choropleth: input.choropleth,
        fields: built.fields,
      }
    }
    if (!input.query) throw errors.validation('Нужен запрос анализа или параметры хороплета')
    return { query: input.query, kind: kindOf(input.query), choropleth: null, fields: null }
  },

  /** Проверка запроса анализа компилятором с правами пользователя; источники. */
  async validate(ctx: Ctx, query: QuerySpec): Promise<{ datasets: string[] }> {
    await QueryService.compile(ctx, jobSpec(query), { maxRows: 1 })
    return { datasets: collectSources(query).datasets }
  },

  /**
   * Предпросмотр результата (07-gis-engine.md §10): запрос анализа интерактивно,
   * с правами и политиками смотрящего, до `ANALYSIS_PREVIEW_ROWS` строк; поля — с
   * подписями результата. Ничего не сохраняет.
   */
  async preview(ctx: Ctx, input: AnalysisPreviewInput): Promise<QueryResult> {
    const prepared = await AnalysisService.prepare(ctx, input)
    const result = await QueryService.run(ctx, prepared.query, { maxRows: ANALYSIS_PREVIEW_ROWS })
    return { ...result, fields: withMeta(result.fields, prepared.fields) }
  },

  async create(ctx: Ctx, input: AnalysisCreateInput): Promise<string> {
    if (ctx.kind !== 'user') throw errors.forbidden('Анализ создаёт пользователь')
    const prepared = await AnalysisService.prepare(ctx, input)
    const { kind, query } = prepared
    const { datasets } = await AnalysisService.validate(ctx, query)
    const saved = collectSources(query).queries
    const outputName = input.outputName ?? input.name
    return db().transaction(async (tx) => {
      const object = await ObjectService.create(tx, ctx, {
        type: 'analysis',
        spaceId: input.spaceId,
        parentId: input.parentId ?? null,
        title: input.name,
        meta: { kind },
      })
      const params: AnalysisParams = {
        query,
        outputName,
        ...(prepared.choropleth ? { choropleth: prepared.choropleth } : {}),
        ...(prepared.fields ? { fields: prepared.fields } : {}),
      }
      await tx.insert(analyses).values({
        id: object.id,
        kind,
        params: params as unknown as Record<string, unknown>,
        inputDatasetIds: datasets,
        status: 'draft',
      })
      await LinkService.setDependencies(tx, object.id, [...datasets, ...saved], 'uses')
      const row: ObjectRow = {
        title: input.name,
        spaceId: object.spaceId,
        parentId: input.parentId ?? null,
      }
      await publishEvent(tx, ctx, {
        type: 'analysis.created',
        object: eventObject(object.id, row),
        payload: { kind, datasetIds: datasets },
      })
      if (input.run) await schedule(tx, ctx, object.id, row)
      return object.id
    })
  },

  async get(id: string): Promise<AnalysisRecord> {
    const { row, object } = await load(id)
    return toRecord(row, object)
  },

  /** Перезапуск: запрос проверяется сразу, выполняется — заданием. */
  async run(ctx: Ctx, id: string): Promise<{ jobId: string }> {
    if (ctx.kind !== 'user') throw errors.forbidden('Анализ запускает пользователь')
    const current = await load(id)
    await AnalysisService.validate(ctx, paramsOf(current.row).query)
    return db().transaction(async (tx) => {
      const [locked] = await tx
        .select({ status: analyses.status, jobId: analyses.jobId })
        .from(analyses)
        .where(eq(analyses.id, id))
        .for('update')
      if (!locked) throw errors.notFound('Анализ')
      if (ACTIVE.has(locked.status as AnalysisStatus) && locked.jobId) {
        const job = await JobService.get(locked.jobId)
        // Задание могло пропасть (очистка реестра) — тогда запуск не держит анализ
        if (job && (job.status === 'queued' || job.status === 'running')) {
          throw errors.conflict('Анализ уже выполняется')
        }
      }
      const jobId = await schedule(tx, ctx, id, current.object)
      return { jobId }
    })
  },

  /** Задание `data:analysis.run`: права и данные — на момент выполнения. */
  async execute(
    data: AnalysisJobData,
    helpers: { recordId: string; progress: (value: number, message?: string) => Promise<void> },
  ): Promise<AnalysisRunResult> {
    const job = await JobService.get(helpers.recordId)
    if (!job?.initiatorId) throw new UnrecoverableError('У анализа нет инициатора')
    const ctx = await buildUserCtxFor(job.initiatorId)
    if (!ctx) throw new UnrecoverableError('Инициатор анализа не найден')

    let compiled: CompiledQuery
    let analysis: Awaited<ReturnType<typeof load>>
    try {
      analysis = await load(data.analysisId)
      await authorize(ctx, 'run', data.analysisId)
      ;({ compiled } = await QueryService.compile(ctx, jobSpec(paramsOf(analysis.row).query), {
        maxRows: ANALYSIS_MAX_ROWS,
      }))
    } catch (error) {
      permanent(error)
    }
    const { row, object } = analysis
    const params = paramsOf(row)
    const fields = outputFields(withMeta(compiled.fields, params.fields))

    await db().transaction(async (tx) => {
      await tx
        .update(analyses)
        .set({ status: 'running', jobId: helpers.recordId, updatedAt: sql`now()` })
        .where(eq(analyses.id, row.id))
      await publishEvent(tx, ctx, {
        type: 'analysis.started',
        object: eventObject(row.id, object),
        payload: { jobId: helpers.recordId },
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
            name: params.outputName,
            description: `Результат анализа «${object.title}»`,
            spaceId: object.spaceId as string,
            parentId: object.parentId,
            kind: 'table',
            fields: fields.map((field) => field.input),
            primaryKey: [],
            // Снимок результата: строки заменяет перезапуск, история не нужна
            settings: { editable: false, trackHistory: false },
          },
          // Строки — с правами запустившего: результат закрыт, пока он им не поделится
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
        if (total > ANALYSIS_MAX_ROWS) {
          throw new UnrecoverableError(
            `Результат анализа — ${total} строк, больше предела ${ANALYSIS_MAX_ROWS}: сузьте отбор`,
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
        origin: 'analysis',
        rowCount: rows,
        diff: { added: rows, updated: 0, deleted: previous },
      })
      await publishEvent(tx, ctx, {
        type: 'dataset.version_created',
        object: {
          id: target.id,
          type: 'dataset',
          spaceId: object.spaceId,
          title: params.outputName,
        },
        payload: { version, origin: 'analysis' },
      })
      await LinkService.setDependencies(
        tx,
        target.id,
        [row.id, ...row.inputDatasetIds.filter((id) => id !== target.id)],
        'derives_from',
      )
      if (created) await LinkService.link(tx, ctx, target.id, row.id, 'source')
      await tx
        .update(analyses)
        .set({
          status: 'succeeded',
          outputDatasetId: target.id,
          rowCount: rows,
          error: null,
          lastRunAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(analyses.id, row.id))
      await publishEvent(tx, ctx, {
        type: 'analysis.finished',
        object: eventObject(row.id, object),
        payload: {
          jobId: helpers.recordId,
          status: 'succeeded',
          datasetId: target.id,
          rows,
          error: null,
        },
      })
      return { datasetId: target.id, rows, created, table: target.table }
    })
    await Physical.analyze(outcome.table)
    return { datasetId: outcome.datasetId, rows: outcome.rows, created: outcome.created }
  },

  /** Окончательный сбой задания (`job.failed`): статус и причина — у анализа. */
  async markFailed(analysisId: string, jobId: string, message: string): Promise<void> {
    const ctx = systemCtx('analysis-failed')
    await db().transaction(async (tx) => {
      const [updated] = await tx
        .update(analyses)
        .set({
          status: 'failed',
          error: message.slice(0, 1000),
          lastRunAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(sql`${analyses.id} = ${analysisId} AND ${analyses.jobId} = ${jobId}`)
        .returning({ id: analyses.id })
      // Сбой прежнего запуска после перезапуска состояние не меняет
      if (!updated) return
      const { object } = await load(analysisId, tx)
      await publishEvent(tx, ctx, {
        type: 'analysis.finished',
        object: eventObject(analysisId, object),
        payload: {
          jobId,
          status: 'failed',
          datasetId: null,
          rows: null,
          error: message.slice(0, 1000),
        },
      })
    })
  },
}
