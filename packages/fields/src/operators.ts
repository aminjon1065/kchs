import type { FieldType, FilterOperator } from '@kchs/contracts'

/** Операторы, допустимые для типа поля (contracts/field-types.md). */
const TEXT_OPS: FilterOperator[] = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'in',
  'not_in',
  'regex',
  'is_empty',
  'not_empty',
]
const NUMBER_OPS: FilterOperator[] = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
  'is_empty',
  'not_empty',
]
const DATE_OPS: FilterOperator[] = [
  'eq',
  'before',
  'after',
  'between',
  'relative',
  'is_empty',
  'not_empty',
]
const CHOICE_OPS: FilterOperator[] = ['in', 'not_in', 'eq', 'neq', 'is_empty', 'not_empty']
const BOOL_OPS: FilterOperator[] = ['is_true', 'is_false', 'is_empty']
const USER_OPS: FilterOperator[] = [
  'in',
  'not_in',
  'is_me',
  'is_my_subordinate',
  'in_my_unit',
  'is_empty',
  'not_empty',
]
const TERRITORY_OPS: FilterOperator[] = ['within', 'eq', 'in', 'is_empty', 'not_empty']
const GEOMETRY_OPS: FilterOperator[] = ['intersects', 'within', 'dwithin', 'is_empty']
const OBJECT_OPS: FilterOperator[] = ['in', 'not_in', 'is_empty', 'not_empty']

export const OPERATORS_BY_TYPE: Record<FieldType, FilterOperator[]> = {
  text: TEXT_OPS,
  long_text: TEXT_OPS,
  identifier: TEXT_OPS,
  url: TEXT_OPS,
  email: TEXT_OPS,
  phone: TEXT_OPS,
  integer: NUMBER_OPS,
  number: NUMBER_OPS,
  decimal: NUMBER_OPS,
  money: NUMBER_OPS,
  percent: NUMBER_OPS,
  duration: NUMBER_OPS,
  boolean: BOOL_OPS,
  date: DATE_OPS,
  datetime: DATE_OPS,
  time: DATE_OPS,
  select: CHOICE_OPS,
  multi_select: CHOICE_OPS,
  lookup: CHOICE_OPS,
  user: USER_OPS,
  unit: USER_OPS,
  territory: TERRITORY_OPS,
  object_ref: OBJECT_OPS,
  file: OBJECT_OPS,
  geometry: GEOMETRY_OPS,
  json: ['is_empty', 'not_empty'],
  formula: NUMBER_OPS,
  rollup: NUMBER_OPS,
  signature: ['is_empty', 'not_empty'],
}

export function operatorsFor(type: FieldType): FilterOperator[] {
  return OPERATORS_BY_TYPE[type] ?? TEXT_OPS
}

/** Операторы, не требующие значения. */
export const VALUELESS_OPERATORS = new Set<FilterOperator>([
  'is_empty',
  'not_empty',
  'is_true',
  'is_false',
  'is_me',
  'is_my_subordinate',
  'in_my_unit',
])

export function needsValue(op: FilterOperator): boolean {
  return !VALUELESS_OPERATORS.has(op)
}

/** Числовые типы — выравнивание вправо и табличные цифры в DataGrid. */
export const NUMERIC_TYPES = new Set<FieldType>([
  'integer',
  'number',
  'decimal',
  'money',
  'percent',
  'duration',
  'rollup',
])

export function isNumericType(type: FieldType): boolean {
  return NUMERIC_TYPES.has(type)
}
