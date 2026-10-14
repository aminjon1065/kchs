import { ExpressionError } from '../../errors.js'
import { isOrderable } from '../../value-types.js'
import { OperatorCompiler } from '../operators.js'
import { CAST_TARGETS, type CastTarget, type Typed, typeError } from '../typed.js'
import { type CallArgs, unknownFunction } from './args.js'

export const NUMBER_FUNCTIONS = [
  'abs',
  'floor',
  'ceil',
  'ceiling',
  'round',
  'coalesce',
  'greatest',
  'least',
  'nullif',
  'safe_div',
] as const
export const TEXT_FUNCTIONS = [
  'lower',
  'upper',
  'trim',
  'length',
  'substr',
  'replace',
  'concat',
  'split_part',
  'regex_match',
  'regex_extract',
  'starts_with',
  'contains',
] as const
export const CONDITION_FUNCTIONS = ['if'] as const
export const CAST_FUNCTIONS = ['cast'] as const

/** Слой 3а: функции чисел, строк, условия и приведение типа (contracts/expression-language.md). */
export abstract class ScalarFunctions extends OperatorCompiler {
  protected numberCall(c: CallArgs): Typed {
    const { name, args, span, pos, arity, arg, num } = c
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
        return this.make('number', args, span, () =>
          this.d.cast(
            `round(${this.d.cast(arg(0).emit('number'), 'numeric')}, ${digits})`,
            'double precision',
          ),
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
      default:
        throw unknownFunction(name, pos)
    }
  }

  protected textCall(c: CallArgs): Typed {
    const { name, args, span, pos, arity, arg, num, text } = c
    switch (name) {
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
      default:
        throw unknownFunction(name, pos)
    }
  }

  protected conditionCall(c: CallArgs): Typed {
    const { name, args, span, pos, arity, arg } = c
    switch (name) {
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
      default:
        throw unknownFunction(name, pos)
    }
  }

  protected castCall(c: CallArgs): Typed {
    const { name, args, span, pos, arity, arg } = c
    switch (name) {
      /**
       * Приведение типа (ADR-0106): `cast(x, 'number')`. Значение, которое не
       * приводится, становится пустым — шаг пайплайна не должен падать из-за
       * одной строки. Целевой тип — строковый литерал.
       */
      case 'cast': {
        arity(2)
        const target = arg(1)
        if (target.literal?.kind !== 'string') {
          throw new ExpressionError(
            'Тип пишется строкой',
            target.pos,
            "Например, cast(x, 'number')",
          )
        }
        const to = String(target.literal.value).toLowerCase()
        if (!CAST_TARGETS.has(to)) {
          throw new ExpressionError(
            `Приведение к «${to}» не поддерживается`,
            target.pos,
            `Возможные типы: ${[...CAST_TARGETS].join(', ')}`,
          )
        }
        const value = arg(0)
        const type = to as CastTarget
        if (value.type === type || value.type === 'null') {
          return this.make(type, args, span, () => value.emit(type))
        }
        return this.make(type, args, span, () => this.castSql(value, type))
      }
      default:
        throw unknownFunction(name, pos)
    }
  }
}
