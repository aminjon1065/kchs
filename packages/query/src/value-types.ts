import type { FieldSemantic, FieldType } from '@kchs/contracts'

/**
 * Типы значений языка выражений (contracts/query-spec.md: «числовые/строковые/
 * логические/дата/геометрия/массив»). `uuid` — ссылки на пользователя,
 * подразделение, территорию, объект; `text[]` — множественный выбор.
 */
export type ValueType =
  | 'number'
  | 'text'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'uuid'
  | 'geometry'
  | 'json'
  | 'text[]'
  | 'null'

const BY_FIELD_TYPE: Partial<Record<FieldType, ValueType>> = {
  text: 'text',
  long_text: 'text',
  select: 'text',
  url: 'text',
  email: 'text',
  phone: 'text',
  identifier: 'text',
  integer: 'number',
  number: 'number',
  decimal: 'number',
  money: 'number',
  percent: 'number',
  // Длительность в запросах — число минут (столбец interval читается как минуты)
  duration: 'number',
  boolean: 'boolean',
  date: 'date',
  datetime: 'datetime',
  time: 'time',
  user: 'uuid',
  unit: 'uuid',
  territory: 'uuid',
  object_ref: 'uuid',
  file: 'uuid',
  geometry: 'geometry',
  json: 'json',
  multi_select: 'text[]',
}

/** Тип значения поля; вычисляемые и служебные типы (formula, lookup…) не хранятся — undefined. */
export function valueTypeOfField(type: FieldType): ValueType | undefined {
  return BY_FIELD_TYPE[type]
}

/** SQL-тип для приведения значения поля (параметры сравниваются с полем в его точности). */
export function sqlTypeOfField(type: FieldType): string {
  switch (type) {
    case 'integer':
      return 'bigint'
    case 'decimal':
    case 'money':
      return 'numeric'
    case 'number':
    case 'percent':
    case 'duration':
      return 'double precision'
    default:
      return sqlTypeOfValue(valueTypeOfField(type) ?? 'text')
  }
}

export function sqlTypeOfValue(type: ValueType): string {
  switch (type) {
    case 'number':
      return 'double precision'
    case 'text':
      return 'text'
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'date'
    case 'datetime':
      return 'timestamptz'
    case 'time':
      return 'time'
    case 'uuid':
      return 'uuid'
    case 'geometry':
      return 'geometry'
    case 'json':
      return 'jsonb'
    case 'text[]':
      return 'text[]'
    case 'null':
      return 'text'
  }
}

/** Тип поля результата для типа значения (если поле не пришло из датасета напрямую). */
export function fieldTypeOfValue(type: ValueType): FieldType {
  switch (type) {
    case 'number':
      return 'number'
    case 'text':
    case 'null':
      return 'text'
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'date'
    case 'datetime':
      return 'datetime'
    case 'time':
      return 'time'
    case 'uuid':
      return 'identifier'
    case 'geometry':
      return 'geometry'
    case 'json':
      return 'json'
    case 'text[]':
      return 'multi_select'
  }
}

/** Семантика по умолчанию для вычисленного значения. */
export function semanticOfValue(type: ValueType): FieldSemantic {
  switch (type) {
    case 'number':
      return 'measure'
    case 'date':
    case 'datetime':
      return 'time'
    case 'geometry':
      return 'geometry'
    case 'uuid':
      return 'identifier'
    default:
      return 'dimension'
  }
}

export const VALUE_TYPE_LABELS: Record<ValueType, string> = {
  number: 'число',
  text: 'строка',
  boolean: 'логическое',
  date: 'дата',
  datetime: 'дата и время',
  time: 'время',
  uuid: 'ссылка',
  geometry: 'геометрия',
  json: 'JSON',
  'text[]': 'список',
  null: 'пусто',
}

/**
 * Общий тип двух значений для сравнения, `coalesce`, ветвей `if`/`case`.
 * null — если типы несовместимы. Неявные приведения — только безопасные:
 * пусто к любому типу, дата к дате-времени, строка-ссылка к ссылке.
 */
export function unify(a: ValueType, b: ValueType): ValueType | null {
  if (a === b) return a
  if (a === 'null') return b
  if (b === 'null') return a
  const pair = new Set([a, b])
  if (pair.has('date') && pair.has('datetime')) return 'datetime'
  if (pair.has('uuid') && pair.has('text')) return 'uuid'
  return null
}

/** Типы, которые можно упорядочивать (<, >, min, max, сортировка). */
export function isOrderable(type: ValueType): boolean {
  return ['number', 'text', 'date', 'datetime', 'time', 'uuid', 'null'].includes(type)
}
