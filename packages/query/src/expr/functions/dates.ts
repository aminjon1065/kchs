import type { DatePart, IntervalUnit } from '../../dialect.js'
import { ExpressionError } from '../../errors.js'
import type { ValueType } from '../../value-types.js'
import { DATE_UNITS, INTERVAL_UNITS, type Typed, typeError } from '../typed.js'
import { type CallArgs, unknownFunction } from './args.js'
import { ScalarFunctions } from './scalar.js'

export const DATE_FUNCTIONS = [
  'now',
  'today',
  'date',
  'date_trunc',
  'date_add',
  'date_diff',
  'year',
  'quarter',
  'month',
  'week',
  'day',
  'dow',
  'hour',
  'format_date',
  'working_days_between',
  'add_working_days',
] as const

/** Слой 3б: функции дат. */
export abstract class DateFunctions extends ScalarFunctions {
  protected dateCall(c: CallArgs): Typed {
    const { name, args, span, pos, arity, arg, num, text } = c
    switch (name) {
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
      default:
        throw unknownFunction(name, pos)
    }
  }

  protected dateDiff(a: string, b: string, unit: IntervalUnit, dates: boolean): string {
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
}
