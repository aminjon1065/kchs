import type { FieldType, QueryStep } from '@kchs/contracts'
import { fail, type IssuePath } from '../../errors.js'
import { sqlTypeOfValue, type ValueType } from '../../value-types.js'
import { type Column, type ColumnMeta, columnSql, type Relation } from '../scope.js'
import type { CompileState } from '../state.js'

/** Конвейер шагов QuerySpec: общие типы, пределы и помощники SQL. */

export interface Ordering {
  column: Column
  dir: 'asc' | 'desc'
  nulls?: 'first' | 'last'
}

/** Состояние конвейера шагов: текущее отношение, порядок строк, была ли сводка. */
export interface Pipeline {
  relation: Relation
  ordering: Ordering[]
  aggregated: boolean
}

export type Prefix = 'q' | 'j' | 'u'

export type Step<T extends QueryStep['type']> = Extract<QueryStep, { type: T }>

export const MAX_QUERY_DEPTH = 4

export const JOIN_KINDS: Record<string, string | undefined> = {
  inner: 'JOIN',
  left: 'LEFT JOIN',
  right: 'RIGHT JOIN',
  full: 'FULL JOIN',
}

export const PERCENTILES = { median: 0.5, p90: 0.9, p95: 0.95 } as const

export const NUMERIC_FIELD_TYPES = new Set<FieldType>([
  'number',
  'decimal',
  'money',
  'percent',
  'duration',
])

/** Приведение значения при соединении и объединении (дата → момент, строка → ссылка). */
export function convertSql(
  state: CompileState,
  sql: string,
  from: ValueType,
  to: ValueType,
): string {
  if (from === to) return sql
  if (from === 'null') return state.dialect.cast(sql, sqlTypeOfValue(to))
  if (from === 'date' && to === 'datetime') {
    return state.dialect.atTimeZone(state.dialect.cast(sql, 'timestamp'), state.tz())
  }
  if (from === 'text' && to === 'uuid') return state.dialect.tryCast(sql, 'uuid')
  return sql
}

export function intInRange(value: unknown, path: IssuePath, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return fail(path, `Нужно целое число от ${min} до ${max}`)
  }
  return value
}

export interface Argument {
  sql: string
  type: ValueType
  meta: ColumnMeta | null
}

export function mergeSets(
  a: ReadonlyMap<string, Set<string>>,
  b: ReadonlyMap<string, Set<string>>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const source of [a, b]) {
    for (const [key, names] of source) {
      result.set(key, new Set([...(result.get(key) ?? []), ...names]))
    }
  }
  return result
}

/** ORDER BY по порядку конвейера (пусто — без сортировки). */
export function orderClause(
  state: CompileState,
  relation: Relation,
  ordering: readonly Ordering[],
): string {
  if (!ordering.length) return ''
  const items = ordering.map(
    (item) =>
      `${columnSql(state.dialect, relation, item.column)} ${item.dir.toUpperCase()}${item.nulls ? ` NULLS ${item.nulls.toUpperCase()}` : ''}`,
  )
  return `ORDER BY ${items.join(', ')}`
}
