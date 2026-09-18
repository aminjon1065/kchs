import { type FieldType, TERRITORY_LEVELS, type TerritoryLevel } from '@kchs/contracts'
import type { DatePart, DateUnit, Dialect, IntervalUnit } from '../dialect.js'
import { ExpressionError } from '../errors.js'
import type { ParamBinder } from '../params.js'
import { validDate } from '../time.js'
import type { LookupRef, ReferenceRequest } from '../types.js'
import {
  isOrderable,
  sqlTypeOfValue,
  unify,
  VALUE_TYPE_LABELS,
  type ValueType,
} from '../value-types.js'
import type { Expr } from './ast.js'
import { parseExpression } from './parser.js'

/** Поле, на которое ссылается выражение: SQL-ссылка и тип. */
export interface ExprField {
  sql: string
  type: ValueType
  fieldType?: FieldType
  /** Справочник поля — для `lookup_label()`. */
  lookup?: LookupRef
}

/** Значение параметра или макроса и его тип (null — вывести по значению). */
export interface ExprValue {
  value: unknown
  type: ValueType | null
  /** Массив значений (`@my_units`, список-параметр) — только внутри `in (…)`. */
  array?: boolean
}

export interface ExprEnv {
  dialect: Dialect
  binder: ParamBinder
  /** `row` — выражение строки; `aggregate` — мера шага aggregate (агрегаты разрешены). */
  mode: 'row' | 'aggregate'
  resolveField(qualifier: string | null, name: string, pos: number): ExprField
  /** Ключи группировки (SQL-ссылки) — единственные поля, допустимые вне агрегатов. */
  groupKeys?: ReadonlySet<string>
  /** Условие условной меры: каждый агрегат выражения получает `FILTER (WHERE …)`. */
  aggregateFilter?: string
  resolveParam(name: string, pos: number): ExprValue
  resolveMacro(name: string, pos: number): ExprValue
  userAttr(key: string, pos: number): ExprValue
  /**
   * SQL подстановки jsonb «значение → результат» для справочной функции
   * (`territory_level`, `territory_name`, `lookup_label`); нет — функции недоступны.
   */
  reference?(request: ReferenceRequest): string
  /** SQL часового пояса (общий параметр запроса). */
  timezone(): string
  /** SQL момента «сейчас» (общий параметр запроса). */
  now(): string
}

/** Скомпилированное выражение: SQL, тип, признаки. */
export interface CompiledExpr {
  sql: string
  type: ValueType
  aggregate: boolean
  fieldType?: FieldType
}

interface Typed {
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

const DATE_UNITS: readonly DateUnit[] = ['year', 'quarter', 'month', 'week', 'day', 'hour']
const INTERVAL_UNITS: readonly IntervalUnit[] = [
  'year',
  'quarter',
  'month',
  'week',
  'day',
  'hour',
  'minute',
]
const AGGREGATES = new Set([
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
const WINDOW_FUNCTIONS = new Set([
  'lag',
  'lead',
  'rank',
  'dense_rank',
  'row_number',
  'running_sum',
  'moving_avg',
])

/** Разбирает и компилирует выражение в SQL с проверкой типов. */
export function compileExpression(source: string, env: ExprEnv): CompiledExpr {
  const tree = parseExpression(source)
  const compiler = new ExprCompiler(env)
  const typed = compiler.node(tree)
  if (typed.array) {
    throw new ExpressionError('Список значений допустим только внутри in (…)', typed.pos)
  }
  const sql = typed.emit()
  return {
    sql,
    type: typed.type,
    aggregate: typed.aggregate,
    ...(typed.fieldType ? { fieldType: typed.fieldType } : {}),
  }
}

/** Выражение-условие (политики, фильтры шагов): результат обязан быть логическим. */
export function compileCondition(source: string, env: ExprEnv): CompiledExpr {
  const compiled = compileExpression(source, env)
  if (compiled.type !== 'boolean' && compiled.type !== 'null') {
    throw new ExpressionError(
      `Условие должно быть логическим, а получилось: ${VALUE_TYPE_LABELS[compiled.type]}`,
      0,
      'Добавьте сравнение, например «поле > 0»',
    )
  }
  return compiled
}

function typeError(expected: string, got: Typed, hint?: string): never {
  throw new ExpressionError(
    `Ожидалось: ${expected}, а получено: ${VALUE_TYPE_LABELS[got.type]}`,
    got.pos,
    hint,
  )
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const ISO_TIME = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

class ExprCompiler {
  private aggregateDepth = 0

  constructor(private readonly env: ExprEnv) {}

  private get d(): Dialect {
    return this.env.dialect
  }

  node(expr: Expr): Typed {
    switch (expr.kind) {
      case 'number':
        return this.literal('number', expr.value, 'number', expr)
      case 'string':
        return this.literal('string', expr.value, 'text', expr)
      case 'boolean':
        return this.literal('boolean', expr.value, 'boolean', expr)
      case 'null':
        return this.literal('null', null, 'null', expr)
      case 'field':
        return this.field(expr.qualifier, expr.name, expr.pos, expr.end)
      case 'param':
        return this.value(this.env.resolveParam(expr.name, expr.pos), expr, `@param:${expr.name}`)
      case 'macro':
        return this.value(this.env.resolveMacro(expr.name, expr.pos), expr, `@${expr.name}`)
      case 'unary':
        return this.unary(expr.op, expr.operand, expr.pos, expr.end)
      case 'binary':
        return this.binary(expr)
      case 'in':
        return this.inList(expr.operand, expr.list, expr.negated, expr.pos, expr.end)
      case 'isnull': {
        const operand = this.scalar(this.node(expr.operand))
        return this.make(
          'boolean',
          [operand],
          expr,
          () => `(${operand.emit()} IS ${expr.negated ? 'NOT ' : ''}NULL)`,
        )
      }
      case 'like': {
        const operand = this.expect(this.scalar(this.node(expr.operand)), 'text', 'строка')
        const pattern = this.expect(this.scalar(this.node(expr.pattern)), 'text', 'шаблон-строка')
        return this.make(
          'boolean',
          [operand, pattern],
          expr,
          () =>
            `(${operand.emit('text')} ${expr.negated ? 'NOT LIKE' : 'LIKE'} ${pattern.emit('text')})`,
        )
      }
      case 'call':
        return this.call(expr.name, expr.args, expr.pos, expr.end)
      case 'case': {
        const branches = expr.branches.map((branch) => ({
          when: this.expect(this.node(branch.when), 'boolean', 'условие'),
          result: this.scalar(this.node(branch.result)),
        }))
        const otherwise = expr.otherwise ? this.scalar(this.node(expr.otherwise)) : null
        const values = [
          ...branches.map((branch) => branch.result),
          ...(otherwise ? [otherwise] : []),
        ]
        const type = this.unifyAll(values, 'ветки case')
        return this.make(type, [...branches.map((b) => b.when), ...values], expr, () => {
          const parts = branches.map(
            (branch) => `WHEN ${branch.when.emit('boolean')} THEN ${branch.result.emit(type)}`,
          )
          const elsePart = otherwise ? ` ELSE ${otherwise.emit(type)}` : ''
          return `(CASE ${parts.join(' ')}${elsePart} END)`
        })
      }
    }
  }

  // ─── Листья ────────────────────────────────────────────────────────────────

  private literal(
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

  private emitLiteral(
    kind: 'string' | 'number' | 'boolean' | 'null',
    value: unknown,
    target: ValueType,
    pos: number,
  ): string {
    if (kind === 'null') return target === 'null' ? 'NULL' : `NULL::${sqlTypeOfValue(target)}`
    if (kind === 'boolean') return value ? 'TRUE' : 'FALSE'
    if (kind === 'number') {
      // Число из лексера конечно и не содержит ничего, кроме цифр, точки и экспоненты
      const text = String(value)
      return target === 'text' ? this.env.binder.add(text, 'text') : text
    }
    return this.emitText(value as string, target, pos)
  }

  /** Строка в целевом типе: формат проверяется до запроса, значение — параметром. */
  private emitText(text: string, target: ValueType, pos: number): string {
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

  private field(qualifier: string | null, name: string, pos: number, end: number): Typed {
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
  private value(resolved: ExprValue, span: { pos: number; end: number }, label: string): Typed {
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

  private emitValue(value: unknown, target: ValueType, pos: number): string {
    if (typeof value === 'string' && ['date', 'datetime', 'time', 'uuid'].includes(target)) {
      return this.emitText(value, target, pos)
    }
    if (target === 'json') {
      // JSON — строкой с приведением: драйвер не сериализует значение повторно
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return `${this.env.binder.add(text, 'text')}::jsonb`
    }
    return this.env.binder.add(value, sqlTypeOfValue(target))
  }

  // ─── Операторы ─────────────────────────────────────────────────────────────

  private unary(op: '-' | '+' | 'not', operandExpr: Expr, pos: number, end: number): Typed {
    const operand = this.scalar(this.node(operandExpr))
    if (op === 'not') {
      this.expect(operand, 'boolean', 'логическое значение')
      return this.make('boolean', [operand], { pos, end }, () => `(NOT ${operand.emit('boolean')})`)
    }
    this.expect(operand, 'number', 'число')
    if (op === '+') return { ...operand, pos, end }
    // Отрицательное число — тоже литерал (round(x, -3), date_add(d, -1, 'day'))
    if (operand.literal?.kind === 'number') {
      return this.literal('number', -(operand.literal.value as number), 'number', { pos, end })
    }
    return this.make('number', [operand], { pos, end }, () => `(-${operand.emit('number')})`)
  }

  private binary(expr: Extract<Expr, { kind: 'binary' }>): Typed {
    const left = this.scalar(this.node(expr.left))
    const right = this.scalar(this.node(expr.right))
    const span = { pos: expr.pos, end: expr.end }
    switch (expr.op) {
      case 'and':
      case 'or': {
        this.expect(left, 'boolean', 'логическое значение')
        this.expect(right, 'boolean', 'логическое значение')
        const keyword = expr.op.toUpperCase()
        return this.make(
          'boolean',
          [left, right],
          span,
          () => `(${left.emit('boolean')} ${keyword} ${right.emit('boolean')})`,
        )
      }
      case '=':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const type = this.comparable(left, right, expr.opPos)
        if (expr.op !== '=' && expr.op !== '!=' && !isOrderable(type)) {
          throw new ExpressionError(
            `Значения типа «${VALUE_TYPE_LABELS[type]}» нельзя сравнивать на больше/меньше`,
            expr.opPos,
          )
        }
        const op = expr.op === '!=' ? '<>' : expr.op
        return this.make(
          'boolean',
          [left, right],
          span,
          () => `(${left.emit(type)} ${op} ${right.emit(type)})`,
        )
      }
      case '+':
      case '-':
      case '*': {
        this.arithmetic(left, right, expr.op, expr.opPos)
        return this.make(
          'number',
          [left, right],
          span,
          () => `(${left.emit('number')} ${expr.op} ${right.emit('number')})`,
        )
      }
      case '/': {
        this.arithmetic(left, right, '/', expr.opPos)
        // Деление вещественное и без ошибки деления на ноль: x / 0 → пусто
        return this.make(
          'number',
          [left, right],
          span,
          () =>
            `(${left.emit('number')}::double precision / NULLIF(${right.emit('number')}::double precision, 0))`,
        )
      }
      case '%': {
        this.arithmetic(left, right, '%', expr.opPos)
        return this.make(
          'number',
          [left, right],
          span,
          () =>
            `mod(${left.emit('number')}::numeric, NULLIF(${right.emit('number')}::numeric, 0))::double precision`,
        )
      }
      case '||': {
        for (const side of [left, right]) {
          if (side.type !== 'text' && side.type !== 'number' && side.type !== 'null') {
            typeError('строка или число', side, 'Для дат используйте format_date()')
          }
        }
        return this.make(
          'text',
          [left, right],
          span,
          () => `(${this.asText(left)} || ${this.asText(right)})`,
        )
      }
    }
  }

  private arithmetic(left: Typed, right: Typed, op: string, pos: number): void {
    for (const side of [left, right]) {
      if (side.type !== 'number' && side.type !== 'null') {
        const temporal = side.type === 'date' || side.type === 'datetime'
        throw new ExpressionError(
          `Оператор «${op}» применим только к числам, а получено: ${VALUE_TYPE_LABELS[side.type]}`,
          temporal ? pos : side.pos,
          temporal ? 'Для дат используйте date_add() и date_diff()' : undefined,
        )
      }
    }
  }

  private asText(value: Typed): string {
    if (value.type === 'number') return `${value.emit('number')}::text`
    return value.emit('text')
  }

  private comparable(left: Typed, right: Typed, pos: number): ValueType {
    const type = unify(this.flexible(left, right), this.flexible(right, left))
    if (!type) {
      throw new ExpressionError(
        `Нельзя сравнить «${VALUE_TYPE_LABELS[left.type]}» и «${VALUE_TYPE_LABELS[right.type]}»`,
        pos,
      )
    }
    return type
  }

  /** Строковый литерал рядом с датой/ссылкой принимает их тип (проверка формата — при выводе). */
  private flexible(value: Typed, other: Typed): ValueType {
    if (
      value.literal?.kind === 'string' &&
      ['date', 'datetime', 'time', 'uuid'].includes(other.type)
    ) {
      return other.type
    }
    return value.type
  }

  private inList(
    operandExpr: Expr,
    listExprs: Expr[],
    negated: boolean,
    pos: number,
    end: number,
  ): Typed {
    const operand = this.scalar(this.node(operandExpr))
    const items = listExprs.map((item) => this.node(item))
    const array = items.length === 1 ? items[0]?.array : undefined
    if (array) {
      const type =
        unify(operand.type, array.elementType) ??
        typeError(VALUE_TYPE_LABELS[operand.type], items[0] as Typed)
      return this.make('boolean', [operand], { pos, end }, () => {
        const param = this.env.binder.add(array.value.map(serialize), `${sqlTypeOfValue(type)}[]`)
        const test = this.d.inArray(operand.emit(type), param)
        return negated ? `(NOT (${test}))` : `(${test})`
      })
    }
    for (const item of items) {
      if (item.array) {
        throw new ExpressionError(
          'Список-параметр должен быть единственным элементом in (…)',
          item.pos,
        )
      }
    }
    const type = items.reduce<ValueType>((acc, item) => {
      const next = unify(acc, this.flexible(item, operand))
      if (!next) typeError(VALUE_TYPE_LABELS[acc], item)
      return next
    }, operand.type)
    return this.make('boolean', [operand, ...items], { pos, end }, () => {
      const list = items.map((item) => item.emit(type)).join(', ')
      return `(${operand.emit(type)} ${negated ? 'NOT IN' : 'IN'} (${list}))`
    })
  }

  // ─── Функции ───────────────────────────────────────────────────────────────

  private call(name: string, argExprs: Expr[], pos: number, end: number): Typed {
    if (WINDOW_FUNCTIONS.has(name)) {
      throw new ExpressionError(
        `Оконная функция ${name}() недоступна в выражении`,
        pos,
        'Используйте шаг «Окно» (window)',
      )
    }
    if (AGGREGATES.has(name)) return this.aggregateCall(name, argExprs, pos, end)
    const args = argExprs.map((arg) => this.scalar(this.node(arg)))
    const span = { pos, end }
    const arity = (min: number, max = min) => {
      if (args.length < min || args.length > max) {
        const expected =
          min === max
            ? `${min}`
            : max === Number.POSITIVE_INFINITY
              ? `не меньше ${min}`
              : `${min}–${max}`
        throw new ExpressionError(
          `Функция ${name}() принимает аргументов: ${expected}, а передано: ${args.length}`,
          pos,
        )
      }
    }
    const arg = (index: number) => args[index] as Typed
    const num = (index: number) => this.expect(arg(index), 'number', 'число')
    const text = (index: number) => this.expect(arg(index), 'text', 'строка')
    const geom = (index: number) => this.expect(arg(index), 'geometry', 'геометрия')

    switch (name) {
      // ── числа
      case 'abs':
      case 'floor':
      case 'ceil':
      case 'ceiling': {
        arity(1)
        num(0)
        const fn = name === 'ceiling' ? 'ceil' : name
        return this.make('number', args, span, () => `${fn}(${arg(0).emit('number')})`)
      }
      case 'round': {
        arity(1, 2)
        num(0)
        if (args.length === 1)
          return this.make('number', args, span, () => `round(${arg(0).emit('number')})`)
        const digits = this.integerLiteral(arg(1), 'число знаков')
        return this.make(
          'number',
          args,
          span,
          () => `round(${arg(0).emit('number')}::numeric, ${digits})::double precision`,
        )
      }
      case 'coalesce':
      case 'greatest':
      case 'least': {
        arity(1, Number.POSITIVE_INFINITY)
        const type = this.unifyAll(args, `аргументы ${name}()`)
        if (name !== 'coalesce' && !isOrderable(type)) typeError('сравнимые значения', arg(0))
        return this.make(
          type,
          args,
          span,
          () => `${name}(${args.map((a) => a.emit(type)).join(', ')})`,
        )
      }
      case 'nullif': {
        arity(2)
        const type = this.comparable(arg(0), arg(1), pos)
        return this.make(
          type,
          args,
          span,
          () => `nullif(${arg(0).emit(type)}, ${arg(1).emit(type)})`,
        )
      }
      case 'safe_div': {
        arity(2)
        num(0)
        num(1)
        return this.make(
          'number',
          args,
          span,
          () =>
            `(${arg(0).emit('number')}::double precision / NULLIF(${arg(1).emit('number')}::double precision, 0))`,
        )
      }
      // ── строки
      case 'lower':
      case 'upper':
      case 'trim': {
        arity(1)
        text(0)
        return this.make('text', args, span, () => `${name}(${arg(0).emit('text')})`)
      }
      case 'length': {
        arity(1)
        text(0)
        return this.make('number', args, span, () => `char_length(${arg(0).emit('text')})`)
      }
      case 'substr': {
        arity(2, 3)
        text(0)
        num(1)
        if (args.length === 3) num(2)
        return this.make('text', args, span, () => {
          const start = `(${arg(1).emit('number')})::int`
          // Отрицательная длина в Postgres — ошибка; здесь — пустая строка
          const length = args.length === 3 ? `, greatest((${arg(2).emit('number')})::int, 0)` : ''
          return `substr(${arg(0).emit('text')}, ${start}${length})`
        })
      }
      case 'replace': {
        arity(3)
        text(0)
        text(1)
        text(2)
        return this.make(
          'text',
          args,
          span,
          () => `replace(${arg(0).emit('text')}, ${arg(1).emit('text')}, ${arg(2).emit('text')})`,
        )
      }
      case 'concat': {
        arity(1, Number.POSITIVE_INFINITY)
        for (const value of args) {
          if (value.type !== 'text' && value.type !== 'number' && value.type !== 'null') {
            typeError('строка или число', value, 'Для дат используйте format_date()')
          }
        }
        return this.make(
          'text',
          args,
          span,
          () => `concat(${args.map((a) => this.asText(a)).join(', ')})`,
        )
      }
      case 'split_part': {
        arity(3)
        text(0)
        text(1)
        num(2)
        // Номер части 0 в Postgres — ошибка; здесь — пусто
        return this.make(
          'text',
          args,
          span,
          () =>
            `split_part(${arg(0).emit('text')}, ${arg(1).emit('text')}, NULLIF((${arg(2).emit('number')})::int, 0))`,
        )
      }
      case 'regex_match': {
        arity(2)
        text(0)
        text(1)
        return this.make(
          'boolean',
          args,
          span,
          () => `(${this.d.regex(arg(0).emit('text'), arg(1).emit('text'), false)})`,
        )
      }
      case 'regex_extract': {
        arity(2)
        text(0)
        text(1)
        return this.make(
          'text',
          args,
          span,
          () => `substring(${arg(0).emit('text')} FROM ${arg(1).emit('text')})`,
        )
      }
      case 'starts_with': {
        arity(2)
        text(0)
        text(1)
        return this.make(
          'boolean',
          args,
          span,
          () => `starts_with(${arg(0).emit('text')}, ${arg(1).emit('text')})`,
        )
      }
      case 'contains': {
        arity(2)
        text(0)
        text(1)
        return this.make(
          'boolean',
          args,
          span,
          () => `(strpos(${arg(0).emit('text')}, ${arg(1).emit('text')}) > 0)`,
        )
      }
      // ── даты
      case 'now':
        arity(0)
        return this.make('datetime', args, span, () => this.env.now())
      case 'today':
        arity(0)
        return this.make('date', args, span, () =>
          this.d.localDate(this.env.now(), this.env.timezone()),
        )
      case 'date': {
        arity(1)
        const value = arg(0)
        if (value.literal?.kind === 'string') {
          return {
            type: 'date',
            aggregate: false,
            pos: span.pos,
            end: span.end,
            emit: (target) => this.convert(value.emit('date'), 'date', target ?? 'date'),
          }
        }
        if (value.type === 'date') return value
        if (value.type === 'datetime') {
          return this.make('date', args, span, () =>
            this.d.localDate(value.emit('datetime'), this.env.timezone()),
          )
        }
        if (value.type === 'text') {
          return this.make('date', args, span, () => this.d.tryCast(value.emit('text'), 'date'))
        }
        return typeError('дата, дата и время или строка', value)
      }
      case 'date_trunc': {
        arity(2)
        const unit = this.unitLiteral(arg(0), DATE_UNITS)
        const value = this.temporal(arg(1))
        if (value.type === 'date' && unit === 'hour') {
          throw new ExpressionError(
            'Дату нельзя усечь до часа',
            arg(1).pos,
            'Используйте дату и время',
          )
        }
        const temporal = value.type as 'date' | 'datetime'
        return this.make(temporal, args, span, () =>
          this.d.dateTrunc(unit, value.emit(temporal), temporal, () => this.env.timezone()),
        )
      }
      case 'date_add': {
        arity(3)
        const value = this.temporal(arg(0))
        num(1)
        const unit = this.unitLiteral(arg(2), INTERVAL_UNITS)
        if (value.type === 'date' && (unit === 'hour' || unit === 'minute')) {
          throw new ExpressionError(
            'К дате прибавляются дни и больше',
            arg(2).pos,
            'Для часов используйте дату и время',
          )
        }
        const temporal = value.type as 'date' | 'datetime'
        return this.make(temporal, args, span, () => {
          const interval = this.d.interval(unit, `(${arg(1).emit('number')})::int`)
          const sum = `(${value.emit(temporal)} + ${interval})`
          return temporal === 'date' ? `${sum}::date` : sum
        })
      }
      case 'date_diff': {
        arity(3)
        this.temporal(arg(0))
        this.temporal(arg(1))
        const unit = this.unitLiteral(arg(2), INTERVAL_UNITS)
        const both = arg(0).type === 'date' && arg(1).type === 'date'
        const type: ValueType = both ? 'date' : 'datetime'
        return this.make('number', args, span, () =>
          this.dateDiff(arg(0).emit(type), arg(1).emit(type), unit, both),
        )
      }
      case 'year':
      case 'quarter':
      case 'month':
      case 'week':
      case 'day':
      case 'dow':
      case 'hour': {
        arity(1)
        const value = this.temporal(arg(0))
        if (value.type === 'date' && name === 'hour') {
          throw new ExpressionError('У даты нет часа', arg(0).pos, 'Используйте дату и время')
        }
        const temporal = value.type as 'date' | 'datetime'
        return this.make('number', args, span, () =>
          this.d.datePart(name as DatePart, value.emit(temporal), temporal, () =>
            this.env.timezone(),
          ),
        )
      }
      case 'format_date': {
        arity(2)
        const value = this.temporal(arg(0))
        text(1)
        return this.make('text', args, span, () => {
          const source =
            value.type === 'date'
              ? value.emit('date')
              : `(${value.emit('datetime')} AT TIME ZONE ${this.env.timezone()})`
          return `to_char(${source}, ${arg(1).emit('text')})`
        })
      }
      case 'working_days_between':
      case 'add_working_days':
        throw new ExpressionError(
          `Функция ${name}() пока недоступна в запросах к данным`,
          pos,
          'Рабочие дни по производственному календарю появятся в запросах позже',
        )
      // ── условия
      case 'if': {
        arity(3)
        this.expect(arg(0), 'boolean', 'условие')
        const type = this.unifyAll([arg(1), arg(2)], 'ветки if()')
        return this.make(
          type,
          args,
          span,
          () =>
            `(CASE WHEN ${arg(0).emit('boolean')} THEN ${arg(1).emit(type)} ELSE ${arg(2).emit(type)} END)`,
        )
      }
      // ── гео
      case 'st_distance': {
        arity(2)
        geom(0)
        geom(1)
        return this.make(
          'number',
          args,
          span,
          () =>
            `ST_Distance(${this.d.geography(arg(0).emit('geometry'))}, ${this.d.geography(arg(1).emit('geometry'))})`,
        )
      }
      case 'st_within':
      case 'st_intersects': {
        arity(2)
        geom(0)
        geom(1)
        const fn = name === 'st_within' ? 'ST_Within' : 'ST_Intersects'
        return this.make(
          'boolean',
          args,
          span,
          () => `${fn}(${arg(0).emit('geometry')}, ${arg(1).emit('geometry')})`,
        )
      }
      case 'st_area':
        arity(1)
        geom(0)
        return this.make(
          'number',
          args,
          span,
          () => `(ST_Area(${this.d.geography(arg(0).emit('geometry'))}) / 1000000.0)`,
        )
      case 'st_length':
        arity(1)
        geom(0)
        return this.make(
          'number',
          args,
          span,
          () => `(ST_Length(${this.d.geography(arg(0).emit('geometry'))}) / 1000.0)`,
        )
      case 'st_buffer':
        arity(2)
        geom(0)
        num(1)
        return this.make(
          'geometry',
          args,
          span,
          () =>
            `ST_Buffer(${this.d.geography(arg(0).emit('geometry'))}, ${arg(1).emit('number')})::geometry`,
        )
      case 'st_centroid':
        arity(1)
        geom(0)
        return this.make('geometry', args, span, () => `ST_Centroid(${arg(0).emit('geometry')})`)
      case 'st_x':
      case 'st_y':
        arity(1)
        geom(0)
        return this.make(
          'number',
          args,
          span,
          () => `${name === 'st_x' ? 'ST_X' : 'ST_Y'}(${arg(0).emit('geometry')})`,
        )
      case 'st_point':
        arity(2)
        num(0)
        num(1)
        return this.make(
          'geometry',
          args,
          span,
          () =>
            `ST_SetSRID(ST_MakePoint(${arg(0).emit('number')}, ${arg(1).emit('number')}), 4326)`,
        )
      // ── справочники и пользователь
      case 'territory_level': {
        arity(2)
        const key = this.territoryKey(arg(0), name)
        const level = this.levelLiteral(arg(1))
        const map = this.reference({ kind: 'territory_level', level, key }, pos)
        if (key === 'code') {
          return this.make('text', args, span, () => `(${map} ->> ${arg(0).emit('text')})`)
        }
        // Предок — тоже территория: подписи и фильтры работают с ним, как с полем
        return {
          ...this.make(
            'uuid',
            args,
            span,
            () => `((${map} ->> (${arg(0).emit('uuid')})::text)::uuid)`,
          ),
          fieldType: 'territory',
        }
      }
      case 'territory_name': {
        arity(1)
        const key = this.territoryKey(arg(0), name)
        const map = this.reference({ kind: 'territory_name', key }, pos)
        const value = () =>
          key === 'code' ? arg(0).emit('text') : `(${arg(0).emit('uuid')})::text`
        return this.make('text', args, span, () => `(${map} ->> ${value()})`)
      }
      case 'lookup_label': {
        arity(1)
        const field = arg(0)
        if (!field.lookup) {
          throw new ExpressionError(
            'lookup_label() принимает поле, связанное со справочником',
            field.pos,
            'Связь поля со справочником задаётся на вкладке «Схема» датасета',
          )
        }
        const map = this.reference({ kind: 'lookup_label', ...field.lookup }, pos)
        return this.make('text', args, span, () => `(${map} ->> (${field.emit()})::text)`)
      }
      case 'user_attr': {
        arity(1)
        const key = arg(0)
        if (key.literal?.kind !== 'string') {
          throw new ExpressionError(
            'Имя атрибута пишется строкой',
            key.pos,
            "Например, user_attr('territory_codes')",
          )
        }
        return this.value(
          this.env.userAttr(key.literal.value as string, key.pos),
          span,
          `user_attr('${key.literal.value}')`,
        )
      }
      default:
        throw new ExpressionError(`Неизвестная функция ${name}()`, pos, 'Проверьте имя функции')
    }
  }

  private aggregateCall(name: string, argExprs: Expr[], pos: number, end: number): Typed {
    if (this.env.mode !== 'aggregate') {
      throw new ExpressionError(
        `Агрегат ${name}() допустим только в мере сводки`,
        pos,
        'Добавьте шаг «Сводка» (aggregate) и опишите меру там',
      )
    }
    if (this.aggregateDepth > 0) {
      throw new ExpressionError(`Агрегат ${name}() нельзя вкладывать в другой агрегат`, pos)
    }
    this.aggregateDepth++
    const args = argExprs.map((arg) => this.scalar(this.node(arg)))
    this.aggregateDepth--
    const span = { pos, end }
    const arg = (index: number) => args[index] as Typed
    const arity = (min: number, max = min) => {
      if (args.length < min || args.length > max) {
        throw new ExpressionError(
          `Функция ${name}() принимает аргументов: ${min === max ? min : `${min}–${max}`}`,
          pos,
        )
      }
    }
    const filter = this.env.aggregateFilter
    const result = (type: ValueType, emit: () => string, fieldType?: FieldType): Typed => ({
      ...this.make(type, args, span, filter ? () => `${emit()} FILTER (WHERE ${filter})` : emit),
      aggregate: true,
      ...(fieldType ? { fieldType } : {}),
    })
    switch (name) {
      case 'count':
        arity(0, 1)
        return result(
          'number',
          () => (args.length ? `count(${arg(0).emit()})` : 'count(*)'),
          'integer',
        )
      case 'count_distinct':
        arity(1)
        return result('number', () => `count(DISTINCT ${arg(0).emit()})`, 'integer')
      case 'sum':
      case 'avg':
        arity(1)
        this.expect(arg(0), 'number', 'число')
        return result('number', () => `${name}(${arg(0).emit('number')})`)
      case 'min':
      case 'max': {
        arity(1)
        if (!isOrderable(arg(0).type)) typeError('сравнимое значение', arg(0))
        const type = arg(0).type
        return result(type, () => `${name}(${arg(0).emit(type)})`, arg(0).fieldType)
      }
      case 'median':
        arity(1)
        this.expect(arg(0), 'number', 'число')
        return result('number', () => this.d.percentile(0.5, arg(0).emit('number')))
      case 'percentile': {
        arity(2)
        this.expect(arg(0), 'number', 'число')
        const p = arg(1).literal?.kind === 'number' ? (arg(1).literal?.value as number) : Number.NaN
        if (!(p >= 0 && p <= 1)) {
          throw new ExpressionError(
            'Доля перцентиля — число от 0 до 1',
            arg(1).pos,
            'Например, percentile(x, 0.9)',
          )
        }
        return result('number', () => this.d.percentile(p, arg(0).emit('number')))
      }
      case 'string_agg': {
        arity(2)
        this.expect(arg(1), 'text', 'разделитель-строка')
        return result('text', () => `string_agg((${arg(0).emit()})::text, ${arg(1).emit('text')})`)
      }
      default:
        throw new ExpressionError(`Неизвестный агрегат ${name}()`, pos)
    }
  }

  private dateDiff(a: string, b: string, unit: IntervalUnit, dates: boolean): string {
    const seconds = `extract(epoch FROM (${b} - ${a}))`
    switch (unit) {
      case 'minute':
        return `trunc(${dates ? `(${b} - ${a}) * 1440` : `${seconds} / 60`})::int`
      case 'hour':
        return `trunc(${dates ? `(${b} - ${a}) * 24` : `${seconds} / 3600`})::int`
      case 'day':
        return dates ? `(${b} - ${a})` : `trunc(${seconds} / 86400)::int`
      case 'week':
        return dates ? `trunc((${b} - ${a}) / 7.0)::int` : `trunc(${seconds} / 604800)::int`
      case 'month':
      case 'quarter':
      case 'year': {
        const age = `age(${b}, ${a})`
        const months = `(extract(year FROM ${age}) * 12 + extract(month FROM ${age}))`
        if (unit === 'month') return `${months}::int`
        if (unit === 'quarter') return `trunc(${months} / 3)::int`
        return `extract(year FROM ${age})::int`
      }
    }
  }

  // ─── Помощники ─────────────────────────────────────────────────────────────

  private make(
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
  private convert(sql: string, from: ValueType, to: ValueType): string {
    if (from === to || to === 'null') return sql
    if (from === 'null') return `${sql}::${sqlTypeOfValue(to)}`
    if (from === 'date' && to === 'datetime') {
      // Дата — полночь в поясе запроса
      return `(${sql}::timestamp AT TIME ZONE ${this.env.timezone()})`
    }
    if (from === 'text' && to === 'uuid') return this.d.tryCast(sql, 'uuid')
    return sql
  }

  private scalar(value: Typed): Typed {
    if (value.array) {
      throw new ExpressionError('Список значений допустим только внутри in (…)', value.pos)
    }
    return value
  }

  private expect(value: Typed, type: ValueType, label: string): Typed {
    if (value.type === type || value.type === 'null') return value
    if (value.literal?.kind === 'string' && ['date', 'datetime', 'time', 'uuid'].includes(type))
      return value
    return typeError(label, value)
  }

  private temporal(value: Typed): Typed {
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
  private unifyAll(values: Typed[], what: string): ValueType {
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

  private integerLiteral(value: Typed, what: string): number {
    const number = value.literal?.kind === 'number' ? (value.literal.value as number) : Number.NaN
    if (!Number.isInteger(number) || number < -10 || number > 12) {
      throw new ExpressionError(`${what}: целое число от −10 до 12`, value.pos)
    }
    return number
  }

  /** Подстановка справочной функции; окружение без справочников — понятная ошибка. */
  private reference(request: ReferenceRequest, pos: number): string {
    if (!this.env.reference) {
      throw new ExpressionError('Справочные функции в этом выражении недоступны', pos)
    }
    return this.env.reference(request)
  }

  /** Аргумент территориальной функции: поле-территория (идентификатор) или код текстом. */
  private territoryKey(value: Typed, name: string): 'id' | 'code' {
    if (value.type === 'uuid' && value.fieldType === 'territory') return 'id'
    if (value.type === 'text') return 'code'
    throw new ExpressionError(
      `${name}() принимает территорию или код территории, а получено: ${VALUE_TYPE_LABELS[value.type]}`,
      value.pos,
      "Например, territory_level(district, 'region')",
    )
  }

  private levelLiteral(value: Typed): TerritoryLevel {
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

  private unitLiteral<T extends string>(value: Typed, allowed: readonly T[]): T {
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

function inferType(value: unknown): ValueType {
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
function serialize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return JSON.stringify(value)
  return value
}
