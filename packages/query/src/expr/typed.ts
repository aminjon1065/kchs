import type { FieldType } from '@kchs/contracts'
import type { DateUnit, IntervalUnit } from '../dialect.js'
import { ExpressionError } from '../errors.js'
import type { LookupRef } from '../types.js'
import { VALUE_TYPE_LABELS, type ValueType } from '../value-types.js'

/** Типизированный узел выражения, словари функций и единиц, разбор значений параметров. */

export interface Typed {
  type: ValueType
  aggregate: boolean
  fieldType?: FieldType
  /** Ссылка поля на справочник — только у самого поля, не у выражений над ним. */
  lookup?: LookupRef
  pos: number
  end: number
  /** Строковый/числовой литерал: SQL зависит от целевого типа (дата, ссылка…). */
  literal?: { kind: 'string' | 'number' | 'boolean' | 'null'; value: unknown }
  /** Массив из параметра или макроса — допустим только в `in (…)`. */
  array?: { value: unknown[]; elementType: ValueType }
  emit(target?: ValueType): string
}

export const DATE_UNITS: readonly DateUnit[] = ['year', 'quarter', 'month', 'week', 'day', 'hour']

/** Типы, к которым приводит `cast(x, '…')` (ADR-0106). */
export const CAST_TARGETS = new Set(['text', 'number', 'boolean', 'date', 'datetime'])

export type CastTarget = 'text' | 'number' | 'boolean' | 'date' | 'datetime'

export const INTERVAL_UNITS: readonly IntervalUnit[] = [
  'year',
  'quarter',
  'month',
  'week',
  'day',
  'hour',
  'minute',
]

export const AGGREGATES = new Set([
  'count',
  'count_distinct',
  'sum',
  'avg',
  'min',
  'max',
  'median',
  'percentile',
  'string_agg',
])

export const WINDOW_FUNCTIONS = new Set([
  'lag',
  'lead',
  'rank',
  'dense_rank',
  'row_number',
  'running_sum',
  'moving_avg',
])

export function typeError(expected: string, got: Typed, hint?: string): never {
  throw new ExpressionError(
    `Ожидалось: ${expected}, а получено: ${VALUE_TYPE_LABELS[got.type]}`,
    got.pos,
    hint,
  )
}

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

export const ISO_TIME = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function inferType(value: unknown): ValueType {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'string') {
    if (UUID.test(value)) return 'uuid'
    return 'text'
  }
  if (value instanceof Date) return 'datetime'
  if (Array.isArray(value)) return 'text[]'
  return 'json'
}

/** Значение параметра для драйвера: даты — ISO-строкой, объекты — JSON. */
export function serialize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return JSON.stringify(value)
  return value
}
