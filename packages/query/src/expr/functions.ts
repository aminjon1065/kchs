import type { FieldType } from '@kchs/contracts'
import { ExpressionError } from '../errors.js'
import { isOrderable, type ValueType } from '../value-types.js'
import type { Expr } from './ast.js'
import { type CallArgs, unknownFunction } from './functions/args.js'
import { DATE_FUNCTIONS } from './functions/dates.js'
import { GEO_FUNCTIONS } from './functions/geo.js'
import { REFERENCE_FUNCTIONS, ReferenceFunctions } from './functions/references.js'
import {
  CAST_FUNCTIONS,
  CONDITION_FUNCTIONS,
  NUMBER_FUNCTIONS,
  TEXT_FUNCTIONS,
} from './functions/scalar.js'
import { AGGREGATES, type Typed, typeError, WINDOW_FUNCTIONS } from './typed.js'

type FunctionGroup = 'number' | 'text' | 'date' | 'condition' | 'geo' | 'reference' | 'cast'

/**
 * Функция выражения → её группа. Обработчик группы — метод своего слоя (`functions/`):
 * числа, строки, условие и приведение — 3а, даты — 3б, геометрия — 3в, справочники — 3г.
 */
const FUNCTION_GROUP = new Map<string, FunctionGroup>([
  ...NUMBER_FUNCTIONS.map((name) => [name, 'number'] as const),
  ...TEXT_FUNCTIONS.map((name) => [name, 'text'] as const),
  ...DATE_FUNCTIONS.map((name) => [name, 'date'] as const),
  ...CONDITION_FUNCTIONS.map((name) => [name, 'condition'] as const),
  ...GEO_FUNCTIONS.map((name) => [name, 'geo'] as const),
  ...REFERENCE_FUNCTIONS.map((name) => [name, 'reference'] as const),
  ...CAST_FUNCTIONS.map((name) => [name, 'cast'] as const),
])

/** Слой 3: функции выражений и агрегаты (contracts/expression-language.md). */
export abstract class FunctionCompiler extends ReferenceFunctions {
  protected call(name: string, argExprs: Expr[], pos: number, end: number): Typed {
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
    const c: CallArgs = { name, args, span, pos, arity, arg, num, text, geom }
    switch (FUNCTION_GROUP.get(name)) {
      case 'number':
        return this.numberCall(c)
      case 'text':
        return this.textCall(c)
      case 'date':
        return this.dateCall(c)
      case 'condition':
        return this.conditionCall(c)
      case 'geo':
        return this.geoCall(c)
      case 'reference':
        return this.referenceCall(c)
      case 'cast':
        return this.castCall(c)
      default:
        throw unknownFunction(name, pos)
    }
  }

  protected aggregateCall(name: string, argExprs: Expr[], pos: number, end: number): Typed {
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
}
