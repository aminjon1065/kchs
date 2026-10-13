import { TERRITORY_LEVELS, type TerritoryLevel } from '@kchs/contracts'
import type { Dialect } from '../dialect.js'
import { ExpressionError } from '../errors.js'
import { validDate } from '../time.js'
import type { ReferenceRequest } from '../types.js'
import { sqlTypeOfValue, unify, VALUE_TYPE_LABELS, type ValueType } from '../value-types.js'
import type { Expr } from './ast.js'
import type { ExprEnv, ExprValue } from './env.js'
import {
  type CastTarget,
  ISO_DATE,
  ISO_DATETIME,
  ISO_TIME,
  inferType,
  serialize,
  type Typed,
  typeError,
  UUID,
} from './typed.js'

/**
 * Слой 1: листья выражения (литералы, поля, параметры и макросы) и помощники типов —
 * приведения, проверки, объединение типов, справочники территорий.
 */
export abstract class ExprCompilerCore {
  abstract node(expr: Expr): Typed

  protected aggregateDepth = 0

  constructor(protected readonly env: ExprEnv) {}

  protected get d(): Dialect {
    return this.env.dialect
  }

  protected literal(
    kind: 'string' | 'number' | 'boolean' | 'null',
    value: unknown,
    type: ValueType,
    span: { pos: number; end: number },
  ): Typed {
    return {
      type,
      aggregate: false,
      pos: span.pos,
      end: span.end,
      literal: { kind, value },
      emit: (target) => this.emitLiteral(kind, value, target ?? type, span.pos),
    }
  }

  protected emitLiteral(
    kind: 'string' | 'number' | 'boolean' | 'null',
    value: unknown,
    target: ValueType,
    pos: number,
  ): string {
    if (kind === 'null')
      return target === 'null' ? 'NULL' : this.d.cast('NULL', sqlTypeOfValue(target))
    if (kind === 'boolean') return value ? 'TRUE' : 'FALSE'
    if (kind === 'number') {
      // Число из лексера конечно и не содержит ничего, кроме цифр, точки и экспоненты
      const text = String(value)
      return target === 'text' ? this.env.binder.add(text, 'text') : text
    }
    return this.emitText(value as string, target, pos)
  }

  /** Строка в целевом типе: формат проверяется до запроса, значение — параметром. */
  protected emitText(text: string, target: ValueType, pos: number): string {
    switch (target) {
      case 'date':
        if (!ISO_DATE.test(text) || !validDate(text)) {
          throw new ExpressionError(`«${text}» — не дата`, pos, 'Дата пишется как ГГГГ-ММ-ДД')
        }
        return this.env.binder.add(text, 'date')
      case 'datetime': {
        const match = ISO_DATETIME.exec(text)
        if ((!ISO_DATE.test(text) && !match) || !validDate(text.slice(0, 10))) {
          throw new ExpressionError(
            `«${text}» — не дата и время`,
            pos,
            'Дата и время пишутся как ГГГГ-ММ-ДДTЧЧ:ММ',
          )
        }
        // Дата или время без пояса — местное время пояса запроса
        if (match?.[3]) return this.env.binder.add(text, 'timestamptz')
        return this.d.atTimeZone(this.env.binder.add(text, 'timestamp'), this.env.timezone())
      }
      case 'time':
        if (!ISO_TIME.test(text)) {
          throw new ExpressionError(`«${text}» — не время`, pos, 'Время пишется как ЧЧ:ММ')
        }
        return this.env.binder.add(text, 'time')
      case 'uuid':
        if (!UUID.test(text)) throw new ExpressionError(`«${text}» — не идентификатор`, pos)
        return this.env.binder.add(text, 'uuid')
      default:
        return this.env.binder.add(text, 'text')
    }
  }

  protected field(qualifier: string | null, name: string, pos: number, end: number): Typed {
    const resolved = this.env.resolveField(qualifier, name, pos)
    if (this.env.mode === 'aggregate' && this.aggregateDepth === 0) {
      if (!this.env.groupKeys?.has(resolved.sql)) {
        throw new ExpressionError(
          `Поле «${qualifier ? `${qualifier}.` : ''}${name}» вне агрегата должно быть в группировке`,
          pos,
          'Оберните поле в агрегат (sum, max…) или добавьте его в группировку',
        )
      }
    }
    return {
      type: resolved.type,
      aggregate: false,
      pos,
      end,
      ...(resolved.fieldType ? { fieldType: resolved.fieldType } : {}),
      ...(resolved.lookup ? { lookup: resolved.lookup } : {}),
      emit: (target) => this.convert(resolved.sql, resolved.type, target ?? resolved.type),
    }
  }

  /** Параметр или макрос: значение уходит параметром запроса. */
  protected value(resolved: ExprValue, span: { pos: number; end: number }, label: string): Typed {
    if (resolved.array) {
      const items = Array.isArray(resolved.value) ? (resolved.value as unknown[]) : []
      const elementType = resolved.type ?? inferType(items.find((item) => item !== null) ?? null)
      return {
        type: elementType,
        aggregate: false,
        pos: span.pos,
        end: span.end,
        array: { value: items, elementType },
        emit: () => {
          throw new ExpressionError(`${label} — список, он допустим только внутри in (…)`, span.pos)
        },
      }
    }
    if (resolved.value === null || resolved.value === undefined) {
      const type = resolved.type ?? 'null'
      return this.literal('null', null, type, span)
    }
    // Строка без объявленного типа ведёт себя как строковый литерал: рядом с датой
    // становится датой (с проверкой формата), всегда — отдельным параметром
    if (resolved.type === null && typeof resolved.value === 'string') {
      return this.literal('string', resolved.value, 'text', span)
    }
    const type = resolved.type ?? inferType(resolved.value)
    const value = serialize(resolved.value)
    return {
      type,
      aggregate: false,
      pos: span.pos,
      end: span.end,
      emit: (target) => {
        const effective = target && target !== 'null' ? target : type
        if (type === 'date' && effective === 'datetime') {
          return this.convert(this.emitValue(value, 'date', span.pos), 'date', 'datetime')
        }
        return this.emitValue(value, effective, span.pos)
      },
    }
  }

  protected emitValue(value: unknown, target: ValueType, pos: number): string {
    if (typeof value === 'string' && ['date', 'datetime', 'time', 'uuid'].includes(target)) {
      return this.emitText(value, target, pos)
    }
    if (target === 'json') {
      // JSON — строкой с приведением: драйвер не сериализует значение повторно
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return this.d.cast(this.env.binder.add(text, 'text'), 'jsonb')
    }
    return this.env.binder.add(value, sqlTypeOfValue(target))
  }

  protected make(
    type: ValueType,
    parts: Typed[],
    span: { pos: number; end: number },
    emit: () => string,
  ): Typed {
    return {
      type,
      aggregate: parts.some((part) => part.aggregate),
      pos: span.pos,
      end: span.end,
      emit: (target) => this.convert(emit(), type, target ?? type),
    }
  }

  /** Приведение готового SQL к целевому типу при унификации. */
  protected convert(sql: string, from: ValueType, to: ValueType): string {
    if (from === to || to === 'null') return sql
    if (from === 'null') return this.d.cast(sql, sqlTypeOfValue(to))
    if (from === 'date' && to === 'datetime') {
      // Дата — полночь в поясе запроса
      return this.d.atTimeZone(this.d.cast(sql, 'timestamp'), this.env.timezone())
    }
    if (from === 'text' && to === 'uuid') return this.d.tryCast(sql, 'uuid')
    return sql
  }

  protected scalar(value: Typed): Typed {
    if (value.array) {
      throw new ExpressionError('Список значений допустим только внутри in (…)', value.pos)
    }
    return value
  }

  protected expect(value: Typed, type: ValueType, label: string): Typed {
    if (value.type === type || value.type === 'null') return value
    if (value.literal?.kind === 'string' && ['date', 'datetime', 'time', 'uuid'].includes(type))
      return value
    return typeError(label, value)
  }

  protected temporal(value: Typed): Typed {
    if (value.type === 'date' || value.type === 'datetime') return value
    return typeError(
      'дата или дата и время',
      value,
      "Строку можно превратить в дату: date('2026-01-01')",
    )
  }

  /**
   * Общий тип нескольких значений. Строковые литералы подстраиваются под
   * остальные значения (дата, время, ссылка) — формат проверяется при выводе.
   */
  protected unifyAll(values: Typed[], what: string): ValueType {
    const flexible = (value: Typed) => value.literal?.kind === 'string'
    let type: ValueType = 'null'
    for (const value of values.filter((item) => !flexible(item))) {
      const next = unify(type, value.type)
      if (!next) {
        throw new ExpressionError(
          `У значений в ${what} разные типы`,
          value.pos,
          'Приведите ветки к одному типу',
        )
      }
      type = next
    }
    for (const value of values.filter(flexible)) {
      if (type === 'null') type = 'text'
      else if (!['text', 'date', 'datetime', 'time', 'uuid'].includes(type)) {
        throw new ExpressionError(
          `У значений в ${what} разные типы`,
          value.pos,
          'Приведите ветки к одному типу',
        )
      }
    }
    return type
  }

  /**
   * SQL приведения: текст проверяется `pg_input_is_valid`, поэтому мусорное
   * значение даёт `NULL`, а не ошибку всего запроса.
   */
  protected castSql(value: Typed, to: CastTarget): string {
    const d = this.d
    if (to === 'text') {
      const source = value.type === 'geometry' ? d.geoJson(value.emit('geometry')) : value.emit()
      return `(${source})::text`
    }
    if (value.type === 'text') {
      const text = `btrim(${value.emit('text')})`
      if (to === 'number') return d.tryCast(text, 'double precision')
      if (to === 'boolean') return d.tryCast(text, 'boolean')
      if (to === 'date') return d.tryCast(text, 'date')
      return d.tryCast(text, 'timestamptz')
    }
    if (to === 'number') {
      if (value.type === 'boolean') return `(CASE WHEN ${value.emit('boolean')} THEN 1 ELSE 0 END)`
      throw new ExpressionError(
        `Значение типа «${VALUE_TYPE_LABELS[value.type]}» к числу не приводится`,
        value.pos,
      )
    }
    if (to === 'boolean') {
      if (value.type === 'number') return `(${value.emit('number')} <> 0)`
      throw new ExpressionError(
        `Значение типа «${VALUE_TYPE_LABELS[value.type]}» к логическому не приводится`,
        value.pos,
      )
    }
    if (to === 'date' && value.type === 'datetime') {
      return d.localDate(value.emit('datetime'), this.env.timezone())
    }
    if (to === 'datetime' && value.type === 'date') return `(${value.emit('date')})::timestamptz`
    throw new ExpressionError(
      `Значение типа «${VALUE_TYPE_LABELS[value.type]}» к «${to}» не приводится`,
      value.pos,
    )
  }

  protected integerLiteral(value: Typed, what: string): number {
    const number = value.literal?.kind === 'number' ? (value.literal.value as number) : Number.NaN
    if (!Number.isInteger(number) || number < -10 || number > 12) {
      throw new ExpressionError(`${what}: целое число от −10 до 12`, value.pos)
    }
    return number
  }

  /** Подстановка справочной функции; окружение без справочников — понятная ошибка. */
  protected reference(request: ReferenceRequest, pos: number): string {
    if (!this.env.reference) {
      throw new ExpressionError('Справочные функции в этом выражении недоступны', pos)
    }
    return this.env.reference(request)
  }

  /** Аргумент территориальной функции: поле-территория (идентификатор) или код текстом. */
  protected territoryKey(value: Typed, name: string): 'id' | 'code' {
    if (value.type === 'uuid' && value.fieldType === 'territory') return 'id'
    if (value.type === 'text') return 'code'
    throw new ExpressionError(
      `${name}() принимает территорию или код территории, а получено: ${VALUE_TYPE_LABELS[value.type]}`,
      value.pos,
      "Например, territory_level(district, 'region')",
    )
  }

  protected levelLiteral(value: Typed): TerritoryLevel {
    const level = value.literal?.kind === 'string' ? String(value.literal.value) : ''
    if (!(TERRITORY_LEVELS as readonly string[]).includes(level)) {
      throw new ExpressionError(
        'Уровень территории — строка из списка',
        value.pos,
        `Допустимо: ${TERRITORY_LEVELS.map((item) => `'${item}'`).join(', ')}`,
      )
    }
    return level as TerritoryLevel
  }

  protected unitLiteral<T extends string>(value: Typed, allowed: readonly T[]): T {
    const unit = value.literal?.kind === 'string' ? String(value.literal.value).toLowerCase() : ''
    if (!allowed.includes(unit as T)) {
      throw new ExpressionError(
        'Единица — строка из списка',
        value.pos,
        `Допустимо: ${allowed.map((item) => `'${item}'`).join(', ')}`,
      )
    }
    return unit as T
  }
}
