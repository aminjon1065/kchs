import {
  type FilterCondition,
  FilterNode,
  isCondition,
  isGroup,
  isNot,
  type SortItem,
} from '@kchs/contracts'
import { dayRange, needsValue, operatorsFor, relativeRange } from '@kchs/fields'
import { type SQL, sql } from 'drizzle-orm'
import type { UserCtx } from '~/shared/context.js'
import { errors } from '~/shared/errors.js'
import { directory } from '../directory/port.js'
import type { ListFieldDef } from './list-fields.js'

/**
 * Фильтр списков объектов (contracts/field-types.md) → параметризованный SQL.
 * Имена полей — только из схемы типа (ListFieldDef), значения — параметры;
 * макросы (@me, @today, подчинённые) разрешаются до построения запроса.
 * Датасеты фильтрует компилятор packages/query с теми же операторами.
 */

const MAX_CONDITIONS = 50
const MAX_DEPTH = 6

interface Resolved {
  ctx: UserCtx
  subordinates: string[] | null
  now: Date
}

export function parseFilter(raw: string | undefined): FilterNode | null {
  if (!raw) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw errors.validation('Фильтр — некорректный JSON', [{ path: 'filter', message: 'json' }])
  }
  const parsed = FilterNode.safeParse(json)
  if (!parsed.success) {
    throw errors.validation('Некорректный фильтр', [
      { path: 'filter', message: parsed.error.issues[0]?.message ?? 'filter' },
    ])
  }
  return parsed.data
}

function countConditions(node: FilterNode, depth = 0): number {
  if (depth > MAX_DEPTH) throw errors.validation('Слишком глубокая вложенность фильтра')
  if (isCondition(node)) return 1
  if (isNot(node)) return countConditions(node.not, depth + 1)
  const children = 'and' in node ? node.and : node.or
  return children.reduce((sum, child) => sum + countConditions(child, depth + 1), 0)
}

function usesMacro(node: FilterNode, op: string): boolean {
  if (isCondition(node)) return node.op === op
  if (isNot(node)) return usesMacro(node.not, op)
  return ('and' in node ? node.and : node.or).some((child) => usesMacro(child, op))
}

export async function compileObjectFilter(
  node: FilterNode,
  fields: Map<string, ListFieldDef>,
  ctx: UserCtx,
): Promise<SQL> {
  if (countConditions(node) > MAX_CONDITIONS) {
    throw errors.validation(`В фильтре больше ${MAX_CONDITIONS} условий`)
  }
  const resolved: Resolved = {
    ctx,
    now: new Date(),
    subordinates: usesMacro(node, 'is_my_subordinate')
      ? await directory().subordinates(ctx.userId)
      : null,
  }
  return compileNode(node, fields, resolved)
}

function compileNode(node: FilterNode, fields: Map<string, ListFieldDef>, r: Resolved): SQL {
  if (isNot(node)) return sql`NOT (${compileNode(node.not, fields, r)})`
  if (isGroup(node)) {
    const children = ('and' in node ? node.and : node.or).map(
      (child) => sql`(${compileNode(child, fields, r)})`,
    )
    return sql.join(children, sql.raw('and' in node ? ' AND ' : ' OR '))
  }
  return compileCondition(node, fields, r)
}

function fail(condition: FilterCondition, message: string): never {
  throw errors.validation(message, [{ path: `filter.${condition.field}`, message: condition.op }])
}

function scalar(condition: FilterCondition, r: Resolved): unknown {
  const value = condition.value
  if (value === '@me') return r.ctx.userId
  if (value === '@today') return dayRange(r.now, r.ctx.timezone).from.toISOString()
  if (value === '@now') return r.now.toISOString()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return fail(condition, 'Ожидалось одно значение')
}

function list(condition: FilterCondition, r: Resolved): unknown[] {
  const value = condition.value
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    return fail(condition, 'Ожидался список значений')
  }
  return value.map((item) => (item === '@me' ? r.ctx.userId : item))
}

function pair(condition: FilterCondition): [unknown, unknown] {
  const value = condition.value
  if (!Array.isArray(value) || value.length !== 2) return fail(condition, 'Ожидались две границы')
  return [value[0], value[1]]
}

function asDate(condition: FilterCondition, value: unknown): Date {
  const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return fail(condition, 'Некорректная дата')
  return date
}

function textPattern(value: unknown, mode: 'contains' | 'starts' | 'ends'): string {
  // Спецсимволы LIKE экранируются: «50%» ищется буквально
  const escaped = String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`)
  return mode === 'contains' ? `%${escaped}%` : mode === 'starts' ? `${escaped}%` : `%${escaped}`
}

function compileCondition(
  condition: FilterCondition,
  fields: Map<string, ListFieldDef>,
  r: Resolved,
): SQL {
  const field = fields.get(condition.field)
  if (!field) return fail(condition, `Неизвестное поле «${condition.field}»`)
  if (!operatorsFor(field.type).includes(condition.op)) {
    return fail(condition, `Оператор ${condition.op} не применим к полю «${condition.field}»`)
  }
  if (needsValue(condition.op) && condition.value === undefined) {
    return fail(condition, 'Не указано значение условия')
  }

  const col = field.sql
  const isDate = field.type === 'date' || field.type === 'datetime'

  switch (condition.op) {
    case 'is_empty':
      return field.type === 'text' || field.type === 'long_text'
        ? sql`(${col} IS NULL OR ${col} = '')`
        : sql`${col} IS NULL`
    case 'not_empty':
      return field.type === 'text' || field.type === 'long_text'
        ? sql`(${col} IS NOT NULL AND ${col} <> '')`
        : sql`${col} IS NOT NULL`
    case 'is_true':
      return sql`${col} IS TRUE`
    case 'is_false':
      return sql`${col} IS NOT TRUE`
    case 'is_me':
      return sql`${col} = ${r.ctx.userId}`
    case 'is_my_subordinate': {
      const ids = r.subordinates ?? []
      return ids.length ? sql`${col} IN ${ids}` : sql`false`
    }
    case 'in_my_unit':
      // Пользователи подразделения — через порт справочника (фаза 1: users.unit_codes)
      return fail(condition, 'Оператор «в моём подразделении» для списков объектов пока недоступен')
    case 'contains':
      return sql`${col} ILIKE ${textPattern(scalar(condition, r), 'contains')}`
    case 'not_contains':
      return sql`(${col} IS NULL OR ${col} NOT ILIKE ${textPattern(scalar(condition, r), 'contains')})`
    case 'starts_with':
      return sql`${col} ILIKE ${textPattern(scalar(condition, r), 'starts')}`
    case 'ends_with':
      return sql`${col} ILIKE ${textPattern(scalar(condition, r), 'ends')}`
    case 'regex': {
      const pattern = String(scalar(condition, r))
      if (pattern.length > 200) return fail(condition, 'Слишком длинное регулярное выражение')
      return sql`${col} ~* ${pattern}`
    }
    case 'in':
      return sql`${col} IN ${list(condition, r)}`
    case 'not_in':
      return sql`(${col} IS NULL OR ${col} NOT IN ${list(condition, r)})`
    case 'eq': {
      if (isDate) {
        const day = dayRange(asDate(condition, scalar(condition, r)), r.ctx.timezone)
        return sql`(${col} >= ${day.from.toISOString()} AND ${col} < ${day.to.toISOString()})`
      }
      return sql`${col} = ${scalar(condition, r)}`
    }
    case 'neq':
      return sql`${col} IS DISTINCT FROM ${scalar(condition, r)}`
    case 'lt':
      return sql`${col} < ${scalar(condition, r)}`
    case 'lte':
      return sql`${col} <= ${scalar(condition, r)}`
    case 'gt':
      return sql`${col} > ${scalar(condition, r)}`
    case 'gte':
      return sql`${col} >= ${scalar(condition, r)}`
    case 'before':
      return sql`${col} < ${asDate(condition, scalar(condition, r)).toISOString()}`
    case 'after':
      return sql`${col} >= ${asDate(condition, scalar(condition, r)).toISOString()}`
    case 'between': {
      const [from, to] = pair(condition)
      if (isDate) {
        const end = dayRange(asDate(condition, to), r.ctx.timezone).to
        return sql`(${col} >= ${asDate(condition, from).toISOString()} AND ${col} < ${end.toISOString()})`
      }
      return sql`(${col} BETWEEN ${from} AND ${to})`
    }
    case 'relative': {
      const value = condition.value as { unit?: string; from?: number; to?: number } | undefined
      const unit = value?.unit
      if (
        !value ||
        !['day', 'week', 'month', 'quarter', 'year'].includes(unit ?? '') ||
        typeof value.from !== 'number' ||
        typeof value.to !== 'number'
      ) {
        return fail(condition, 'Некорректный относительный период')
      }
      const range = relativeRange(
        { unit: unit as 'day', from: value.from, to: value.to },
        r.now,
        r.ctx.timezone,
      )
      return sql`(${col} >= ${range.from.toISOString()} AND ${col} < ${range.to.toISOString()})`
    }
    default:
      return fail(condition, `Оператор ${condition.op} не поддерживается в списках объектов`)
  }
}

/** Сортировка только по сортируемым полям; порядок стабилен благодаря id. */
export function compileObjectSort(
  items: SortItem[],
  fields: Map<string, ListFieldDef>,
  idColumn: SQL,
): SQL[] {
  const clauses: SQL[] = []
  for (const item of items.slice(0, 3)) {
    const field = fields.get(item.field)
    if (!field?.sortable) {
      throw errors.validation(`Сортировка по полю «${item.field}» недоступна`, [
        { path: 'sort', message: item.field },
      ])
    }
    const direction = sql.raw(item.direction === 'desc' ? 'DESC' : 'ASC')
    const nulls = sql.raw(item.direction === 'desc' ? 'NULLS LAST' : 'NULLS FIRST')
    clauses.push(sql`${field.sql} ${direction} ${nulls}`)
  }
  clauses.push(sql`${idColumn} ASC`)
  return clauses
}
