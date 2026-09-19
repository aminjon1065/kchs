import type { FieldType, FilterCondition, FilterNode } from '@kchs/contracts'
import { all, any, type Condition, expr, get, isNull, not, num, present, str } from './expr.js'
import {
  addDays,
  type Day,
  dayOf,
  dayStart,
  dayUtc,
  formatDay,
  type Moment,
  parseMoment,
  type RelativeUnit,
  unitStart,
} from './time.js'

/**
 * FilterNode (contracts/field-types.md) → выражение MapLibre. Смысл операторов —
 * как у SQL-компилятора `packages/query`: `not` пропускает пустые значения,
 * `neq`/`not_in`/`not_contains` — тоже, `contains`/`starts_with`/`ends_with` —
 * без учёта регистра, `between` — концы включительно.
 *
 * Условия, которые на клиенте не посчитать (макросы пользователя, регулярные
 * выражения, геометрия, параметры), заменяются по полярности: `over` — «может
 * выполниться» (фильтр слоя: лишнего не скрыть, точный отбор сделал сервер),
 * `under` — «точно выполняется» (правило стиля не красит объект наугад).
 */

export type Polarity = 'over' | 'under'

type Kind = 'number' | 'text' | 'boolean' | 'date' | 'datetime' | 'list' | 'other'

export interface FilterContext {
  fieldType(key: string): FieldType | null
  territoryDescendants?: ((id: string) => readonly string[]) | undefined
  now?: number | undefined
  timezone: string
  unsupported(path: string, detail: string): void
}

const NUMBER_TYPES = new Set<FieldType>([
  'integer',
  'number',
  'decimal',
  'money',
  'percent',
  'duration',
  'rollup',
])
const TEXT_TYPES = new Set<FieldType>([
  'text',
  'long_text',
  'select',
  'url',
  'email',
  'phone',
  'identifier',
  'user',
  'unit',
  'territory',
  'object_ref',
  'time',
])

function kindOf(type: FieldType | null, value: unknown): Kind {
  if (type === null || type === 'formula' || type === 'lookup') {
    const sample = Array.isArray(value) ? value.find((v) => v !== null) : value
    if (typeof sample === 'number') return 'number'
    if (typeof sample === 'boolean') return 'boolean'
    return 'text'
  }
  if (NUMBER_TYPES.has(type)) return 'number'
  if (TEXT_TYPES.has(type)) return 'text'
  if (type === 'boolean') return 'boolean'
  if (type === 'date') return 'date'
  if (type === 'datetime') return 'datetime'
  if (type === 'multi_select') return 'list'
  return 'other'
}

const UNKNOWN = Symbol('unknown')
type Maybe<T> = T | typeof UNKNOWN

export function compileFilter(
  node: FilterNode,
  ctx: FilterContext,
  polarity: Polarity,
  path: string,
): Condition {
  if ('and' in node) {
    return all(node.and.map((child, i) => compileFilter(child, ctx, polarity, `${path}.and.${i}`)))
  }
  if ('or' in node) {
    return any(node.or.map((child, i) => compileFilter(child, ctx, polarity, `${path}.or.${i}`)))
  }
  if ('not' in node) {
    const inner = compileFilter(
      node.not,
      ctx,
      polarity === 'over' ? 'under' : 'over',
      `${path}.not`,
    )
    return not(inner)
  }
  const result = new ConditionCompiler(node, ctx, path).compile()
  return result === UNKNOWN ? polarity === 'over' : result
}

class ConditionCompiler {
  private readonly kind: Kind
  private readonly f: string

  constructor(
    private readonly cond: FilterCondition,
    private readonly ctx: FilterContext,
    private readonly path: string,
  ) {
    this.f = cond.field
    this.kind = kindOf(ctx.fieldType(cond.field), cond.value)
  }

  private unknown(detail: string): typeof UNKNOWN {
    this.ctx.unsupported(this.path, detail)
    return UNKNOWN
  }

  compile(): Maybe<Condition> {
    const { op } = this.cond
    if (this.kind === 'other') return this.unknown(`${op}: поле «${this.f}» не сравнить на карте`)
    switch (op) {
      case 'is_empty':
        return this.empty()
      case 'not_empty': {
        const empty = this.empty()
        return empty === UNKNOWN ? empty : not(empty)
      }
      case 'is_true':
        return expr('==', get(this.f), true)
      case 'is_false':
        return expr('==', get(this.f), false)
      default:
        break
    }
    if (this.kind === 'list') return this.unknown(`${op}: список значений не сравнить на карте`)
    const value = this.resolve(this.cond.value)
    if (value === UNKNOWN) return value
    switch (op) {
      case 'eq':
        return this.equals(value)
      case 'neq': {
        const eq = this.equals(value)
        return eq === UNKNOWN ? eq : not(eq)
      }
      case 'in':
        return this.oneOf(value)
      case 'not_in': {
        const inList = this.oneOf(value)
        return inList === UNKNOWN ? inList : not(inList)
      }
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
      case 'before':
      case 'after':
        return this.compare(op, value)
      case 'between':
        return this.between(value)
      case 'relative':
        return this.relative(value)
      case 'contains':
      case 'not_contains':
      case 'starts_with':
      case 'ends_with':
        return this.pattern(op, value)
      case 'within':
        return this.within(value)
      default:
        return this.unknown(`${op}: оператор не вычисляется на карте`)
    }
  }

  /** Макросы: `@today`/`@now` — по «сейчас» контекста, остальные на клиенте неизвестны. */
  private resolve(value: unknown): Maybe<unknown> {
    if (typeof value === 'string' && value.startsWith('@')) {
      if (value === '@today' && this.ctx.now !== undefined) {
        return formatDay(dayOf(this.ctx.now, this.ctx.timezone))
      }
      if (value === '@now' && this.ctx.now !== undefined) return this.ctx.now
      return this.unknown(`макрос ${value} вычисляет сервер`)
    }
    if (Array.isArray(value)) {
      const items: unknown[] = []
      for (const item of value) {
        const resolved = this.resolve(item)
        if (resolved === UNKNOWN) return resolved
        items.push(resolved)
      }
      return items
    }
    return value
  }

  private empty(): Maybe<Condition> {
    // Список (multi_select) в MVT не кодируется: пустой список приходит пустым полем
    if (this.kind === 'text') return any([isNull(this.f), expr('==', str(this.f), '')])
    return isNull(this.f)
  }

  private scalar(value: unknown): Maybe<string | number | boolean> {
    switch (this.kind) {
      case 'number': {
        const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
        if (typeof n === 'number' && Number.isFinite(n)) return n
        return this.unknown(`значение ${JSON.stringify(value)} — не число`)
      }
      case 'boolean':
        if (typeof value === 'boolean') return value
        if (value === 'true' || value === 'false') return value === 'true'
        return this.unknown(`значение ${JSON.stringify(value)} — не «да/нет»`)
      default:
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          return String(value)
        }
        return this.unknown(`значение ${JSON.stringify(value)} не сравнить`)
    }
  }

  private moment(value: unknown): Maybe<Moment> {
    const moment = parseMoment(value, this.ctx.timezone)
    return moment ?? this.unknown(`значение ${JSON.stringify(value)} — не дата`)
  }

  /** Границы дня или момента в миллисекундах так, как они лежат в тайле. */
  private span(moment: Moment): { start: number; end: number; exact: boolean } {
    if (moment.kind === 'instant') {
      if (this.kind === 'date') {
        const day = dayOf(moment.ms, this.ctx.timezone)
        return { start: dayUtc(day), end: dayUtc(day), exact: true }
      }
      return { start: moment.ms, end: moment.ms, exact: true }
    }
    if (this.kind === 'date') {
      return { start: dayUtc(moment.day), end: dayUtc(moment.day), exact: true }
    }
    return {
      start: dayStart(moment.day, this.ctx.timezone),
      end: dayStart(addDays(moment.day, 1), this.ctx.timezone),
      exact: false,
    }
  }

  private equals(value: unknown): Maybe<Condition> {
    if (value === null) return isNull(this.f)
    if (Array.isArray(value)) return this.oneOf(value)
    if (this.kind === 'date' || this.kind === 'datetime') {
      const moment = this.moment(value)
      if (moment === UNKNOWN) return moment
      const span = this.span(moment)
      const time = num(this.f)
      if (span.exact) return all([present(this.f), expr('==', time, span.start)])
      return all([present(this.f), expr('>=', time, span.start), expr('<', time, span.end)])
    }
    const scalar = this.scalar(value)
    if (scalar === UNKNOWN) return scalar
    if (this.kind === 'number') return all([present(this.f), expr('==', num(this.f), scalar)])
    if (this.kind === 'boolean') return expr('==', get(this.f), scalar)
    return scalar === ''
      ? all([present(this.f), expr('==', str(this.f), '')])
      : expr('==', str(this.f), scalar)
  }

  private oneOf(value: unknown): Maybe<Condition> {
    const items = Array.isArray(value) ? value : [value]
    const hasNull = items.some((item) => item === null)
    const values = items.filter((item) => item !== null)
    if (this.kind === 'date' || this.kind === 'datetime' || this.kind === 'boolean') {
      const parts: Condition[] = []
      for (const item of values) {
        const eq = this.equals(item)
        if (eq === UNKNOWN) return eq
        parts.push(eq)
      }
      return any([...(hasNull ? [isNull(this.f)] : []), ...parts])
    }
    const labels: Array<string | number> = []
    for (const item of values) {
      const scalar = this.scalar(item)
      if (scalar === UNKNOWN) return scalar
      if (!labels.includes(scalar as string | number)) labels.push(scalar as string | number)
    }
    let test: Condition = false
    if (labels.length > 0 && this.kind !== 'number') {
      test = expr('match', str(this.f), labels, true, false)
    } else if (labels.length > 0) {
      // Метки match — только целые числа; дробные сравниваются по одному
      const exact = labels.every((label) => Number.isInteger(label))
      test = all([
        present(this.f),
        exact
          ? expr('match', num(this.f), labels, true, false)
          : any(labels.map((label) => expr('==', num(this.f), label))),
      ])
    }
    return any([...(hasNull ? [isNull(this.f)] : []), test])
  }

  private compare(
    op: 'lt' | 'lte' | 'gt' | 'gte' | 'before' | 'after',
    value: unknown,
  ): Maybe<Condition> {
    if (value === null || Array.isArray(value)) return this.unknown(`${op}: нужно одно значение`)
    const symbol = { lt: '<', lte: '<=', gt: '>', gte: '>=', before: '<', after: '>' }[op]
    if (this.kind === 'date' || this.kind === 'datetime') {
      const moment = this.moment(value)
      if (moment === UNKNOWN) return moment
      const span = this.span(moment)
      const time = num(this.f)
      // Весь день: «до» — раньше его начала, «не позже» — раньше следующего дня
      const bound =
        symbol === '<'
          ? expr('<', time, span.start)
          : symbol === '<='
            ? span.exact
              ? expr('<=', time, span.end)
              : expr('<', time, span.end)
            : symbol === '>'
              ? span.exact
                ? expr('>', time, span.end)
                : expr('>=', time, span.end)
              : expr('>=', time, span.start)
      return all([present(this.f), bound])
    }
    const scalar = this.scalar(value)
    if (scalar === UNKNOWN) return scalar
    if (this.kind === 'boolean') return this.unknown(`${op}: «да/нет» не упорядочены`)
    const input = this.kind === 'number' ? num(this.f) : str(this.f)
    return all([present(this.f), expr(symbol, input, scalar)])
  }

  private between(value: unknown): Maybe<Condition> {
    let ends: [unknown, unknown]
    if (Array.isArray(value) && value.length === 2) ends = [value[0], value[1]]
    else if (value !== null && typeof value === 'object' && ('from' in value || 'to' in value)) {
      const range = value as { from?: unknown; to?: unknown }
      ends = [range.from ?? null, range.to ?? null]
    } else return this.unknown('between: нужна пара значений [от, до]')
    const parts: Condition[] = []
    const [from, to] = ends
    if (from !== null && from !== undefined) {
      const bound = this.compare('gte', from)
      if (bound === UNKNOWN) return bound
      parts.push(bound)
    }
    if (to !== null && to !== undefined) {
      const bound = this.compare('lte', to)
      if (bound === UNKNOWN) return bound
      parts.push(bound)
    }
    return all(parts)
  }

  /** Относительный период {unit, from, to}: от начала единицы `from` до конца `to`. */
  private relative(value: unknown): Maybe<Condition> {
    if (this.kind !== 'date' && this.kind !== 'datetime') {
      return this.unknown('relative: поле не дата')
    }
    if (this.ctx.now === undefined) return this.unknown('relative: нет «сейчас» в контексте')
    const range = value as { unit?: RelativeUnit; from?: number; to?: number } | null
    if (
      !range ||
      !['day', 'week', 'month', 'quarter', 'year'].includes(range.unit as string) ||
      !Number.isInteger(range.from) ||
      !Number.isInteger(range.to)
    ) {
      return this.unknown('relative: период задаётся как {unit, from, to}')
    }
    const today = dayOf(this.ctx.now, this.ctx.timezone)
    const unit = range.unit as RelativeUnit
    const lower = unitStart(today, unit, range.from as number)
    const upper = unitStart(today, unit, (range.to as number) + 1)
    const ms = (day: Day) => (this.kind === 'date' ? dayUtc(day) : dayStart(day, this.ctx.timezone))
    const time = num(this.f)
    return all([present(this.f), expr('>=', time, ms(lower)), expr('<', time, ms(upper))])
  }

  private pattern(
    op: 'contains' | 'not_contains' | 'starts_with' | 'ends_with',
    value: unknown,
  ): Maybe<Condition> {
    if (this.kind !== 'text') return this.unknown(`${op}: поле не текст`)
    if (typeof value !== 'string' && typeof value !== 'number') {
      return this.unknown(`${op}: нужна строка`)
    }
    const needle = String(value).toLowerCase()
    const hay = expr('downcase', str(this.f))
    let test: Condition
    if (op === 'starts_with') test = expr('==', expr('index-of', needle, hay), 0)
    else if (op === 'ends_with') {
      const start = expr('max', 0, expr('-', expr('length', hay), needle.length))
      test = expr('==', expr('slice', hay, start), needle)
    } else test = expr('in', needle, hay)
    const found = all([present(this.f), test])
    return op === 'not_contains' ? not(found) : found
  }

  /** Территория с дочерними: список идентификаторов из иерархии контекста. */
  private within(value: unknown): Maybe<Condition> {
    if (this.kind !== 'text') return this.unknown('within: геометрию сравнивает сервер')
    const items = Array.isArray(value) ? value : [value]
    const ids: string[] = []
    for (const item of items) {
      if (item === null) continue
      const id = typeof item === 'object' ? (item as { id?: unknown }).id : item
      const children =
        typeof item === 'object' ? (item as { includeChildren?: boolean }).includeChildren : true
      if (typeof id !== 'string') return this.unknown('within: нужен идентификатор территории')
      if (!ids.includes(id)) ids.push(id)
      if (children === false) continue
      if (!this.ctx.territoryDescendants) {
        return this.unknown('within: нет иерархии территорий в контексте')
      }
      for (const child of this.ctx.territoryDescendants(id)) {
        if (!ids.includes(child)) ids.push(child)
      }
    }
    if (ids.length === 0) return false
    return expr('match', str(this.f), ids, true, false)
  }
}
