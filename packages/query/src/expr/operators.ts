import { ExpressionError } from '../errors.js'
import {
  isOrderable,
  sqlTypeOfValue,
  unify,
  VALUE_TYPE_LABELS,
  type ValueType,
} from '../value-types.js'
import type { Expr } from './ast.js'
import { ExprCompilerCore } from './core.js'
import { serialize, type Typed, typeError } from './typed.js'

/** Слой 2: унарные и бинарные операторы, сравнения, `in (…)`. */
export abstract class OperatorCompiler extends ExprCompilerCore {
  protected abstract call(name: string, argExprs: Expr[], pos: number, end: number): Typed

  protected unary(op: '-' | '+' | 'not', operandExpr: Expr, pos: number, end: number): Typed {
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

  protected binary(expr: Extract<Expr, { kind: 'binary' }>): Typed {
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
        return this.make('number', [left, right], span, () =>
          this.d.cast(
            `mod(${this.d.cast(left.emit('number'), 'numeric')}, NULLIF(${this.d.cast(right.emit('number'), 'numeric')}, 0))`,
            'double precision',
          ),
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

  protected arithmetic(left: Typed, right: Typed, op: string, pos: number): void {
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

  protected asText(value: Typed): string {
    if (value.type === 'number') return `${value.emit('number')}::text`
    return value.emit('text')
  }

  protected comparable(left: Typed, right: Typed, pos: number): ValueType {
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
  protected flexible(value: Typed, other: Typed): ValueType {
    if (
      value.literal?.kind === 'string' &&
      ['date', 'datetime', 'time', 'uuid'].includes(other.type)
    ) {
      return other.type
    }
    return value.type
  }

  protected inList(
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
}
