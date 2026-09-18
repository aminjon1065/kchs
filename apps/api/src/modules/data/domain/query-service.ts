import { createHash } from 'node:crypto'
import {
  type FieldType,
  FilterNode,
  type QueryResult,
  type QueryResultField,
  QuerySpec,
} from '@kchs/contracts'
import {
  type CompiledQuery,
  type CompileUser,
  cacheKeyText,
  collectSources,
  compileQuery,
  QueryCompileError,
  type ResolvedDataset,
  type RowPolicy,
} from '@kchs/query'
import { inArray } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import type { Ctx } from '~/shared/context.js'
import { db, queryRoleSql } from '~/shared/db/client.js'
import { pgErrorCode } from '~/shared/db/pg-error.js'
import { queries, queryRuns } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { redis } from '~/shared/redis/index.js'
import { DatasetAccess, type DatasetGrant } from './dataset-access.js'
import { DatasetService, type DatasetStorage } from './dataset-service.js'

/** Результат интерактивного запроса живёт в кэше, пока не сменилась версия данных. */
const CACHE_TTL_SECONDS = 300
/** Запрос отменён по `statement_timeout`. */
const QUERY_CANCELED = '57014'
/** Строк в пачке курсора потокового чтения. */
const STREAM_BATCH = 2000
const NUMERIC = new Set<string>(['integer', 'number', 'decimal', 'money', 'percent'])

export interface RunOptions {
  params?: Record<string, unknown>
  /** Режим таблицы датасета: `_id` и `_ver` строк в результате. */
  rowMeta?: boolean
  /** Посчитать строки под фильтром без лимита. */
  count?: boolean
  /** Предел строк интерактивного результата; null — без предела (задания). */
  maxRows?: number | null
  /** Сохранённый запрос — для журнала запусков. */
  queryId?: string | null
}

/**
 * Политика строк для компилятора: несколько политик — через OR. Политика,
 * которую не удалось прочитать, не открывает ни одной строки.
 */
function rowPolicyOf(grant: DatasetGrant): RowPolicy {
  if (grant.rows.kind !== 'filter') return grant.rows
  const nodes = grant.rows.filters.flatMap((filter) => {
    const parsed = FilterNode.safeParse(filter)
    return parsed.success ? [parsed.data] : []
  })
  if (nodes.length === 0) return { kind: 'none' }
  return { kind: 'filter', where: nodes.length === 1 ? (nodes[0] as FilterNode) : { or: nodes } }
}

/** Источник для компилятора: физическая таблица и поля датасета с заданными политиками. */
function resolvedFrom(
  storage: Pick<DatasetStorage, 'id' | 'table' | 'fields' | 'currentVersion'>,
  rowPolicy: RowPolicy,
  columnPolicy: ResolvedDataset['columnPolicy'],
): ResolvedDataset {
  return {
    id: storage.id,
    table: `ds.${storage.table}`,
    fields: storage.fields.map((field) => ({
      key: field.key,
      type: field.type,
      physical: field.physical,
      label: field.label,
      semantic: field.semantic,
      format: field.format ?? null,
    })),
    rowPolicy,
    columnPolicy,
    version: storage.currentVersion,
    systemColumns: true,
  }
}

/** Датасет-источник с политиками текущего пользователя (слой DatasetAccess). */
async function resolveDataset(
  ctx: Ctx,
  id: string,
): Promise<{ dataset: ResolvedDataset; schemaVersion: number }> {
  const grant = await DatasetAccess.resolve(ctx, id)
  const storage = await DatasetService.storage(id)
  return {
    dataset: resolvedFrom(storage, rowPolicyOf(grant), {
      hide: [...grant.hidden],
      mask: [...grant.masked],
    }),
    schemaVersion: storage.schemaVersion,
  }
}

function compileUser(ctx: Ctx): CompileUser {
  if (ctx.kind !== 'user') {
    return {
      id: '00000000-0000-0000-0000-000000000000',
      unitIds: [],
      territoryIds: [],
      subordinateIds: [],
      attributes: {},
    }
  }
  const territoryIds = ctx.attributes.territoryIds
  return {
    id: ctx.userId,
    unitIds: ctx.principals.unitIds,
    territoryIds: Array.isArray(territoryIds) ? territoryIds.map(String) : [],
    subordinateIds: [],
    attributes: ctx.attributes,
  }
}

/** Значение результата в JSON по типу поля: числа из bigint/numeric, даты — ISO 8601. */
function jsonValue(value: unknown, type: FieldType): unknown {
  if (value === null || value === undefined) return null
  if (NUMERIC.has(type) && typeof value === 'string') return Number(value)
  if (value instanceof Date) {
    return type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString()
  }
  return value
}

/** Ошибки компиляции — 400 со списком проблем (путь, сообщение, позиция в выражении). */
function compileError(error: QueryCompileError): AppError {
  return new AppError('validation_failed', error.issues[0]?.message ?? error.message, 400, {
    data: { issues: error.issues },
  })
}

async function loadSavedQueries(ctx: Ctx, ids: string[]): Promise<Map<string, QuerySpec>> {
  if (ids.length === 0) return new Map()
  for (const id of ids) await authorize(ctx, 'view', id)
  const rows = await db()
    .select({ id: queries.id, spec: queries.spec })
    .from(queries)
    .where(inArray(queries.id, ids))
  return new Map(rows.map((row) => [row.id, row.spec as unknown as QuerySpec]))
}

async function recordRun(
  ctx: Ctx,
  input: {
    queryId?: string | null
    specHash: string
    durationMs: number
    rowCount: number | null
    cached: boolean
    error?: string
  },
): Promise<void> {
  await db()
    .insert(queryRuns)
    .values({
      queryId: input.queryId ?? null,
      userId: ctx.kind === 'user' ? ctx.userId : null,
      specHash: input.specHash,
      durationMs: input.durationMs,
      rowCount: input.rowCount,
      cached: input.cached,
      error: input.error?.slice(0, 1000) ?? null,
    })
    .catch((error: unknown) => logger().warn({ err: error }, 'журнал запусков запросов не записан'))
}

/**
 * Проверка фильтра политики строк так же, как при чтении: поля датасета (и
 * скрытые), макросы пользователя, без параметров запроса. Ошибка — 400 с
 * путём и сообщением компилятора.
 */
export function checkRowPolicy(
  ctx: Ctx,
  storage: Pick<DatasetStorage, 'id' | 'table' | 'fields' | 'currentVersion'>,
  filter: FilterNode,
): void {
  const spec = QuerySpec.parse({
    version: 1,
    source: { kind: 'dataset', id: storage.id },
    steps: [],
  })
  const dataset = resolvedFrom(storage, { kind: 'filter', where: filter }, { hide: [], mask: [] })
  try {
    compileQuery(spec, {
      datasets: new Map([[storage.id, dataset]]),
      user: compileUser(ctx),
      now: new Date(),
      maxRows: 1,
    })
  } catch (error) {
    if (error instanceof QueryCompileError) throw compileError(error)
    throw error
  }
}

/**
 * Выполнение QuerySpec (06-analytics-engine.md §5): источники с политиками
 * пользователя → компиляция → кэш Redis по версиям и политикам → выполнение под
 * `kchs_query` в транзакции только для чтения с тайм-аутом → колоночный результат.
 */
export const QueryService = {
  async compile(
    ctx: Ctx,
    spec: QuerySpec,
    options: RunOptions = {},
  ): Promise<{ compiled: CompiledQuery; schemaVersions: string }> {
    let sources = collectSources(spec)
    const saved = await loadSavedQueries(ctx, sources.queries)
    if (saved.size > 0) sources = collectSources(spec, saved)
    if (sources.sql) throw errors.validation('Сырой SQL выполняется в SQL-лаборатории')
    if (sources.system.length > 0) {
      throw errors.validation('Системные датасеты пока недоступны в запросах')
    }
    const resolved = await Promise.all(sources.datasets.map((id) => resolveDataset(ctx, id)))
    const datasets = new Map(resolved.map((item) => [item.dataset.id, item.dataset]))
    try {
      const compiled = compileQuery(spec, {
        datasets,
        queries: saved,
        user: compileUser(ctx),
        params: options.params ?? {},
        now: new Date(),
        ...(ctx.kind === 'user' ? { timezone: ctx.timezone } : {}),
        ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
        rowMeta: options.rowMeta ?? false,
      })
      // Подписи полей — из схемы, поэтому её версия тоже входит в ключ кэша
      const schemaVersions = resolved
        .map((item) => `${item.dataset.id}:${item.schemaVersion}`)
        .sort()
        .join(',')
      return { compiled, schemaVersions }
    } catch (error) {
      if (error instanceof QueryCompileError) throw compileError(error)
      throw error
    }
  },

  async run(ctx: Ctx, spec: QuerySpec, options: RunOptions = {}): Promise<QueryResult> {
    const started = performance.now()
    const { compiled, schemaVersions } = await QueryService.compile(ctx, spec, options)
    const count = options.count ?? false
    const specHash = createHash('sha256')
      .update(`${cacheKeyText(compiled.cacheKeyParts)}|${schemaVersions}|${count}`)
      .digest('hex')
    const cacheKey = `kchs:query:${specHash}`

    const hit = await redis().get(cacheKey)
    if (hit) {
      const result = { ...(JSON.parse(hit) as QueryResult), cached: true }
      const durationMs = performance.now() - started
      await recordRun(ctx, {
        queryId: options.queryId,
        specHash,
        durationMs,
        rowCount: result.rows.length,
        cached: true,
      })
      return { ...result, durationMs }
    }

    let rows: Array<Record<string, unknown>>
    let total: number | null = null
    try {
      const executed = await queryRoleSql().begin('read only', async (sql) => {
        await sql`SELECT set_config('statement_timeout', ${String(compiled.timeoutMs)}, true)`
        const data = await sql.unsafe(compiled.sql, compiled.params as never[])
        const counted = count
          ? await sql.unsafe(compiled.countSql, compiled.countParams as never[])
          : null
        return { data, counted }
      })
      rows = executed.data as unknown as Array<Record<string, unknown>>
      total = executed.counted
        ? Number((executed.counted[0] as unknown as { count: unknown } | undefined)?.count ?? 0)
        : null
    } catch (error) {
      const durationMs = performance.now() - started
      await recordRun(ctx, {
        queryId: options.queryId,
        specHash,
        durationMs,
        rowCount: null,
        cached: false,
        error: error instanceof Error ? error.message : String(error),
      })
      if (pgErrorCode(error) === QUERY_CANCELED) throw errors.queryTimeout()
      throw error
    }

    const truncated = compiled.maxRows !== null && rows.length > compiled.maxRows
    if (truncated && compiled.maxRows !== null) rows = rows.slice(0, compiled.maxRows)
    const fields: QueryResultField[] = compiled.fields
    const result: QueryResult = {
      fields,
      rows: rows.map((row) => fields.map((field) => jsonValue(row[field.name], field.type))),
      rowCount: total,
      approx: false,
      truncated,
      durationMs: performance.now() - started,
      cached: false,
    }
    await redis().set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS)
    await recordRun(ctx, {
      queryId: options.queryId,
      specHash,
      durationMs: result.durationMs,
      rowCount: result.rows.length,
      cached: false,
    })
    return result
  },

  /**
   * Потоковое чтение для заданий (экспорт): курсор пачками в транзакции только
   * для чтения под `kchs_query`, тот же тайм-аут; сначала — число строк для
   * прогресса. Кэш результатов не участвует.
   */
  async stream<T>(
    compiled: CompiledQuery,
    consume: (batches: AsyncIterable<Array<Record<string, unknown>>>, total: number) => Promise<T>,
    batchSize = STREAM_BATCH,
  ): Promise<T> {
    try {
      const result = await queryRoleSql().begin('read only', async (sql) => {
        await sql`SELECT set_config('statement_timeout', ${String(compiled.timeoutMs)}, true)`
        const counted = await sql.unsafe(compiled.countSql, compiled.countParams as never[])
        const total = Number((counted[0] as { count?: unknown } | undefined)?.count ?? 0)
        const cursor = sql.unsafe(compiled.sql, compiled.params as never[]).cursor(batchSize)
        return consume(cursor as AsyncIterable<Array<Record<string, unknown>>>, total)
      })
      return result as T
    } catch (error) {
      if (pgErrorCode(error) === QUERY_CANCELED) throw errors.queryTimeout()
      throw error
    }
  },
}
