import type { QueryParam, QuerySpec } from '@kchs/contracts'
import { type Dialect, postgresDialect } from '../dialect.js'
import { fail, type IssuePath } from '../errors.js'
import type { ExprValue } from '../expr/compile.js'
import { ParamBinder } from '../params.js'
import { referenceKey } from '../references.js'
import { knownTimezone, localDateOf } from '../time.js'
import type { CompileContext, ReferenceRequest, ResolvedDataset } from '../types.js'
import type { ValueType } from '../value-types.js'

export const DEFAULT_TIMEZONE = 'Asia/Dushanbe'
const TIMEZONE = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/

/** Пропущенный необязательный параметр: условие фильтра с ним не применяется. */
export const MISSING = Symbol('missing-param')

const PARAM_TYPES: Record<QueryParam['type'], ValueType> = {
  text: 'text',
  number: 'number',
  date: 'date',
  datetime: 'datetime',
  boolean: 'boolean',
  territory: 'uuid',
  unit: 'uuid',
  user: 'uuid',
  list: 'text',
}

/**
 * Состояние одной компиляции: параметры, имена CTE, использованные значения
 * контекста (для ключа кэша) и датасеты с их политиками.
 */
export class CompileState {
  readonly dialect: Dialect
  readonly binder: ParamBinder
  readonly timezone: string
  readonly ctes: string[] = []
  readonly datasets = new Map<string, ResolvedDataset>()
  /** Сохранённые запросы-источники: их спецификации — часть ключа кэша. */
  readonly queries = new Map<string, QuerySpec>()
  readonly usedParams: Record<string, unknown> = {}
  readonly usedUser: Record<string, unknown> = {}
  /** Цепочка сохранённых запросов, которые компилируются сейчас (циклы, глубина). */
  readonly queryStack: string[] = []
  /** Использованные справочные подстановки: ключ → версия (часть ключа кэша). */
  readonly usedReferences = new Map<string, string>()
  /** Подстановки, которых нет в контексте: их загрузит вызывающий. */
  readonly missingReferences = new Map<string, ReferenceRequest>()
  usesTime = false
  private counters = new Map<string, number>()

  constructor(
    readonly ctx: CompileContext,
    public spec: QuerySpec,
  ) {
    this.dialect = ctx.dialect ?? postgresDialect
    this.binder = new ParamBinder(this.dialect)
    const timezone = ctx.timezone ?? DEFAULT_TIMEZONE
    if (!TIMEZONE.test(timezone) || !knownTimezone(timezone)) {
      fail([], `Недопустимый часовой пояс «${timezone}»`)
    }
    this.timezone = timezone
  }

  /** Компиляция вложенного сохранённого запроса: его объявления параметров. */
  nested<T>(id: string, spec: QuerySpec, run: () => T): T {
    const outer = this.spec
    this.queryStack.push(id)
    this.spec = spec
    try {
      return run()
    } finally {
      this.spec = outer
      this.queryStack.pop()
    }
  }

  /** Имя следующего CTE: q0, q1… (источники соединений — j0…, объединений — u0…). */
  nextName(prefix: 'q' | 'j' | 'u'): string {
    const index = this.counters.get(prefix) ?? 0
    this.counters.set(prefix, index + 1)
    return `${prefix}${index}`
  }

  addCte(name: string, body: string): void {
    this.ctes.push(`${this.dialect.ident(name)} AS (\n  ${body.replaceAll('\n', '\n  ')}\n)`)
  }

  tz(): string {
    return this.binder.once('timezone', this.timezone, 'text')
  }

  /**
   * SQL подстановки jsonb «значение → результат» для справочной функции: один
   * параметр на запрос. Подстановки нет — она запоминается, а SQL-заглушка не
   * выполнится: `compileQuery` сообщит, что загрузить (ADR-0057).
   */
  reference(request: ReferenceRequest): string {
    const key = referenceKey(request)
    const map = this.ctx.references?.(request)
    if (!map) {
      this.missingReferences.set(key, request)
      return this.dialect.cast(`'{}'`, 'jsonb')
    }
    this.usedReferences.set(key, map.version)
    // Строкой с приведением: с типом jsonb драйвер закодировал бы JSON повторно
    const param = this.binder.once(`reference:${key}`, JSON.stringify(map.values), 'text')
    return this.dialect.cast(param, 'jsonb')
  }

  now(): string {
    this.usesTime = true
    return this.binder.once('now', this.ctx.now.toISOString(), 'timestamptz')
  }

  /** Сегодняшняя дата в поясе запроса (для `@today`). */
  today(): string {
    this.usesTime = true
    return localDateOf(this.ctx.now, this.timezone)
  }

  // ─── Пользователь и макросы ────────────────────────────────────────────────

  userId(): string {
    this.usedUser.id = this.ctx.user.id
    return this.ctx.user.id
  }

  unitIds(): readonly string[] {
    this.usedUser.unitIds = this.ctx.user.unitIds
    return this.ctx.user.unitIds
  }

  territoryIds(): readonly string[] {
    this.usedUser.territoryIds = this.ctx.user.territoryIds
    return this.ctx.user.territoryIds
  }

  subordinateIds(): readonly string[] {
    this.usedUser.subordinateIds = this.ctx.user.subordinateIds
    return this.ctx.user.subordinateIds
  }

  unitMemberIds(path: IssuePath): readonly string[] {
    const members = this.ctx.user.unitMemberIds
    if (!members) fail(path, 'Сотрудники подразделения недоступны для этого запроса')
    this.usedUser.unitMemberIds = members
    return members
  }

  userAttribute(key: string): unknown {
    const value = this.ctx.user.attributes[key]
    const used = (this.usedUser.attributes as Record<string, unknown> | undefined) ?? {}
    used[key] = value ?? null
    this.usedUser.attributes = used
    return value
  }

  /** Значение макроса для фильтра (`@me` → идентификатор и т. д.). */
  macroValue(name: string, path: IssuePath): unknown {
    switch (name) {
      case 'me':
        return this.userId()
      case 'my_unit':
        return this.unitIds()[0] ?? null
      case 'my_units':
        return [...this.unitIds()]
      case 'my_territories':
        return [...this.territoryIds()]
      case 'today':
        return this.today()
      case 'now':
        this.usesTime = true
        return this.ctx.now.toISOString()
      default:
        return fail(path, `Неизвестный макрос «@${name}»`)
    }
  }

  /** Макрос в выражении — значение и тип. */
  macroExpr(name: string, path: IssuePath): ExprValue {
    switch (name) {
      case 'me':
        return { value: this.userId(), type: 'uuid' }
      case 'my_unit':
        return { value: this.unitIds()[0] ?? null, type: 'uuid' }
      case 'my_units':
        return { value: [...this.unitIds()], type: 'uuid', array: true }
      case 'my_territories':
        return { value: [...this.territoryIds()], type: 'uuid', array: true }
      case 'today':
        return { value: this.today(), type: 'date' }
      case 'now':
        this.usesTime = true
        return { value: this.ctx.now.toISOString(), type: 'datetime' }
      default:
        return fail(path, `Неизвестный макрос «@${name}»`)
    }
  }

  // ─── Параметры ─────────────────────────────────────────────────────────────

  /**
   * Значение параметра: из контекста, иначе значение по умолчанию из спецификации
   * (оно может быть макросом, например `@my_territories`). Пропущенный
   * необязательный — `MISSING`, обязательный — ошибка.
   */
  paramValue(name: string, path: IssuePath): unknown {
    const declared = this.spec.params[name]
    const given = this.ctx.params?.[name]
    let value: unknown = given
    if (value === undefined) value = declared?.default
    if (typeof value === 'string' && value.startsWith('@') && !value.startsWith('@param:')) {
      value = this.macroValue(value.slice(1), path)
    }
    if (value === undefined || value === null) {
      if (declared?.required) fail(path, `Не задан обязательный параметр «${name}»`)
      if (!declared && given === undefined) {
        fail(path, `Неизвестный параметр «${name}»`, { hint: 'Объявите его в params запроса' })
      }
      this.usedParams[name] = null
      return MISSING
    }
    this.usedParams[name] = value
    return value
  }

  paramExpr(name: string, path: IssuePath): ExprValue {
    const declared = this.spec.params[name]
    const value = this.paramValue(name, path)
    const type = declared ? PARAM_TYPES[declared.type] : null
    const array = Array.isArray(value)
    if (value === MISSING) return { value: null, type }
    return { value, type, ...(array ? { array: true } : {}) }
  }
}
