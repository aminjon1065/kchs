import type { FieldType, FilterCondition, FilterNode, FilterOperator } from '@kchs/contracts'
import { fail, type IssuePath } from '../errors.js'
import { addDays, localDateOf, validDate } from '../time.js'
import { sqlTypeOfValue, VALUE_TYPE_LABELS, type ValueType } from '../value-types.js'
import { type CompileState, MISSING } from './state.js'

/** Поле, к которому применяется условие: SQL-выражение, тип значения, тип поля. */
export interface FilterField {
  sql: string
  type: ValueType
  fieldType: FieldType | null
}

export interface FilterScope {
  field(ref: string, path: IssuePath): FilterField
  /** Фильтр политики строк: параметры запроса в нём недоступны. */
  policy?: boolean
}

const TEXT_OPS: readonly FilterOperator[] = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'regex',
  'in',
  'not_in',
  'is_empty',
  'not_empty',
]
const ORDER_OPS: readonly FilterOperator[] = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between']

/** Операторы по типу значения (contracts/field-types.md «Операторы по типам», с запасом). */
const OPS: Record<Exclude<ValueType, 'null'>, readonly FilterOperator[]> = {
  text: TEXT_OPS,
  number: [...ORDER_OPS, 'in', 'not_in', 'is_empty', 'not_empty'],
  date: [...ORDER_OPS, 'before', 'after', 'relative', 'in', 'not_in', 'is_empty', 'not_empty'],
  datetime: [...ORDER_OPS, 'before', 'after', 'relative', 'is_empty', 'not_empty'],
  time: [...ORDER_OPS, 'before', 'after', 'in', 'not_in', 'is_empty', 'not_empty'],
  boolean: ['eq', 'neq', 'is_true', 'is_false', 'is_empty', 'not_empty'],
  uuid: [
    'eq',
    'neq',
    'in',
    'not_in',
    'is_empty',
    'not_empty',
    'is_me',
    'is_my_subordinate',
    'in_my_unit',
    'within',
  ],
  geometry: ['intersects', 'within', 'dwithin', 'is_empty', 'not_empty'],
  json: ['eq', 'neq', 'is_empty', 'not_empty'],
  'text[]': ['eq', 'neq', 'contains', 'not_contains', 'in', 'not_in', 'is_empty', 'not_empty'],
}

const NO_VALUE = new Set<FilterOperator>([
  'is_empty',
  'not_empty',
  'is_true',
  'is_false',
  'is_me',
  'is_my_subordinate',
  'in_my_unit',
])

const MACRO = /^@(me|my_unit|my_units|my_territories|today|now|param:([a-zA-Z0-9_]+))$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_DATETIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/
const ISO_TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NUMERIC = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i
const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
])
const RELATIVE_UNITS = ['day', 'week', 'month', 'quarter', 'year'] as const
const MAX_REGEX = 500

/**
 * Общий фильтр → SQL-условие. null — условие не накладывается (все его части
 * зависят от незаданных необязательных параметров).
 */
export function compileFilter(
  state: CompileState,
  node: FilterNode,
  scope: FilterScope,
  path: IssuePath,
): string | null {
  if ('and' in node) {
    const parts = node.and
      .map((child, index) => compileFilter(state, child, scope, [...path, 'and', index]))
      .filter((part): part is string => part !== null)
    if (!parts.length) return null
    return parts.length === 1 ? (parts[0] as string) : `(${parts.join(' AND ')})`
  }
  if ('or' in node) {
    const mark = state.binder.mark()
    const parts = node.or.map((child, index) =>
      compileFilter(state, child, scope, [...path, 'or', index]),
    )
    // Ветка без ограничения делает всё «или» без ограничения; параметры
    // остальных веток снимаются вместе с отброшенным условием
    if (parts.some((part) => part === null)) {
      state.binder.rollback(mark)
      return null
    }
    return parts.length === 1 ? (parts[0] as string) : `(${parts.join(' OR ')})`
  }
  if ('not' in node) {
    const inner = compileFilter(state, node.not, scope, [...path, 'not'])
    // «Не выполняется»: строки с пустым значением условия тоже попадают
    return inner === null ? null : `((${inner}) IS NOT TRUE)`
  }
  return new ConditionCompiler(state, node, scope, path).compile()
}

type Resolved = { value: unknown; macro: boolean } | typeof MISSING

type Moment = { kind: 'day'; date: string } | { kind: 'instant'; text: string; local: boolean }

class ConditionCompiler {
  private readonly field: FilterField
  private readonly type: Exclude<ValueType, 'null'>
  private readonly valuePath: IssuePath

  constructor(
    private readonly state: CompileState,
    private readonly cond: FilterCondition,
    private readonly scope: FilterScope,
    private readonly path: IssuePath,
  ) {
    this.field = scope.field(cond.field, [...path, 'field'])
    this.type = this.field.type === 'null' ? 'text' : this.field.type
    this.valuePath = [...path, 'value']
  }

  private get f(): string {
    return this.field.sql
  }

  private get tz(): string {
    return this.state.tz()
  }

  compile(): string | null {
    const { op } = this.cond
    const allowed = OPS[this.type]
    if (!allowed.includes(op)) {
      fail(
        [...this.path, 'op'],
        `Оператор «${op}» не применим к полю «${this.cond.field}» (${VALUE_TYPE_LABELS[this.type]})`,
        { hint: `Допустимо: ${allowed.join(', ')}` },
      )
    }
    if (NO_VALUE.has(op)) return this.withoutValue(op)
    if (this.cond.value === undefined) fail(this.valuePath, `Для оператора «${op}» нужно значение`)
    switch (op) {
      case 'between':
        return this.between()
      case 'relative':
        return this.relative()
      default:
        break
    }
    const resolved = this.resolve(this.cond.value, this.valuePath)
    if (resolved === MISSING) return null
    switch (op) {
      case 'eq':
      case 'neq':
        return this.equality(op, resolved)
      case 'in':
      case 'not_in':
        return this.inList(op === 'not_in', resolved.value)
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
      case 'before':
      case 'after':
        return this.compare(op, resolved.value)
      case 'contains':
      case 'not_contains':
      case 'starts_with':
      case 'ends_with':
        return this.pattern(op, resolved.value)
      case 'regex':
        return this.regex(resolved.value)
      case 'within':
        return this.within(resolved.value)
      case 'intersects':
        return `ST_Intersects(${this.f}, ${this.geometry(resolved.value, this.valuePath)})`
      case 'dwithin':
        return this.dwithin(resolved.value)
      default:
        return fail([...this.path, 'op'], `Неизвестный оператор «${op}»`)
    }
  }

  // ─── Значения ──────────────────────────────────────────────────────────────

  /** Подстановка макросов и параметров; списки разворачиваются. */
  private resolve(raw: unknown, path: IssuePath): Resolved {
    if (typeof raw === 'string') {
      const match = MACRO.exec(raw)
      if (!match) return { value: raw, macro: false }
      const param = match[2]
      if (param !== undefined) {
        if (this.scope.policy) fail(path, 'В политике строк параметры запроса недоступны')
        const value = this.state.paramValue(param, path)
        return value === MISSING ? MISSING : { value, macro: true }
      }
      return { value: this.state.macroValue(match[1] as string, path), macro: true }
    }
    if (Array.isArray(raw)) {
      const items: unknown[] = []
      let macro = false
      let missing = 0
      raw.forEach((item, index) => {
        const resolved = this.resolve(item, [...path, index])
        if (resolved === MISSING) {
          missing++
          return
        }
        macro ||= resolved.macro
        if (Array.isArray(resolved.value)) items.push(...resolved.value)
        // Макрос без значения (@my_unit без подразделения) ничему не равен — не «пусто»
        else if (!(resolved.macro && resolved.value === null)) items.push(resolved.value)
      })
      if (raw.length > 0 && missing === raw.length) return MISSING
      return { value: items, macro }
    }
    return { value: raw, macro: false }
  }

  private param(value: unknown, cast: string): string {
    return this.state.binder.add(value, cast)
  }

  /** SQL-тип параметра: точность числового поля, иначе тип значения. */
  private castFor(values: readonly unknown[]): string {
    if (this.type === 'number') {
      switch (this.field.fieldType) {
        case 'integer':
          return values.every((value) => Number.isInteger(value)) ? 'bigint' : 'numeric'
        case 'decimal':
        case 'money':
          return 'numeric'
        default:
          return 'double precision'
      }
    }
    if (this.type === 'text[]') return 'text'
    return sqlTypeOfValue(this.type)
  }

  /** Скалярное значение в типе поля (кроме даты-времени — см. moment). */
  private scalar(value: unknown, path: IssuePath): unknown {
    switch (this.type) {
      case 'number': {
        if (typeof value === 'number' && Number.isFinite(value)) return value
        if (typeof value === 'string' && NUMERIC.test(value.trim())) return Number(value.trim())
        return fail(path, `Ожидалось число, а получено: ${show(value)}`)
      }
      case 'boolean':
        if (typeof value === 'boolean') return value
        if (value === 'true' || value === 'false') return value === 'true'
        return fail(path, `Ожидалось «да» или «нет», а получено: ${show(value)}`)
      case 'date':
        return this.date(value, path)
      case 'time': {
        const match = typeof value === 'string' ? ISO_TIME.exec(value) : null
        if (
          !match ||
          Number(match[1]) > 23 ||
          Number(match[2]) > 59 ||
          Number(match[3] ?? 0) > 59
        ) {
          return fail(path, `Ожидалось время ЧЧ:ММ, а получено: ${show(value)}`)
        }
        return value
      }
      case 'uuid':
        if (typeof value === 'string' && UUID.test(value)) return value
        return fail(path, `Ожидался идентификатор, а получено: ${show(value)}`)
      case 'json':
        return JSON.stringify(value)
      case 'text':
      case 'text[]':
        if (typeof value === 'string') return value
        if (typeof value === 'number' || typeof value === 'boolean') return String(value)
        return fail(path, `Ожидалась строка, а получено: ${show(value)}`)
      default:
        return fail(path, `Значение не подходит к полю типа «${VALUE_TYPE_LABELS[this.type]}»`)
    }
  }

  /** Дата (ГГГГ-ММ-ДД); момент времени — его дата в поясе запроса. */
  private date(value: unknown, path: IssuePath): string {
    if (typeof value === 'string') {
      if (ISO_DATE.test(value)) {
        if (!validDate(value)) fail(path, `Нет такой даты: ${value}`)
        return value
      }
      const match = ISO_DATETIME.exec(value)
      if (match) {
        const day = match[1] as string
        if (!validDate(day)) fail(path, `Нет такой даты: ${value}`)
        return match[5] ? localDateOf(new Date(value), this.state.timezone) : day
      }
    }
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return localDateOf(value, this.state.timezone)
    }
    return fail(path, `Ожидалась дата ГГГГ-ММ-ДД, а получено: ${show(value)}`)
  }

  /** Значение для поля «дата и время»: целый день (в поясе запроса) или момент. */
  private moment(value: unknown, path: IssuePath): Moment {
    if (typeof value === 'string') {
      if (ISO_DATE.test(value)) {
        if (!validDate(value)) fail(path, `Нет такой даты: ${value}`)
        return { kind: 'day', date: value }
      }
      const match = ISO_DATETIME.exec(value)
      if (match) {
        if (!validDate(match[1] as string) || Number(match[2]) > 23 || Number(match[3]) > 59) {
          fail(path, `Нет такого момента: ${value}`)
        }
        return { kind: 'instant', text: value, local: !match[5] }
      }
    }
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return { kind: 'instant', text: value.toISOString(), local: false }
    }
    return fail(path, `Ожидалась дата или дата и время, а получено: ${show(value)}`)
  }

  private instant(moment: Extract<Moment, { kind: 'instant' }>): string {
    // Время без пояса — местное время пояса запроса
    return moment.local
      ? this.state.dialect.atTimeZone(this.param(moment.text, 'timestamp'), this.tz)
      : this.param(moment.text, 'timestamptz')
  }

  /** Начало дня `date` в поясе запроса (момент). */
  private dayStart(date: string): string {
    return this.state.dialect.atTimeZone(this.param(date, 'timestamp'), this.tz)
  }

  private nextDayStart(date: string): string {
    return this.dayStart(addDays(date, 1))
  }

  // ─── Операторы ─────────────────────────────────────────────────────────────

  private withoutValue(op: FilterOperator): string {
    const f = this.f
    const d = this.state.dialect
    switch (op) {
      case 'is_empty':
        if (this.type === 'text') return `(${f} IS NULL OR ${f} = '')`
        if (this.type === 'text[]') return `(${f} IS NULL OR ${d.cardinality(f)} = 0)`
        if (this.type === 'geometry') return `(${f} IS NULL OR ST_IsEmpty(${f}))`
        return `(${f} IS NULL)`
      case 'not_empty':
        if (this.type === 'text') return `(${f} IS NOT NULL AND ${f} <> '')`
        if (this.type === 'text[]') return `(${d.cardinality(f)} > 0)`
        if (this.type === 'geometry') return `(${f} IS NOT NULL AND NOT ST_IsEmpty(${f}))`
        return `(${f} IS NOT NULL)`
      case 'is_true':
        return `(${f} IS TRUE)`
      case 'is_false':
        return `(${f} IS FALSE)`
      case 'is_me':
        return `(${f} = ${this.state.binder.once('me', this.state.userId(), 'uuid')})`
      case 'is_my_subordinate':
        return this.anyOf(this.state.subordinateIds(), 'subordinates')
      case 'in_my_unit': {
        if (this.field.fieldType === 'unit') return this.anyOf(this.state.unitIds(), 'units')
        if (this.field.fieldType === 'user') {
          return this.anyOf(this.state.unitMemberIds([...this.path, 'op']), 'unit_members')
        }
        return fail(
          [...this.path, 'op'],
          `Оператор «in_my_unit» применим к полю-пользователю или подразделению, а «${this.cond.field}» — не такое`,
        )
      }
      default:
        return fail([...this.path, 'op'], `Неизвестный оператор «${op}»`)
    }
  }

  /** Поле входит в список идентификаторов контекста (общий параметр запроса). */
  private anyOf(ids: readonly string[], key: string): string {
    if (!ids.length) return 'FALSE'
    return `(${this.state.dialect.inArray(this.f, this.state.binder.once(key, [...ids], 'uuid[]'))})`
  }

  private equality(op: 'eq' | 'neq', resolved: { value: unknown; macro: boolean }): string {
    const { value } = resolved
    const negated = op === 'neq'
    if (value === null) {
      // Явное «пусто» — проверка на пустоту; макрос без значения (@my_unit
      // у сотрудника без подразделения) ничему не равен
      if (resolved.macro) return negated ? 'TRUE' : 'FALSE'
      return `(${this.f} IS ${negated ? 'NOT ' : ''}NULL)`
    }
    if (Array.isArray(value)) return this.inList(negated, value)
    if (this.type === 'text[]') {
      const element = this.param(this.scalar(value, this.valuePath), 'text')
      const test = this.state.dialect.inArray(element, this.f)
      return negated ? `(${this.f} IS NULL OR NOT (${test}))` : `(${test})`
    }
    if (this.type === 'datetime') {
      const moment = this.moment(value, this.valuePath)
      if (moment.kind === 'day') {
        const day = `${this.f} >= ${this.dayStart(moment.date)} AND ${this.f} < ${this.nextDayStart(moment.date)}`
        return negated ? `(${this.f} IS NULL OR NOT (${day}))` : `(${day})`
      }
      const instant = this.instant(moment)
      return negated ? `(${this.f} IS DISTINCT FROM ${instant})` : `(${this.f} = ${instant})`
    }
    const coerced = this.scalar(value, this.valuePath)
    // JSON — строкой с приведением: драйвер не сериализует значение повторно
    const param =
      this.type === 'json'
        ? `${this.param(coerced, 'text')}::jsonb`
        : this.param(coerced, this.castFor([coerced]))
    return negated ? `(${this.f} IS DISTINCT FROM ${param})` : `(${this.f} = ${param})`
  }

  private inList(negated: boolean, raw: unknown): string {
    const items = Array.isArray(raw) ? raw : [raw]
    const hasNull = items.some((item) => item === null)
    const coerced = items
      .filter((item) => item !== null)
      .map((item, index) => this.scalar(item, [...this.valuePath, index]))
    const values = [...new Map(coerced.map((value) => [JSON.stringify(value), value])).values()]
    const d = this.state.dialect
    let test = 'FALSE'
    if (values.length) {
      const cast = this.castFor(values)
      const array = this.param(values, `${cast}[]`)
      test = this.type === 'text[]' ? d.overlaps(this.f, array) : d.inArray(this.f, array)
    }
    if (!negated) return hasNull ? `(${test} OR ${this.f} IS NULL)` : `(${test})`
    return hasNull
      ? `(${this.f} IS NOT NULL AND NOT (${test}))`
      : `(${this.f} IS NULL OR NOT (${test}))`
  }

  private compare(op: 'lt' | 'lte' | 'gt' | 'gte' | 'before' | 'after', value: unknown): string {
    if (value === null || Array.isArray(value)) {
      fail(this.valuePath, `Для оператора «${op}» нужно одно значение`)
    }
    const symbol = { lt: '<', lte: '<=', gt: '>', gte: '>=', before: '<', after: '>' }[op]
    if (this.type === 'datetime') {
      const moment = this.moment(value, this.valuePath)
      if (moment.kind === 'instant') return `(${this.f} ${symbol} ${this.instant(moment)})`
      // Целый день: «до 1 января» — раньше его начала, «после» — с начала следующего
      switch (symbol) {
        case '<':
          return `(${this.f} < ${this.dayStart(moment.date)})`
        case '<=':
          return `(${this.f} < ${this.nextDayStart(moment.date)})`
        case '>':
          return `(${this.f} >= ${this.nextDayStart(moment.date)})`
        default:
          return `(${this.f} >= ${this.dayStart(moment.date)})`
      }
    }
    const coerced = this.scalar(value, this.valuePath)
    return `(${this.f} ${symbol} ${this.param(coerced, this.castFor([coerced]))})`
  }

  /** `between`: [от, до] включительно; пустой конец — без ограничения. */
  private between(): string | null {
    const raw = this.cond.value
    let ends: [unknown, unknown]
    if (Array.isArray(raw)) {
      if (raw.length !== 2) fail(this.valuePath, 'Для between нужна пара значений [от, до]')
      ends = [raw[0], raw[1]]
    } else {
      const resolved = this.resolve(raw, this.valuePath)
      if (resolved === MISSING) return null
      const value = resolved.value
      if (Array.isArray(value) && value.length === 2) ends = [value[0], value[1]]
      else if (isRecord(value) && ('from' in value || 'to' in value)) ends = [value.from, value.to]
      else return fail(this.valuePath, 'Для between нужна пара значений [от, до]')
    }
    const parts: string[] = []
    let missing = 0
    ends.forEach((end, index) => {
      const path = [...this.valuePath, index]
      const resolved = end === undefined ? { value: null, macro: false } : this.resolve(end, path)
      if (resolved === MISSING) {
        missing++
        return
      }
      if (resolved.value === null) return
      parts.push(this.bound(index === 0 ? 'from' : 'to', resolved.value, path))
    })
    if (!parts.length) return missing ? null : 'TRUE'
    return `(${parts.join(' AND ')})`
  }

  private bound(side: 'from' | 'to', value: unknown, path: IssuePath): string {
    if (this.type === 'datetime') {
      const moment = this.moment(value, path)
      if (moment.kind === 'instant') {
        return `${this.f} ${side === 'from' ? '>=' : '<='} ${this.instant(moment)}`
      }
      return side === 'from'
        ? `${this.f} >= ${this.dayStart(moment.date)}`
        : `${this.f} < ${this.nextDayStart(moment.date)}`
    }
    const coerced = this.scalar(value, path)
    return `${this.f} ${side === 'from' ? '>=' : '<='} ${this.param(coerced, this.castFor([coerced]))}`
  }

  /** Относительный период: {unit, from, to} — от начала единицы `from` до конца единицы `to`. */
  private relative(): string | null {
    const resolved = this.resolve(this.cond.value, this.valuePath)
    if (resolved === MISSING) return null
    const value = resolved.value
    if (!isRecord(value)) {
      return fail(this.valuePath, 'Относительный период задаётся как {unit, from, to}')
    }
    const unit = value.unit as (typeof RELATIVE_UNITS)[number]
    if (!RELATIVE_UNITS.includes(unit)) {
      fail([...this.valuePath, 'unit'], `Единица периода — одна из: ${RELATIVE_UNITS.join(', ')}`)
    }
    const from = value.from
    const to = value.to
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      fail(this.valuePath, 'Границы периода from и to — целые числа')
    }
    if ((from as number) > (to as number)) {
      fail(this.valuePath, 'Начало периода (from) позже конца (to)', {
        hint: 'Например, {"unit": "month", "from": -12, "to": 0}',
      })
    }
    const d = this.state.dialect
    const base = d.truncLocal(unit, d.atTimeZone(this.state.now(), this.tz))
    const lower = `(${base} + ${d.interval(unit, this.param(from, 'int'))})`
    const upper = `(${base} + ${d.interval(unit, this.param((to as number) + 1, 'int'))})`
    if (this.type === 'date') return `(${this.f} >= ${lower}::date AND ${this.f} < ${upper}::date)`
    return `(${this.f} >= ${d.atTimeZone(lower, this.tz)} AND ${this.f} < ${d.atTimeZone(upper, this.tz)})`
  }

  private pattern(
    op: 'contains' | 'not_contains' | 'starts_with' | 'ends_with',
    value: unknown,
  ): string {
    if (value === null || Array.isArray(value)) fail(this.valuePath, 'Нужна одна строка')
    const text = this.scalar(value, this.valuePath) as string
    if (this.type === 'text[]') {
      if (op !== 'contains' && op !== 'not_contains') {
        fail([...this.path, 'op'], `Оператор «${op}» не применим к списку`)
      }
      const test = this.state.dialect.inArray(this.param(text, 'text'), this.f)
      return op === 'contains' ? `(${test})` : `(${this.f} IS NULL OR NOT (${test}))`
    }
    const escaped = text.replace(/[\\%_]/g, (char) => `\\${char}`)
    const pattern =
      op === 'starts_with' ? `${escaped}%` : op === 'ends_with' ? `%${escaped}` : `%${escaped}%`
    const test = this.state.dialect.ilike(this.f, this.param(pattern, 'text'))
    return op === 'not_contains' ? `(${this.f} IS NULL OR NOT (${test}))` : `(${test})`
  }

  private regex(value: unknown): string {
    if (typeof value !== 'string' || !value)
      fail(this.valuePath, 'Нужно регулярное выражение-строка')
    if (value.length > MAX_REGEX) {
      fail(this.valuePath, `Регулярное выражение длиннее ${MAX_REGEX} символов`)
    }
    return `(${this.state.dialect.regex(this.f, this.param(value, 'text'), true)})`
  }

  /** `within`: территория (с дочерними) или геометрия внутри полигона. */
  private within(value: unknown): string {
    if (this.type === 'geometry') {
      if (typeof value === 'string' || (isRecord(value) && 'id' in value)) {
        return fail(
          this.valuePath,
          'Поиск геометрий внутри территории появится со справочником территорий (P1-E07)',
          {
            hint: 'Передайте полигон GeoJSON',
          },
        )
      }
      return `ST_Within(${this.f}, ${this.geometry(value, this.valuePath)})`
    }
    if (this.field.fieldType !== 'territory') {
      fail(
        [...this.path, 'op'],
        `Оператор «within» применим к территории или геометрии, а «${this.cond.field}» — не такое`,
      )
    }
    const items = Array.isArray(value) ? value : [value]
    const ids = new Set<string>()
    items.forEach((item, index) => {
      const path = Array.isArray(value) ? [...this.valuePath, index] : this.valuePath
      if (item === null) return
      let id: unknown = item
      let children = true
      if (isRecord(item)) {
        id = item.id
        children = item.includeChildren !== false
      }
      if (typeof id !== 'string' || !UUID.test(id)) {
        fail(path, `Ожидался идентификатор территории, а получено: ${show(id)}`)
      }
      if (!children) {
        ids.add(id)
        return
      }
      const descendants = this.state.ctx.territoryDescendants
      if (!descendants) {
        fail(path, 'Нет иерархии территорий для поиска с дочерними', {
          hint: 'Передайте territoryDescendants в контекст компиляции или includeChildren: false',
        })
      }
      ids.add(id)
      for (const child of descendants(id)) ids.add(child)
    })
    if (!ids.size) return 'FALSE'
    return `(${this.state.dialect.inArray(this.f, this.param([...ids], 'uuid[]'))})`
  }

  /** `dwithin`: {geometry, distance} или {lon, lat, distance}; расстояние — метры. */
  private dwithin(value: unknown): string {
    if (!isRecord(value)) {
      return fail(this.valuePath, 'Для dwithin нужно {geometry, distance} или {lon, lat, distance}')
    }
    const distance = value.distance
    if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0) {
      fail([...this.valuePath, 'distance'], 'Расстояние — неотрицательное число метров')
    }
    let target: unknown = value.geometry
    if (target === undefined && typeof value.lon === 'number' && typeof value.lat === 'number') {
      target = { type: 'Point', coordinates: [value.lon, value.lat] }
    }
    const d = this.state.dialect
    const geometry = this.geometry(target, [...this.valuePath, 'geometry'])
    return `ST_DWithin(${d.geography(this.f)}, ${d.geography(geometry)}, ${this.param(distance, 'double precision')})`
  }

  private geometry(value: unknown, path: IssuePath): string {
    let geometry = value
    if (isRecord(geometry) && geometry.type === 'Feature') geometry = geometry.geometry
    if (
      !isRecord(geometry) ||
      typeof geometry.type !== 'string' ||
      !GEOMETRY_TYPES.has(geometry.type) ||
      (geometry.type === 'GeometryCollection'
        ? !Array.isArray(geometry.geometries)
        : !Array.isArray(geometry.coordinates))
    ) {
      return fail(path, 'Ожидалась геометрия GeoJSON')
    }
    return this.state.dialect.geomFromGeoJson(this.param(JSON.stringify(geometry), 'text'))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function show(value: unknown): string {
  if (value === undefined) return 'ничего'
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}
