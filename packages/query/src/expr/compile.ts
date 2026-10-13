import { ExpressionError } from '../errors.js'
import { VALUE_TYPE_LABELS } from '../value-types.js'
import type { Expr } from './ast.js'
import type { CompiledExpr, ExprEnv } from './env.js'
import { FunctionCompiler } from './functions.js'
import { parseExpression } from './parser.js'
import type { Typed } from './typed.js'

export type { CompiledExpr, ExprEnv, ExprField, ExprValue } from './env.js'

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

class ExprCompiler extends FunctionCompiler {
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
      case 'path':
        throw new ExpressionError(
          `Составная ссылка «${expr.segments.join('.')}» в запросе недоступна`,
          expr.pos,
          'Поле пишется как «поле» или «псевдоним.поле»',
        )
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
}
