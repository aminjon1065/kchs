import type { QueryResultField, QuerySpec, QueryStep } from '@kchs/contracts'
import { fail } from '../errors.js'
import type { CacheKeyParts, CompileContext, CompiledQuery } from '../types.js'
import { compilePipeline, normalizeSpec, orderClause, type Pipeline } from './pipeline.js'
import { type Column, columnSql, uniqueInternal } from './scope.js'
import { CompileState } from './state.js'

/** Предел строк интерактивного результата (06-analytics-engine.md §5). */
export const DEFAULT_MAX_ROWS = 50_000
/** Тайм-аут интерактивного запроса по умолчанию. */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Шаги, не меняющие число строк, — отбрасываются в конце спецификации для подсчёта. */
const COUNT_NEUTRAL = new Set<QueryStep['type']>(['sort', 'limit', 'select', 'compute', 'window'])

/**
 * QuerySpec → параметризованный SQL (Postgres). Каждый источник-датасет обёрнут
 * подзапросом с политиками пользователя; значения — только параметрами `$n`.
 * Ошибки — `QueryCompileError` с путём в спецификации и позицией в выражении.
 */
export function compileQuery(input: QuerySpec, ctx: CompileContext): CompiledQuery {
  const spec = normalizeSpec(input)
  const maxRows = ctx.maxRows === undefined ? DEFAULT_MAX_ROWS : ctx.maxRows
  if (maxRows !== null && (!Number.isInteger(maxRows) || maxRows < 0)) {
    throw new Error(`maxRows — неотрицательное целое, а передано: ${maxRows}`)
  }
  const state = new CompileState(ctx, spec)
  const pipeline = compilePipeline(state, spec, 'q', [])
  const { sql, fields } = finalSelect(state, pipeline, maxRows)
  const count = countQuery(ctx, spec)
  return {
    sql,
    params: state.binder.values,
    fields,
    countSql: count.sql,
    countParams: count.params,
    maxRows,
    timeoutMs: spec.options.timeoutMs ?? ctx.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    cacheKeyParts: cacheKey(state, spec, maxRows),
  }
}

function withClause(state: CompileState): string {
  return state.ctes.length ? `WITH\n${state.ctes.join(',\n')}\n` : ''
}

function finalSelect(
  state: CompileState,
  pipeline: Pipeline,
  maxRows: number | null,
): { sql: string; fields: QueryResultField[] } {
  const d = state.dialect
  const { relation } = pipeline
  const visible = relation.columns.filter((column) => !column.hidden)
  if (!visible.length) fail([], 'Запрос не возвращает ни одного поля')
  // Одинаковые имена после соединения различаются источником: «reg.name»
  const repeats = new Map<string, number>()
  for (const column of visible) repeats.set(column.name, (repeats.get(column.name) ?? 0) + 1)
  const used = new Set<string>()
  const out: Array<{ column: Column; name: string }> = []
  const push = (column: Column, preferred: string) => {
    const name = uniqueInternal(used, preferred)
    used.add(name)
    out.push({ column, name })
  }
  // Режим таблицы: `_id` и `_ver` строки — первыми (правка и блокировка строки)
  const meta =
    state.ctx.rowMeta && !pipeline.aggregated
      ? ['_id', '_ver']
          .map((name) => relation.columns.find((column) => column.system && column.name === name))
          .filter((column): column is Column => column !== undefined)
      : []
  for (const column of meta) push(column, column.name)
  for (const column of visible) {
    if (meta.includes(column)) continue
    const repeated = (repeats.get(column.name) ?? 0) > 1
    push(column, repeated && column.qualifier ? `${column.qualifier}.${column.name}` : column.name)
  }
  const select = out.map(({ column, name }) => {
    const sql = columnSql(d, relation, column)
    return `${column.type === 'geometry' ? d.geoJson(sql) : sql} AS ${d.ident(name)}`
  })
  const order = orderClause(state, relation, pipeline.ordering)
  const sql = [
    `${withClause(state)}SELECT ${select.join(', ')}`,
    `FROM ${d.ident(relation.name)}`,
    ...(order ? [order] : []),
    ...(maxRows !== null ? [`LIMIT ${maxRows + 1}`] : []),
  ].join('\n')
  const fields = out.map(({ column, name }) => ({
    name,
    type: column.meta.fieldType,
    semantic: column.meta.semantic,
    label: column.meta.label,
    format: column.meta.format,
  }))
  return { sql, fields }
}

/** Подсчёт строк: спецификация без завершающих сортировки, лимита и проекций. */
function countQuery(ctx: CompileContext, spec: QuerySpec): { sql: string; params: unknown[] } {
  let end = spec.steps.length
  while (end > 0 && COUNT_NEUTRAL.has((spec.steps[end - 1] as QueryStep).type)) end--
  const countSpec: QuerySpec = { ...spec, steps: spec.steps.slice(0, end) }
  const state = new CompileState(ctx, countSpec)
  const pipeline = compilePipeline(state, countSpec, 'q', [])
  const sql = `${withClause(state)}SELECT count(*) AS "count"\nFROM ${state.dialect.ident(pipeline.relation.name)}`
  return { sql, params: state.binder.values }
}

/** Части ключа кэша: спецификация, версии и политики источников, значения контекста. */
export function cacheKey(
  state: CompileState,
  spec: QuerySpec,
  maxRows: number | null,
): CacheKeyParts {
  const datasets = [...state.datasets.values()]
    .map((dataset) => ({
      id: dataset.id,
      version: dataset.version,
      policy: canonicalJson({
        row: dataset.rowPolicy,
        hide: [...dataset.columnPolicy.hide].sort(),
        mask: [...dataset.columnPolicy.mask].sort(),
      }),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  const queries = [...state.queries.entries()]
    .map(([id, query]) => ({ id, spec: canonicalJson(query) }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return {
    spec: canonicalJson(spec),
    datasets,
    queries,
    params: canonical(state.usedParams) as Record<string, unknown>,
    user: canonical(state.usedUser) as Record<string, unknown>,
    time: state.usesTime ? state.ctx.now.toISOString().slice(0, 16) : null,
    timezone: state.timezone,
    maxRows,
    rowMeta: state.ctx.rowMeta === true,
  }
}

/** Копия значения с ключами объектов по алфавиту — стабильный JSON для ключа кэша. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value instanceof Date) return value.toISOString()
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(entries.map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value))
}

/**
 * Строка ключа кэша результата: канонический JSON частей ключа. Вызывающий
 * хэширует её (sha256) и добавляет префикс; новая версия датасета, другая
 * политика или значение пользователя дают другой ключ.
 */
export function cacheKeyText(parts: CacheKeyParts): string {
  return canonicalJson(parts)
}
