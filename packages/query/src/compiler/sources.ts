import type { FieldType } from '@kchs/contracts'
import { atPath, ExpressionError, fail, type IssuePath, QueryCompileError } from '../errors.js'
import { compileCondition, type ExprEnv } from '../expr/compile.js'
import type { ResolvedDataset, ResolvedField, SpatialWindow } from '../types.js'
import {
  fieldTypeOfValue,
  semanticOfValue,
  sqlTypeOfField,
  sqlTypeOfValue,
  type ValueType,
  valueTypeOfField,
} from '../value-types.js'
import { compileFilter, type FilterField, type FilterScope } from './filter.js'
import type { Column, Relation } from './scope.js'
import type { CompileState } from './state.js'

const PHYSICAL = /^[A-Za-z_][A-Za-z0-9_]*$/
const INLINE_KEY = /^[a-z_][a-z0-9_]*$/i
const MAX_INLINE_ROWS = 1000

/** Системные столбцы строк датасета, доступные в запросах (не в результате по умолчанию). */
export const SYSTEM_COLUMNS: ReadonlyArray<{
  name: string
  type: ValueType
  fieldType: FieldType
}> = [
  { name: '_id', type: 'number', fieldType: 'integer' },
  { name: '_ver', type: 'number', fieldType: 'integer' },
  { name: '_created_at', type: 'datetime', fieldType: 'datetime' },
  { name: '_updated_at', type: 'datetime', fieldType: 'datetime' },
  { name: '_created_by', type: 'uuid', fieldType: 'user' },
  { name: '_updated_by', type: 'uuid', fieldType: 'user' },
]

/** Перевод ошибки контекста (параметр, макрос) в ошибку выражения с позицией. */
export function guard<T>(pos: number, run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof QueryCompileError) {
      const issue = error.issues[0]
      throw new ExpressionError(issue?.message ?? error.message, pos, issue?.hint)
    }
    throw error
  }
}

/** Физический столбец поля; длительность (interval) читается как число минут. */
function physicalSql(state: CompileState, field: ResolvedField): string {
  if (!PHYSICAL.test(field.physical)) {
    throw new Error(`Недопустимое физическое имя столбца: ${field.physical}`)
  }
  const column = state.dialect.ident(field.physical)
  if (field.type === 'duration') return state.dialect.durationMinutes(column)
  return column
}

/**
 * Маскирование по типу поля (03-access-model.md: «***», последние 4 символа,
 * округление). Значение сохраняет тип, поэтому фильтры и сортировка работают
 * по маске, а не по исходным данным.
 */
function maskSql(state: CompileState, field: ResolvedField, sql: string): string {
  const d = state.dialect
  switch (field.type) {
    case 'identifier':
    case 'phone':
      return `(CASE WHEN ${sql} IS NULL THEN NULL WHEN ${d.charLength(sql)} >= 8 THEN '***' || right(${sql}, 4) ELSE '***' END)`
    case 'email':
      return `(CASE WHEN ${sql} IS NULL THEN NULL ELSE '***@' || split_part(${sql}, '@', 2) END)`
    case 'text':
    case 'long_text':
    case 'select':
    case 'url':
      return `(CASE WHEN ${sql} IS NULL THEN NULL ELSE '***' END)`
    case 'integer':
    case 'decimal':
    case 'money':
      return d.cast(
        `(CASE WHEN ${sql} IS NULL OR ${sql} = 0 THEN ${sql} ELSE ${d.roundSignificant(sql)} END)`,
        sqlTypeOfField(field.type),
      )
    case 'number':
    case 'percent':
    case 'duration':
      return d.cast(
        `(CASE WHEN ${sql} IS NULL OR ${sql} = 0 THEN ${sql} WHEN ${d.notFinite(sql)} THEN NULL ELSE ${d.roundSignificant(sql)} END)`,
        'double precision',
      )
    case 'date':
      return d.dateTrunc('year', sql, 'date', () => state.tz())
    case 'datetime':
      return d.dateTrunc('year', sql, 'datetime', () => state.tz())
    default:
      // Логическое, время, ссылки, геометрия, JSON, списки — значение не показывается
      return d.cast('NULL', sqlTypeOfField(field.type))
  }
}

/**
 * Источник-датасет: подзапрос с политиками пользователя (03-access-model.md
 * «Строки и столбцы датасетов»). Скрытые поля не выбираются, маскированные —
 * маскируются, строки ограничиваются политикой строк. Ограниченный политикой
 * подзапрос — барьер оптимизатора (`OFFSET 0`): условия пользователя не
 * опускаются ниже политики и не вычисляются на чужих строках.
 */
export function datasetSource(
  state: CompileState,
  dataset: ResolvedDataset,
  alias: string | null,
  name: string,
  path: IssuePath,
): Relation {
  const { body, columns, restricted, unavailable } = datasetRelation(state, dataset, alias, path)
  state.addCte(name, body)
  const qualifierKey = alias ?? ''
  return {
    name,
    columns,
    restricted: new Map(restricted.size ? [[qualifierKey, restricted]] : []),
    unavailable: new Map(unavailable.size ? [[qualifierKey, unavailable]] : []),
    qualifiers: new Set(alias ? [alias] : []),
  }
}

/**
 * Подзапрос датасета с политиками пользователя — один код для QuerySpec (CTE) и
 * сырого SQL (подзапрос на месте имени таблицы). `system` — какие системные
 * столбцы строк выбрать: все (QuerySpec) или только упомянутые в запросе.
 */
export function datasetRelation(
  state: CompileState,
  dataset: ResolvedDataset,
  alias: string | null,
  path: IssuePath,
  system: 'all' | ReadonlySet<string> = 'all',
): { body: string; columns: Column[]; restricted: Set<string>; unavailable: Set<string> } {
  state.datasets.set(dataset.id, dataset)
  const d = state.dialect
  const hidden = new Set(dataset.columnPolicy.hide)
  const masked = new Set(dataset.columnPolicy.mask)
  const restricted = new Set<string>()
  const unavailable = new Set<string>()
  const select: string[] = []
  const columns: Column[] = []
  const keys = new Set(dataset.fields.map((field) => field.key))

  const hasSystem = dataset.systemColumns !== false
  if (hasSystem) {
    for (const column of SYSTEM_COLUMNS) {
      if (keys.has(column.name)) continue
      if (system !== 'all' && !system.has(column.name)) continue
      select.push(d.ident(column.name))
      columns.push({
        name: column.name,
        qualifier: alias,
        internal: column.name,
        type: column.type,
        meta: { fieldType: column.fieldType, semantic: 'system', label: null, format: null },
        hidden: true,
        system: true,
      })
    }
  }

  for (const field of dataset.fields) {
    const type = valueTypeOfField(field.type)
    if (hidden.has(field.key)) {
      restricted.add(field.key)
      continue
    }
    if (!type) {
      unavailable.add(field.key)
      continue
    }
    const physical = physicalSql(state, field)
    const value = masked.has(field.key) ? maskSql(state, field, physical) : physical
    select.push(`${value} AS ${d.ident(field.key)}`)
    columns.push({
      name: field.key,
      qualifier: alias,
      internal: field.key,
      type,
      meta: {
        fieldType: field.type,
        semantic: field.semantic ?? semanticOfValue(type),
        label: field.label ?? null,
        format: field.format ?? null,
        ...(field.lookup ? { lookup: field.lookup } : {}),
      },
      hidden: false,
    })
  }

  const where: string[] = []
  if (hasSystem) where.push(`${d.ident('_deleted_at')} IS NULL`)
  const policy = rowPolicySql(state, dataset, [...path, 'policy'])
  if (policy !== null) where.push(policy)
  const window = state.ctx.spatialWindow
  if (window && window.datasetId === dataset.id) {
    where.push(spatialWindowSql(state, dataset, window, [...path, 'spatialWindow']))
  }
  const fenced = dataset.rowPolicy.kind === 'filter' || dataset.rowPolicy.kind === 'expr'
  const fence = fenced ? d.fence() : null
  const body = [
    `SELECT ${select.length ? select.join(', ') : 'NULL AS "_empty"'}`,
    `FROM ${d.table(dataset.table)}`,
    ...(where.length ? [`WHERE ${where.join(' AND ')}`] : []),
    ...(fence ? [fence] : []),
  ].join('\n')
  return { body, columns, restricted, unavailable }
}

/**
 * Пространственное окно вызывающего (ADR-0064): рамка на физическом столбце
 * геометрии рядом с политикой строк — индекс GIST работает и под политикой.
 * Маскированная геометрия не видна пользователю — в окно не попадает ничего.
 */
function spatialWindowSql(
  state: CompileState,
  dataset: ResolvedDataset,
  window: SpatialWindow,
  path: IssuePath,
): string {
  const field = dataset.fields.find((item) => item.key === window.field)
  if (field?.type !== 'geometry' || dataset.columnPolicy.hide.includes(window.field)) {
    fail(path, `Пространственное окно: нет видимого поля геометрии «${window.field}»`)
  }
  const [west, south, east, north] = window.bbox
  if (![west, south, east, north].every(Number.isFinite) || west > east || south > north) {
    fail(path, 'Пространственное окно: ожидается рамка «запад, юг, восток, север»')
  }
  if (dataset.columnPolicy.mask.includes(window.field)) return 'FALSE'
  const box = [west, south, east, north].map((value) => state.binder.add(value, 'float8'))
  return `${physicalSql(state, field)} && ST_MakeEnvelope(${box.join(', ')}, 4326)`
}

/** Условие политики строк над физическими столбцами (скрытые поля в политике доступны). */
function rowPolicySql(
  state: CompileState,
  dataset: ResolvedDataset,
  path: IssuePath,
): string | null {
  const policy = dataset.rowPolicy
  if (policy.kind === 'all') return null
  if (policy.kind === 'none') return 'FALSE'
  const fields = new Map<string, FilterField>()
  if (dataset.systemColumns !== false) {
    for (const column of SYSTEM_COLUMNS) {
      fields.set(column.name, {
        sql: state.dialect.ident(column.name),
        type: column.type,
        fieldType: column.fieldType,
      })
    }
  }
  for (const field of dataset.fields) {
    const type = valueTypeOfField(field.type)
    if (!type) continue
    fields.set(field.key, { sql: physicalSql(state, field), type, fieldType: field.type })
  }
  if (policy.kind === 'filter') {
    const scope: FilterScope = {
      policy: true,
      field(ref, fieldPath) {
        const found = fields.get(ref)
        if (!found) fail(fieldPath, `В политике строк нет поля «${ref}»`)
        return found
      },
    }
    // Условие без ограничения в политике невозможно (параметров нет) — на всякий случай закрыто
    return compileFilter(state, policy.where, scope, [...path, 'where']) ?? 'FALSE'
  }
  const env: ExprEnv = {
    dialect: state.dialect,
    binder: state.binder,
    mode: 'row',
    resolveField(qualifier, name, pos) {
      const found = qualifier === null ? fields.get(name) : undefined
      if (!found)
        throw new ExpressionError(
          `В политике строк нет поля «${qualifier ? `${qualifier}.` : ''}${name}»`,
          pos,
        )
      return {
        sql: found.sql,
        type: found.type,
        ...(found.fieldType ? { fieldType: found.fieldType } : {}),
      }
    },
    resolveParam(_name, pos) {
      throw new ExpressionError('В политике строк параметры запроса недоступны', pos)
    },
    resolveMacro: (macro, pos) => guard(pos, () => state.macroExpr(macro, path)),
    userAttr: (key) => userAttrValue(state, key),
    reference: (request) => state.reference(request),
    timezone: () => state.tz(),
    now: () => state.now(),
  }
  return `(${atPath([...path, 'expr'], () => compileCondition(policy.expr, env)).sql})`
}

/** Атрибут пользователя для `user_attr()`: тип выводится по значению. */
export function userAttrValue(state: CompileState, key: string) {
  const value = state.userAttribute(key)
  return { value: value ?? null, type: null, ...(Array.isArray(value) ? { array: true } : {}) }
}

type InlineType = Exclude<ValueType, 'uuid' | 'date' | 'datetime' | 'time' | 'geometry'>

/** Небольшие константы: VALUES с параметрами, типы столбцов — по значениям. */
export function inlineSource(
  state: CompileState,
  rows: ReadonlyArray<Record<string, unknown>>,
  alias: string | null,
  name: string,
  path: IssuePath,
): Relation {
  if (!rows.length) fail([...path, 'rows'], 'Во встроенном источнике нет строк')
  if (rows.length > MAX_INLINE_ROWS) {
    fail([...path, 'rows'], `Во встроенном источнике больше ${MAX_INLINE_ROWS} строк`)
  }
  const keys: string[] = []
  for (const [index, row] of rows.entries()) {
    for (const key of Object.keys(row)) {
      if (!INLINE_KEY.test(key) || key.length > 64) {
        fail([...path, 'rows', index, key], `Недопустимое имя столбца «${key}»`, {
          hint: 'Латиница, цифры и подчёркивание',
        })
      }
      if (!keys.includes(key)) keys.push(key)
    }
  }
  const types = keys.map((key) => {
    let type: InlineType = 'null'
    for (const [index, row] of rows.entries()) {
      const value = row[key]
      const valueType = inlineType(value)
      if (!valueType) {
        fail(
          [...path, 'rows', index, key],
          'Значение встроенного источника: число, строка, логическое, список строк или объект',
        )
      }
      if (valueType === 'null' || valueType === type) continue
      if (type !== 'null') {
        fail([...path, 'rows', index, key], `В столбце «${key}» значения разных типов`)
      }
      type = valueType
    }
    return type
  })
  const d = state.dialect
  const values = rows.map((row) => {
    const cells = keys.map((key, index) => {
      const type = types[index] as InlineType
      const value = row[key] ?? null
      const sqlType = sqlTypeOfValue(type)
      if (value === null) return `NULL::${sqlType}`
      // JSON — строкой с приведением: драйвер не сериализует значение повторно
      if (type === 'json') return `${state.binder.add(JSON.stringify(value), 'text')}::jsonb`
      return state.binder.add(value, sqlType)
    })
    return `(${cells.join(', ')})`
  })
  const columnList = keys.map((key) => d.ident(key)).join(', ')
  state.addCte(
    name,
    `SELECT ${columnList}\nFROM (VALUES ${values.join(', ')}) AS ${d.ident('v')}(${columnList})`,
  )
  return {
    name,
    columns: keys.map((key, index) => {
      const type = types[index] as InlineType
      return {
        name: key,
        qualifier: alias,
        internal: key,
        type,
        meta: {
          fieldType: fieldTypeOfValue(type),
          semantic: semanticOfValue(type),
          label: null,
          format: null,
        },
        hidden: false,
      }
    }),
    restricted: new Map(),
    unavailable: new Map(),
    qualifiers: new Set(alias ? [alias] : []),
  }
}

function inlineType(value: unknown): InlineType | null {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : null
  if (typeof value === 'string') return 'text'
  if (typeof value === 'boolean') return 'boolean'
  if (Array.isArray(value)) return value.every((item) => typeof item === 'string') ? 'text[]' : null
  if (typeof value === 'object') return 'json'
  return null
}
