import type { FieldType } from '@kchs/contracts'
import type { DatePart, IntervalUnit } from '../dialect.js'
import { ExpressionError } from '../errors.js'
import { isOrderable, type ValueType } from '../value-types.js'
import type { Expr } from './ast.js'
import { OperatorCompiler } from './operators.js'
import {
  AGGREGATES,
  CAST_TARGETS,
  type CastTarget,
  DATE_UNITS,
  INTERVAL_UNITS,
  type Typed,
  typeError,
  WINDOW_FUNCTIONS,
} from './typed.js'

/** Слой 3: функции выражений и агрегаты (contracts/expression-language.md). */
export abstract class FunctionCompiler extends OperatorCompiler {
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
            () =>
              `(${this.d.cast(`(${map} ->> ${this.d.cast(`(${arg(0).emit('uuid')})`, 'text')})`, 'uuid')})`,
          ),
          fieldType: 'territory',
        }
      }
      case 'territory_name': {
        arity(1)
        const key = this.territoryKey(arg(0), name)
        const map = this.reference({ kind: 'territory_name', key }, pos)
        const value = () =>
          key === 'code' ? arg(0).emit('text') : this.d.cast(`(${arg(0).emit('uuid')})`, 'text')
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
        return this.make(
          'text',
          args,
          span,
          () => `(${map} ->> ${this.d.cast(`(${field.emit()})`, 'text')})`,
        )
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
        throw new ExpressionError(`Неизвестная функция ${name}()`, pos, 'Проверьте имя функции')
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
