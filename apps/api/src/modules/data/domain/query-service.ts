import { createHash } from 'node:crypto'
import {
  type FieldType,
  FilterNode,
  type Locale,
  type QueryExecutor,
  type QueryResult,
  type QueryResultField,
  QuerySpec,
  type SqlRunInput,
} from '@kchs/contracts'
import {
  type CompileContext,
  type CompiledQuery,
  type CompiledRawSql,
  type CompileUser,
  cacheKeyText,
  collectSources,
  compileQuery,
  compileRawSql,
  duckdbDialect,
  type LookupRef,
  MissingReferencesError,
  QueryCompileError,
  type ReferenceMap,
  type ReferenceRequest,
  type ResolvedDataset,
  type RowPolicy,
  rawSqlErrorPosition,
  rawSqlTables,
  referenceKey,
  type SpatialWindow,
  type SqlDataset,
  UnsupportedByDialectError,
} from '@kchs/query'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { authorize, requireCapability, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { systemDataset } from '~/kernel/system-datasets.js'
import { type TerritoryIndex, territoryIndex } from '~/modules/gis/public.js'
import type { Ctx } from '~/shared/context.js'
import { db, queryRoleSql } from '~/shared/db/client.js'
import { pgErrorCode } from '~/shared/db/pg-error.js'
import { objects, queries, queryRuns } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { redis } from '~/shared/redis/index.js'
import { ColumnarService, type ColumnarSource, columnarUnsupported } from './columnar-service.js'
import { DatasetAccess, type DatasetGrant } from './dataset-access.js'
import { DatasetService, type DatasetStorage } from './dataset-service.js'

/** Результат интерактивного запроса живёт в кэше, пока не сменилась версия данных. */
const CACHE_TTL_SECONDS = 300
/** Запрос отменён по `statement_timeout`. */
const QUERY_CANCELED = '57014'
/** Строк в пачке курсора потокового чтения. */
const STREAM_BATCH = 2000
/** Предел строк результата SQL-лаборатории — как у интерактивных запросов. */
const SQL_MAX_ROWS = 50_000

/** Столбцы сырого SQL без поля датасета: тип по OID Postgres. */
const PG_TYPES: Record<number, FieldType> = {
  16: 'boolean',
  20: 'integer',
  21: 'integer',
  23: 'integer',
  700: 'number',
  701: 'number',
  1700: 'decimal',
  1082: 'date',
  1114: 'datetime',
  1184: 'datetime',
  1083: 'time',
  114: 'json',
  3802: 'json',
  1009: 'multi_select',
}

/** Ошибки выполнения по SQLSTATE — понятными словами (06-analytics-engine.md §6). */
const PG_MESSAGES: Record<string, string> = {
  '21000': 'Подзапрос вернул больше одной строки',
  '22003': 'Число вне допустимого диапазона',
  '22007': 'Некорректная дата или время',
  '22008': 'Дата или время вне допустимого диапазона',
  '22012': 'Деление на ноль',
  '2201E': 'Некорректный аргумент логарифма',
  '22023': 'Некорректное значение аргумента',
  '22P02': 'Значение не приводится к нужному типу',
  '42803': 'Поле должно быть в GROUP BY или внутри агрегата',
  '42804': 'Несовместимые типы',
  '42883': 'Нет такой функции или операции для этих типов',
  '42P18': 'Не удалось определить тип значения',
  '53200': 'Запросу не хватило памяти',
  '54001': 'Запрос слишком сложный',
}
/** Строк справочника в подстановке `lookup_label()`; больше — ошибка запроса. */
const LOOKUP_MAX_ROWS = 10_000
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
  /** Геометрия как есть, а не GeoJSON: обёртка вызывающим (тайлы, ADR-0064). */
  geometryOutput?: 'geojson' | 'raw'
  /** Рамка на поле геометрии — рядом с политикой строк, по индексу GIST (ADR-0064). */
  spatialWindow?: SpatialWindow
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
      lookup: field.lookup ?? null,
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

/**
 * Датасет для компиляции под колоночную копию: поля, которых в Parquet нет
 * (геометрия, вычисляемые), убираются. Запрос, который их читает, не
 * скомпилируется — вызывающий уходит в Postgres. Политики строк и столбцов
 * остаются целиком: их компилятор пишет в подзапрос так же, как для Postgres.
 */
function columnarDataset(dataset: ResolvedDataset): ResolvedDataset {
  const missing = columnarUnsupported(dataset.fields)
  if (missing.size === 0) return dataset
  return { ...dataset, fields: dataset.fields.filter((field) => !missing.has(field.key)) }
}

/** Тяжёлый запрос: сворачивает строки — такие и уходят в колоночную копию. */
function heavyQuery(spec: QuerySpec): boolean {
  return spec.steps.some((step) => step.type === 'aggregate' || step.type === 'pivot')
}

/**
 * Колоночные копии всех датасетов запроса — если tier включён, копии свежие и
 * запрос вообще к ним применим (ADR-0109). Иначе null: считает Postgres.
 */
async function columnarSources(
  spec: QuerySpec,
  sources: { datasets: string[]; system: string[]; sql: boolean },
  options: RunOptions,
): Promise<Map<string, ColumnarSource> | null> {
  const choice = spec.options?.executor ?? 'auto'
  if (choice === 'postgres') return null
  if (sources.sql || sources.system.length > 0 || sources.datasets.length === 0) return null
  // Правка строк, тайлы и геометрия как есть — только основное хранилище
  if (options.rowMeta || options.geometryOutput === 'raw' || options.spatialWindow) return null
  if (choice === 'auto' && !heavyQuery(spec)) return null
  const copies = new Map<string, ColumnarSource>()
  for (const id of sources.datasets) {
    const copy = await ColumnarService.ready(id)
    if (!copy) return null
    copies.set(id, copy)
  }
  if (choice === 'auto') {
    const large = await Promise.all(sources.datasets.map((id) => ColumnarService.large(id)))
    if (!large.some(Boolean)) return null
  }
  return copies
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
  // @my_territories: территории подразделений (ADR-0057) и явный атрибут пользователя
  const assigned = ctx.attributes.territoryIds
  const territoryIds = new Set([
    ...ctx.principals.territoryIds,
    ...(Array.isArray(assigned) ? assigned.map(String) : []),
  ])
  return {
    id: ctx.userId,
    unitIds: ctx.principals.unitIds,
    territoryIds: [...territoryIds],
    subordinateIds: [],
    attributes: ctx.attributes,
  }
}

/** Подстановки территориальных функций — из справочника территорий (модуль GIS). */
function territoryReference(
  index: TerritoryIndex,
  request: ReferenceRequest,
  locale: Locale,
): ReferenceMap | undefined {
  switch (request.kind) {
    case 'territory_level':
      return { values: index.ancestorMap(request.level, request.key), version: index.version }
    case 'territory_name':
      return {
        values: index.nameMap(request.key, locale),
        version: `${index.version}:${locale}`,
      }
    default:
      return undefined
  }
}

/**
 * Иерархия территорий и справочные подстановки для компиляции. Подписи
 * справочников (`lookup_label`) — из `lookups`: их загружает вызывающий, когда
 * компилятор сообщит, что они нужны.
 */
async function referenceContext(
  ctx: Ctx,
  lookups: ReadonlyMap<string, ReferenceMap> = new Map(),
): Promise<Pick<CompileContext, 'territoryDescendants' | 'references'>> {
  const index = await territoryIndex()
  return {
    territoryDescendants: (id) => index.descendants(id),
    references: (request) =>
      request.kind === 'lookup_label'
        ? lookups.get(referenceKey(request))
        : territoryReference(index, request, ctx.locale),
  }
}

/**
 * Подписи справочника для `lookup_label()`: ключ → подпись по строкам, которые
 * видит пользователь (политики справочника действуют). Справочник недоступен
 * пользователю или его поля нет — подписей нет: ни ошибки, ни чужих значений.
 */
async function lookupReference(ctx: Ctx, ref: LookupRef): Promise<ReferenceMap> {
  const fields = [...new Set([ref.keyField, ref.labelField])]
  const spec = QuerySpec.parse({
    version: 1,
    source: { kind: 'dataset', id: ref.datasetId },
    steps: [{ type: 'select', fields }],
  })
  let result: QueryResult
  try {
    result = await QueryService.run(ctx, spec, { maxRows: LOOKUP_MAX_ROWS })
  } catch (error) {
    if (error instanceof AppError && [400, 403, 404].includes(error.status)) {
      return { values: {}, version: 'unavailable' }
    }
    throw error
  }
  if (result.truncated) {
    throw errors.validation(
      `В справочнике больше ${LOOKUP_MAX_ROWS} строк — подписи lookup_label() недоступны`,
    )
  }
  const keyIndex = result.fields.findIndex((field) => field.name === ref.keyField)
  const labelIndex = result.fields.findIndex((field) => field.name === ref.labelField)
  const values: Record<string, string> = {}
  for (const row of result.rows) {
    const key = row[keyIndex]
    const label = row[labelIndex]
    if (key === null || key === undefined || label === null || label === undefined) continue
    values[String(key)] = String(label)
  }
  const version = createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16)
  return { values, version }
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
 * Датасеты по именам таблиц сырого SQL: видимые пользователю, с его политиками.
 * Два доступных датасета с одним именем — неоднозначность, запрос не выполняется.
 */
async function sqlDatasets(ctx: Ctx, names: string[]): Promise<SqlDataset[]> {
  if (names.length === 0) return []
  const wanted = [...new Set(names.map((name) => name.toLowerCase()))]
  const candidates = await db()
    .select({ id: objects.id, title: objects.title })
    .from(objects)
    .where(
      and(
        eq(objects.type, 'dataset'),
        isNull(objects.deletedAt),
        inArray(sql`lower(${objects.title})`, wanted),
        visibleObjectsSql(ctx, 'dataset'),
      ),
    )
    .limit(50)
  const found: SqlDataset[] = []
  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    try {
      const { dataset } = await resolveDataset(ctx, candidate.id)
      found.push({ ...dataset, name: candidate.title })
      const key = candidate.title.toLowerCase()
      counts.set(key, (counts.get(key) ?? 0) + 1)
    } catch (error) {
      if (error instanceof AppError && (error.status === 403 || error.status === 404)) continue
      throw error
    }
  }
  for (const [name, count] of counts) {
    if (count > 1) {
      throw errors.validation(
        `Несколько доступных датасетов называются «${name}» — переименуйте один из них`,
      )
    }
  }
  return found
}

/** Ошибка Postgres при выполнении сырого SQL: понятное сообщение и позиция в тексте пользователя. */
function sqlExecutionError(compiled: CompiledRawSql, error: unknown): unknown {
  const code = pgErrorCode(error)
  if (!code) return error
  const raw = error as { message?: unknown; position?: unknown }
  const at = raw.position === undefined ? null : Number(raw.position)
  const position = at !== null && Number.isFinite(at) ? rawSqlErrorPosition(compiled, at) : null
  const known = PG_MESSAGES[code]
  const detail = typeof raw.message === 'string' ? raw.message : ''
  const message = known ?? (detail ? `Запрос не выполнен: ${detail}` : 'Запрос не выполнен')
  return new AppError('validation_failed', message, 400, {
    data: {
      issues: [
        {
          path: ['sql'],
          message,
          ...(position !== null ? { position } : {}),
          ...(known && detail ? { hint: detail } : {}),
        },
      ],
    },
  })
}

/**
 * Проверка фильтра политики строк так же, как при чтении: поля датасета (и
 * скрытые), макросы пользователя, без параметров запроса. Ошибка — 400 с
 * путём и сообщением компилятора.
 */
export async function checkRowPolicy(
  ctx: Ctx,
  storage: Pick<DatasetStorage, 'id' | 'table' | 'fields' | 'currentVersion'>,
  filter: FilterNode,
): Promise<void> {
  const spec = QuerySpec.parse({
    version: 1,
    source: { kind: 'dataset', id: storage.id },
    steps: [],
  })
  const dataset = resolvedFrom(storage, { kind: 'filter', where: filter }, { hide: [], mask: [] })
  const references = await referenceContext(ctx)
  try {
    compileQuery(spec, {
      datasets: new Map([[storage.id, dataset]]),
      user: compileUser(ctx),
      now: new Date(),
      maxRows: 1,
      ...references,
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
    /** Компиляция под колоночную копию: диалект DuckDB и поля, которые в ней есть. */
    columnar?: ReadonlyMap<string, ColumnarSource>,
  ): Promise<{ compiled: CompiledQuery; schemaVersions: string; cacheable: boolean }> {
    let sources = collectSources(spec)
    const saved = await loadSavedQueries(ctx, sources.queries)
    if (saved.size > 0) sources = collectSources(spec, saved)
    if (sources.sql) throw errors.validation('Сырой SQL выполняется в SQL-лаборатории')
    const resolved = await Promise.all(sources.datasets.map((id) => resolveDataset(ctx, id)))
    const datasets = new Map(
      resolved.map((item) => [
        item.dataset.id,
        columnar ? columnarDataset(item.dataset) : item.dataset,
      ]),
    )
    // Системные датасеты (задачи…) описывает модуль-владелец с правами смотрящего
    const systemDatasets = new Map(
      await Promise.all(
        sources.system.map(async (name) => {
          const definition = systemDataset(name)
          if (!definition) throw errors.validation(`Системный датасет «${name}» пока недоступен`)
          return [name, await definition.resolve(ctx)] as const
        }),
      ),
    )
    const lookups = new Map<string, ReferenceMap>()
    // Вторая попытка — с подписями справочников, о которых сообщил компилятор
    for (let attempt = 0; ; attempt += 1) {
      try {
        const compiled = compileQuery(spec, {
          datasets,
          systemDatasets,
          queries: saved,
          user: compileUser(ctx),
          params: options.params ?? {},
          now: new Date(),
          ...(ctx.kind === 'user' ? { timezone: ctx.timezone } : {}),
          ...(options.maxRows !== undefined ? { maxRows: options.maxRows } : {}),
          rowMeta: options.rowMeta ?? false,
          ...(options.geometryOutput ? { geometryOutput: options.geometryOutput } : {}),
          ...(options.spatialWindow ? { spatialWindow: options.spatialWindow } : {}),
          ...(columnar ? { dialect: duckdbDialect } : {}),
          ...(await referenceContext(ctx, lookups)),
        })
        // Подписи полей — из схемы, поэтому её версия тоже входит в ключ кэша
        const schemaVersions = resolved
          .map((item) => `${item.dataset.id}:${item.schemaVersion}`)
          .sort()
          .join(',')
        // У системных датасетов нет версии данных, а права меняются без неё — без кэша
        return { compiled, schemaVersions, cacheable: sources.system.length === 0 }
      } catch (error) {
        if (error instanceof MissingReferencesError && attempt === 0) {
          for (const request of error.requests) {
            if (request.kind !== 'lookup_label') continue
            lookups.set(referenceKey(request), await lookupReference(ctx, request))
          }
          continue
        }
        if (error instanceof QueryCompileError) throw compileError(error)
        throw error
      }
    }
  },

  /**
   * Выбор исполнителя (ADR-0109): годится ли колоночная копия и собирается ли
   * запрос в диалекте DuckDB. Не собрался — честно возвращаемся в Postgres:
   * ошибка спецификации всплывёт там же, с обычным сообщением компилятора.
   */
  async plan(
    ctx: Ctx,
    spec: QuerySpec,
    options: RunOptions = {},
  ): Promise<{
    compiled: CompiledQuery
    schemaVersions: string
    cacheable: boolean
    executor: QueryExecutor
    sources: ColumnarSource[]
  }> {
    const collected = collectSources(spec)
    const copies = await columnarSources(spec, collected, options).catch((error: unknown) => {
      logger().warn({ err: error }, 'колоночная копия не проверена')
      return null
    })
    if (copies) {
      try {
        const compiled = await QueryService.compile(ctx, spec, options, copies)
        // Геометрия в копии не хранится: ST_* означает, что диалект её пропустил
        if (!/\bST_/i.test(compiled.compiled.sql)) {
          return { ...compiled, executor: 'columnar', sources: [...copies.values()] }
        }
      } catch (error) {
        if (!(error instanceof UnsupportedByDialectError) && !(error instanceof AppError))
          throw error
      }
    }
    const compiled = await QueryService.compile(ctx, spec, options)
    return { ...compiled, executor: 'postgres', sources: [] }
  },

  async run(ctx: Ctx, spec: QuerySpec, options: RunOptions = {}): Promise<QueryResult> {
    const started = performance.now()
    const plan = await QueryService.plan(ctx, spec, options)
    const { compiled, schemaVersions, executor } = plan
    // `options.cache: false` (контракт QuerySpec) — мимо кэша: свежий результат и замеры
    const cacheable = plan.cacheable && spec.options?.cache !== false
    const count = options.count ?? false
    const specHash = createHash('sha256')
      .update(`${cacheKeyText(compiled.cacheKeyParts)}|${schemaVersions}|${count}|${executor}`)
      .digest('hex')
    const cacheKey = `kchs:query:${specHash}`

    const hit = cacheable ? await redis().get(cacheKey) : null
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

    const fields: QueryResultField[] = compiled.fields
    let rows: unknown[][]
    let total: number | null = null
    try {
      if (executor === 'columnar') {
        const reply = await ColumnarService.run(compiled, plan.sources, { count })
        rows = reply.rows
        total = reply.rowCount
      } else {
        const executed = await queryRoleSql().begin('read only', async (sql) => {
          await sql`SELECT set_config('statement_timeout', ${String(compiled.timeoutMs)}, true)`
          const data = await sql.unsafe(compiled.sql, compiled.params as never[])
          const counted = count
            ? await sql.unsafe(compiled.countSql, compiled.countParams as never[])
            : null
          return { data, counted }
        })
        const records = executed.data as unknown as Array<Record<string, unknown>>
        rows = records.map((row) => fields.map((field) => row[field.name]))
        total = executed.counted
          ? Number((executed.counted[0] as unknown as { count: unknown } | undefined)?.count ?? 0)
          : null
      }
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
    const result: QueryResult = {
      fields,
      rows: rows.map((row) => fields.map((field, index) => jsonValue(row[index], field.type))),
      rowCount: total,
      approx: false,
      truncated,
      durationMs: performance.now() - started,
      cached: false,
      executedOn: executor,
    }
    if (cacheable) await redis().set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS)
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
   * SQL-лаборатория (06-analytics-engine.md §6, ADR-0052): имена таблиц → датасеты
   * пользователя с политиками, компиляция `compileRawSql` (белые списки,
   * подзапросы-политики, параметры), выполнение под `kchs_query` в транзакции
   * только для чтения с тайм-аутом и поясом пользователя, кэш — если запрос
   * детерминированный. Нужна способность `data.sql`.
   */
  async runSql(ctx: Ctx, input: SqlRunInput): Promise<QueryResult> {
    requireCapability(ctx, 'data.sql')
    const started = performance.now()
    let compiled: CompiledRawSql
    try {
      const datasets = await sqlDatasets(ctx, await rawSqlTables(input.sql))
      compiled = await compileRawSql(input.sql, {
        datasets,
        user: compileUser(ctx),
        params: input.params,
        now: new Date(),
        ...(ctx.kind === 'user' ? { timezone: ctx.timezone } : {}),
        maxRows: SQL_MAX_ROWS,
        // Политики строк с «within» по территории — с дочерними, как в QuerySpec
        ...(await referenceContext(ctx)),
      })
    } catch (error) {
      if (error instanceof QueryCompileError) throw compileError(error)
      throw error
    }

    const specHash = createHash('sha256')
      .update(`sql|${cacheKeyText(compiled.cacheKeyParts)}`)
      .digest('hex')
    const cacheKey = `kchs:query:${specHash}`
    if (compiled.cacheable) {
      const hit = await redis().get(cacheKey)
      if (hit) {
        const result = { ...(JSON.parse(hit) as QueryResult), cached: true }
        const durationMs = performance.now() - started
        await recordRun(ctx, { specHash, durationMs, rowCount: result.rows.length, cached: true })
        return { ...result, durationMs }
      }
    }

    let data: unknown[][] & { columns?: Array<{ name: string; type: number }> }
    try {
      data = await queryRoleSql().begin('read only', async (sql) => {
        await sql`SELECT set_config('statement_timeout', ${String(compiled.timeoutMs)}, true),
                         set_config('TimeZone', ${compiled.timezone}, true)`
        return sql.unsafe(compiled.sql, compiled.params as never[]).values()
      })
    } catch (error) {
      await recordRun(ctx, {
        specHash,
        durationMs: performance.now() - started,
        rowCount: null,
        cached: false,
        error: error instanceof Error ? error.message : String(error),
      })
      if (pgErrorCode(error) === QUERY_CANCELED) throw errors.queryTimeout()
      throw sqlExecutionError(compiled, error)
    }

    // Поля: прямые ссылки на поля датасета — с подписью и форматом, остальное — по типу Postgres
    const fields: QueryResultField[] = (data.columns ?? []).map((column, index) => {
      const field = compiled.fields?.[index]?.field ?? null
      if (field) {
        // Геометрия без ST_AsGeoJSON приходит как EWKB — показывается текстом
        return field.type === 'geometry'
          ? { ...field, name: column.name, type: 'text' }
          : { ...field, name: column.name }
      }
      return {
        name: column.name,
        type: PG_TYPES[column.type] ?? 'text',
        semantic: null,
        label: null,
        format: null,
      }
    })
    let rows = data as unknown[][]
    const truncated = rows.length > SQL_MAX_ROWS
    if (truncated) rows = rows.slice(0, SQL_MAX_ROWS)
    const result: QueryResult = {
      fields,
      rows: rows.map((row) =>
        row.map((value, index) => jsonValue(value, fields[index]?.type ?? 'text')),
      ),
      rowCount: truncated ? null : rows.length,
      approx: false,
      truncated,
      durationMs: performance.now() - started,
      cached: false,
      executedOn: 'postgres',
    }
    if (compiled.cacheable) {
      await redis().set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS)
    }
    await recordRun(ctx, {
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
