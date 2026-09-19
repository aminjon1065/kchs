import { ExpressionError } from '../errors.js'
import type { BinaryOp, Expr } from './ast.js'
import { parseExpression } from './parser.js'

/**
 * Вычисление выражения над данными в памяти — условия маршрутов процессов
 * (contracts/process-definition.md: `object.fields.amount > 1000000`) и правил
 * автоматизации. Тот же язык и тот же разборщик, что у запросов; значения —
 * по правилам SQL: `null` поглощает сравнения и арифметику, `and`/`or`
 * трёхзначные, условие выполнено только при строгом `true`.
 *
 * Функций меньше, чем у компилятора запросов: здесь нет полей датасета,
 * агрегатов, геометрии и справочников — только строки, числа и даты.
 */
export interface EvalScope {
  /** Значение ссылки по частям пути: `object.fields.amount` → `['object', 'fields', 'amount']`. */
  resolve(path: readonly string[]): unknown
  /** «Сейчас» для `now()`, `@now`, `today()`; по умолчанию — часы процесса. */
  now?: () => Date
  /** Пояс для `today()` и `@today`; по умолчанию — UTC. */
  timezone?: string
}

/** Функции, доступные при вычислении в памяти. */
export const EVALUABLE_FUNCTIONS: ReadonlySet<string> = new Set([
  'abs',
  'floor',
  'ceil',
  'ceiling',
  'round',
  'coalesce',
  'greatest',
  'least',
  'nullif',
  'lower',
  'upper',
  'trim',
  'length',
  'substr',
  'replace',
  'concat',
  'starts_with',
  'contains',
  'if',
  'now',
  'today',
  'year',
  'month',
  'day',
  'date',
])

const EVALUABLE_MACROS = new Set(['today', 'now'])

/** Значение выражения; ссылка без значения — `null`. */
export function evaluateExpression(source: string | Expr, scope: EvalScope): unknown {
  const tree = typeof source === 'string' ? parseExpression(source) : source
  return new Evaluator(scope).node(tree)
}

/** Условие: выполнено только при строгом `true` (как `WHERE` в SQL). */
export function evaluateCondition(source: string | Expr, scope: EvalScope): boolean {
  return evaluateExpression(source, scope) === true
}

/**
 * Проверка без вычисления: выражение разбирается, ссылки начинаются с
 * допустимых корней (`object`, `var`…), функции и макросы вычислимы в памяти.
 * Возвращает первую ошибку с позицией или `null`.
 */
export function checkEvaluable(source: string, roots: readonly string[]): ExpressionError | null {
  let tree: Expr
  try {
    tree = parseExpression(source)
  } catch (error) {
    if (error instanceof ExpressionError) return error
    throw error
  }
  const allowed = new Set(roots)
  const hint = `Доступны: ${roots.join(', ')}`
  let problem: ExpressionError | null = null
  walk(tree, (node) => {
    if (problem) return
    if (node.kind === 'field' || node.kind === 'path') {
      const head = node.kind === 'field' ? (node.qualifier ?? node.name) : node.segments[0]
      if (!head || !allowed.has(head)) {
        problem = new ExpressionError(`Неизвестное имя «${head ?? ''}»`, node.pos, hint)
      }
    } else if (node.kind === 'call' && !EVALUABLE_FUNCTIONS.has(node.name)) {
      problem = new ExpressionError(`Функция «${node.name}» здесь недоступна`, node.pos)
    } else if (node.kind === 'macro' && !EVALUABLE_MACROS.has(node.name)) {
      problem = new ExpressionError(`Макрос «@${node.name}» здесь недоступен`, node.pos)
    } else if (node.kind === 'param') {
      problem = new ExpressionError('Параметры запроса здесь недоступны', node.pos)
    }
  })
  return problem
}

/** Обход дерева в глубину: узел, затем его части. */
function walk(expr: Expr, visit: (node: Expr) => void): void {
  visit(expr)
  switch (expr.kind) {
    case 'unary':
      walk(expr.operand, visit)
      break
    case 'binary':
      walk(expr.left, visit)
      walk(expr.right, visit)
      break
    case 'in':
      walk(expr.operand, visit)
      for (const item of expr.list) walk(item, visit)
      break
    case 'isnull':
      walk(expr.operand, visit)
      break
    case 'like':
      walk(expr.operand, visit)
      walk(expr.pattern, visit)
      break
    case 'call':
      for (const arg of expr.args) walk(arg, visit)
      break
    case 'case':
      for (const branch of expr.branches) {
        walk(branch.when, visit)
        walk(branch.result, visit)
      }
      if (expr.otherwise) walk(expr.otherwise, visit)
      break
    default:
      break
  }
}

type Value = null | boolean | number | string | Value[] | { [key: string]: unknown }

const NUMERIC = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

function normalize(value: unknown): Value {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'object') return value as { [key: string]: unknown }
  return null
}

function asNumber(value: Value): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && NUMERIC.test(value.trim())) return Number(value)
  return null
}

function asText(value: Value): string | null {
  if (value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** Сравнение по правилам SQL: `null` — неизвестно; число со строкой-числом сравнимы. */
function compare(left: Value, right: Value): number | null {
  if (left === null || right === null) return null
  if (typeof left === 'number' || typeof right === 'number') {
    const a = asNumber(left)
    const b = asNumber(right)
    if (a === null || b === null) return null
    return a === b ? 0 : a < b ? -1 : 1
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return left === right ? 0 : left ? 1 : -1
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left === right ? 0 : left < right ? -1 : 1
  }
  return JSON.stringify(left) === JSON.stringify(right) ? 0 : null
}

function likeRegex(pattern: string): RegExp {
  let source = ''
  for (const char of pattern) {
    if (char === '%') source += '[\\s\\S]*'
    else if (char === '_') source += '[\\s\\S]'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'u')
}

/** Дата `ГГГГ-ММ-ДД` для строки даты или момента; иное — `null`. */
function datePart(value: Value): { y: number; m: number; d: number } | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return null
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
}

function localDay(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

class Evaluator {
  constructor(private readonly scope: EvalScope) {}

  private now(): Date {
    return this.scope.now?.() ?? new Date()
  }

  private today(): string {
    return localDay(this.now(), this.scope.timezone ?? 'UTC')
  }

  node(expr: Expr): Value {
    switch (expr.kind) {
      case 'number':
      case 'string':
      case 'boolean':
        return expr.value
      case 'null':
        return null
      case 'field':
        return normalize(
          this.scope.resolve(expr.qualifier === null ? [expr.name] : [expr.qualifier, expr.name]),
        )
      case 'path':
        return normalize(this.scope.resolve(expr.segments))
      case 'param':
        throw new ExpressionError('Параметры запроса здесь недоступны', expr.pos)
      case 'macro':
        if (expr.name === 'today') return this.today()
        if (expr.name === 'now') return this.now().toISOString()
        throw new ExpressionError(`Макрос «@${expr.name}» здесь недоступен`, expr.pos)
      case 'unary':
        return this.unary(expr.op, this.node(expr.operand))
      case 'binary':
        return this.binary(expr.op, expr.left, expr.right)
      case 'in':
        return this.inList(expr.operand, expr.list, expr.negated)
      case 'isnull': {
        const value = this.node(expr.operand)
        return expr.negated ? value !== null : value === null
      }
      case 'like': {
        const operand = asText(this.node(expr.operand))
        const pattern = asText(this.node(expr.pattern))
        if (operand === null || pattern === null) return null
        const matched = likeRegex(pattern).test(operand)
        return expr.negated ? !matched : matched
      }
      case 'case': {
        for (const branch of expr.branches) {
          if (this.node(branch.when) === true) return this.node(branch.result)
        }
        return expr.otherwise ? this.node(expr.otherwise) : null
      }
      case 'call':
        return this.call(expr.name, expr.args, expr.pos)
    }
  }

  private unary(op: '-' | '+' | 'not', value: Value): Value {
    if (op === 'not') return value === null ? null : typeof value === 'boolean' ? !value : null
    const number = asNumber(value)
    if (number === null) return null
    return op === '-' ? -number : number
  }

  private binary(op: BinaryOp, leftExpr: Expr, rightExpr: Expr): Value {
    if (op === 'and' || op === 'or') {
      const left = this.node(leftExpr)
      // Короткое замыкание, как в SQL: ложь в and и истина в or решают сразу
      if (op === 'and' && left === false) return false
      if (op === 'or' && left === true) return true
      const right = this.node(rightExpr)
      const truth = (value: Value) => (typeof value === 'boolean' ? value : null)
      const a = truth(left)
      const b = truth(right)
      if (op === 'and') {
        if (a === false || b === false) return false
        return a === null || b === null ? null : true
      }
      if (a === true || b === true) return true
      return a === null || b === null ? null : false
    }
    const left = this.node(leftExpr)
    const right = this.node(rightExpr)
    switch (op) {
      case '=':
      case '!=':
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const order = compare(left, right)
        if (order === null) return null
        if (op === '=') return order === 0
        if (op === '!=') return order !== 0
        if (op === '<') return order < 0
        if (op === '<=') return order <= 0
        if (op === '>') return order > 0
        return order >= 0
      }
      case '||': {
        const a = asText(left)
        const b = asText(right)
        return a === null || b === null ? null : a + b
      }
      default: {
        const a = asNumber(left)
        const b = asNumber(right)
        if (a === null || b === null) return null
        if (op === '+') return a + b
        if (op === '-') return a - b
        if (op === '*') return a * b
        if (b === 0) return null
        return op === '/' ? a / b : a % b
      }
    }
  }

  private inList(operandExpr: Expr, list: Expr[], negated: boolean): Value {
    const operand = this.node(operandExpr)
    if (operand === null) return null
    // Значение-массив (множественный выбор, список пользователей) раскрывается
    const values = list.flatMap((item) => {
      const value = this.node(item)
      return Array.isArray(value) ? value : [value]
    })
    let unknown = false
    for (const value of values) {
      const order = compare(operand, value)
      if (order === 0) return !negated
      if (order === null) unknown = true
    }
    if (unknown) return null
    return negated
  }

  private call(name: string, argExprs: Expr[], pos: number): Value {
    const args = () => argExprs.map((arg) => this.node(arg))
    const arity = (min: number, max = min) => {
      if (argExprs.length < min || argExprs.length > max) {
        throw new ExpressionError(
          min === max
            ? `У функции ${name} аргументов должно быть ${min}`
            : `У функции ${name} аргументов должно быть от ${min} до ${max}`,
          pos,
        )
      }
    }
    switch (name) {
      case 'abs':
      case 'floor':
      case 'ceil':
      case 'ceiling': {
        arity(1)
        const value = asNumber(args()[0] ?? null)
        if (value === null) return null
        if (name === 'abs') return Math.abs(value)
        return name === 'floor' ? Math.floor(value) : Math.ceil(value)
      }
      case 'round': {
        arity(1, 2)
        const [value, digits] = args().map((arg) => asNumber(arg))
        if (value === null || value === undefined) return null
        const factor = 10 ** Math.trunc(digits ?? 0)
        return Math.round(value * factor) / factor
      }
      case 'coalesce':
        return args().find((value) => value !== null) ?? null
      case 'greatest':
      case 'least': {
        const values = args().filter((value) => value !== null)
        if (values.length === 0) return null
        return values.reduce((best, value) => {
          const order = compare(value, best)
          if (order === null) return best
          return name === 'greatest' ? (order > 0 ? value : best) : order < 0 ? value : best
        })
      }
      case 'nullif': {
        arity(2)
        const [a = null, b = null] = args()
        return compare(a, b) === 0 ? null : a
      }
      case 'lower':
      case 'upper':
      case 'trim': {
        arity(1)
        const text = asText(args()[0] ?? null)
        if (text === null) return null
        if (name === 'lower') return text.toLowerCase()
        return name === 'upper' ? text.toUpperCase() : text.trim()
      }
      case 'length': {
        arity(1)
        const value = args()[0] ?? null
        if (Array.isArray(value)) return value.length
        const text = asText(value)
        return text === null ? null : [...text].length
      }
      case 'substr': {
        arity(2, 3)
        const [value, start, length] = args()
        const text = asText(value ?? null)
        const from = asNumber(start ?? null)
        if (text === null || from === null) return null
        const chars = [...text]
        const begin = Math.max(0, Math.trunc(from) - 1)
        const count = length === undefined ? undefined : asNumber(length)
        if (count === null) return null
        return chars.slice(begin, count === undefined ? undefined : begin + count).join('')
      }
      case 'replace': {
        arity(3)
        const [value, from, to] = args().map((arg) => asText(arg))
        if (value == null || from == null || to == null) return null
        return from === '' ? value : value.split(from).join(to)
      }
      case 'concat':
        return args()
          .map((value) => asText(value) ?? '')
          .join('')
      case 'starts_with': {
        arity(2)
        const [value, prefix] = args().map((arg) => asText(arg))
        if (value == null || prefix == null) return null
        return value.startsWith(prefix)
      }
      case 'contains': {
        arity(2)
        const [haystack = null, needle = null] = args()
        if (haystack === null || needle === null) return null
        if (Array.isArray(haystack)) return haystack.some((item) => compare(item, needle) === 0)
        const text = asText(haystack)
        const part = asText(needle)
        return text === null || part === null ? null : text.includes(part)
      }
      case 'if': {
        arity(3)
        return this.node(argExprs[0] as Expr) === true
          ? this.node(argExprs[1] as Expr)
          : this.node(argExprs[2] as Expr)
      }
      case 'now':
        arity(0)
        return this.now().toISOString()
      case 'today':
        arity(0)
        return this.today()
      case 'year':
      case 'month':
      case 'day': {
        arity(1)
        const parts = datePart(args()[0] ?? null)
        if (!parts) return null
        return name === 'year' ? parts.y : name === 'month' ? parts.m : parts.d
      }
      case 'date': {
        arity(1)
        const value = args()[0] ?? null
        if (typeof value !== 'string') return null
        // Момент со временем — календарная дата в поясе вычисления
        if (value.length > 10 && !Number.isNaN(Date.parse(value))) {
          return localDay(new Date(value), this.scope.timezone ?? 'UTC')
        }
        return datePart(value) ? value.slice(0, 10) : null
      }
      default:
        throw new ExpressionError(`Функция «${name}» здесь недоступна`, pos)
    }
  }
}
