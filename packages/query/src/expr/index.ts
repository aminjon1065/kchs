/**
 * `@kchs/query/expr` — язык выражений без компилятора запросов: разбор,
 * проверка и вычисление над данными в памяти. Не тянет разборщик SQL
 * (libpg-query), поэтому пригоден и для браузера, и для чистых пакетов
 * (`@kchs/process`: условия маршрутов).
 */
export { ExpressionError } from '../errors.js'
export type { BinaryOp, Expr } from './ast.js'
export {
  checkEvaluable,
  EVALUABLE_FUNCTIONS,
  type EvalScope,
  evaluateCondition,
  evaluateExpression,
} from './evaluate.js'
export { MAX_EXPRESSION_LENGTH, parseExpression } from './parser.js'
