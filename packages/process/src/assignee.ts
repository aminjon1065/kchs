/**
 * Выражения назначений (contracts/process-definition.md): `user:<id>`,
 * `group:<id>`, `unit:<id>`, `unit_head(<подразделение>)`, `manager(<люди>)`,
 * `role:<ключ>`, `role_in_space:<ключ>`, `var:<имя>`, `field:<путь>`,
 * `author`, `author.unit`, `initiator`, `chosen_by_initiator`,
 * `previous_step.assignees`, `step.assignee` (только в таймерах). Функции
 * вкладываются: `manager(unit_head(author.unit))`. Запись через вызов из
 * 02-platform-kernel.md — `role_in_space('legal')`, `field('responsible')` —
 * равнозначна записи через двоеточие; `unit_head('FIN')` — подразделение по коду.
 *
 * Выражение даёт либо людей, либо подразделение: `unit_head` ждёт
 * подразделение, `manager` — людей; подразделение на месте людей — его
 * сотрудники (с вложенными подразделениями).
 */
export type AssigneeExpr =
  | { kind: 'user'; id: string; pos: number }
  | { kind: 'group'; id: string; pos: number }
  | { kind: 'unit'; id: string; pos: number }
  | { kind: 'unit_code'; code: string; pos: number }
  | { kind: 'role'; key: string; pos: number }
  | { kind: 'role_in_space'; key: string; pos: number }
  | { kind: 'var'; name: string; pos: number }
  | { kind: 'field'; path: string[]; pos: number }
  | { kind: 'author'; pos: number }
  | { kind: 'author_unit'; pos: number }
  | { kind: 'initiator'; pos: number }
  | { kind: 'chosen_by_initiator'; pos: number }
  | { kind: 'previous_step'; pos: number }
  | { kind: 'step_assignees'; pos: number }
  | { kind: 'unit_head'; unit: AssigneeExpr; pos: number }
  | { kind: 'manager'; of: AssigneeExpr; pos: number }

export class AssigneeSyntaxError extends Error {
  readonly position: number

  constructor(message: string, position: number) {
    super(message)
    this.name = 'AssigneeSyntaxError'
    this.position = position
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY = /^[a-z][a-z0-9_.-]{0,63}$/
const NAME = /^[a-z][a-zA-Z0-9_]{0,63}$/
const PATH = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/

/** Префиксы записи `вид:значение` и `вид('значение')`. */
const PREFIXES = new Set(['user', 'group', 'unit', 'role', 'role_in_space', 'var', 'field'])

class Reader {
  index = 0
  constructor(readonly source: string) {}

  skipSpaces(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index] as string)) {
      this.index++
    }
  }

  peek(): string {
    return this.source[this.index] ?? ''
  }

  ident(): string {
    const match = /^[a-z_][a-z0-9_]*/.exec(this.source.slice(this.index))
    if (!match) return ''
    this.index += match[0].length
    return match[0]
  }

  /** Значение после двоеточия: до пробела, запятой или скобки. */
  bare(): string {
    const match = /^[^\s(),]+/.exec(this.source.slice(this.index))
    if (!match) return ''
    this.index += match[0].length
    return match[0]
  }

  string(): string {
    const quote = this.peek()
    const start = this.index
    this.index++
    let value = ''
    while (this.index < this.source.length && this.peek() !== quote) {
      value += this.peek()
      this.index++
    }
    if (this.peek() !== quote) throw new AssigneeSyntaxError('Строка не закрыта кавычкой', start)
    this.index++
    return value
  }

  expect(char: string, what: string): void {
    this.skipSpaces()
    if (this.peek() !== char) {
      throw new AssigneeSyntaxError(
        `Ожидалось ${what}, а встретилось ${this.peek() ? `«${this.peek()}»` : 'конец выражения'}`,
        this.index,
      )
    }
    this.index++
  }
}

/** Разбор выражения назначения; ошибка — `AssigneeSyntaxError` с позицией. */
export function parseAssignee(source: string): AssigneeExpr {
  const reader = new Reader(source)
  reader.skipSpaces()
  if (reader.index >= source.length) throw new AssigneeSyntaxError('Пустое выражение', 0)
  const expr = parseExpr(reader, 0)
  reader.skipSpaces()
  if (reader.index < source.length) {
    throw new AssigneeSyntaxError(`Лишнее «${source.slice(reader.index)}»`, reader.index)
  }
  return expr
}

function parseExpr(reader: Reader, depth: number): AssigneeExpr {
  if (depth > 8) throw new AssigneeSyntaxError('Слишком глубокая вложенность', reader.index)
  reader.skipSpaces()
  const pos = reader.index
  const head = reader.peek()
  if (head === "'" || head === '"') {
    const code = reader.string().trim()
    if (!code) throw new AssigneeSyntaxError('Пустой код подразделения', pos)
    return { kind: 'unit_code', code, pos }
  }
  const word = reader.ident()
  if (!word) {
    throw new AssigneeSyntaxError(
      `Неожиданное ${head ? `«${head}»` : 'окончание выражения'}`,
      reader.index,
    )
  }

  if (reader.peek() === ':') {
    reader.index++
    if (!PREFIXES.has(word)) throw new AssigneeSyntaxError(`Неизвестный вид «${word}:»`, pos)
    const valuePos = reader.index
    return prefixed(word, reader.bare(), pos, valuePos)
  }

  if (reader.peek() === '.') {
    reader.index++
    const member = reader.ident()
    const dotted = `${word}.${member}`
    switch (dotted) {
      case 'author.unit':
        return { kind: 'author_unit', pos }
      case 'previous_step.assignees':
        return { kind: 'previous_step', pos }
      case 'step.assignee':
      case 'step.assignees':
        return { kind: 'step_assignees', pos }
      default:
        throw new AssigneeSyntaxError(`Неизвестное выражение «${dotted}»`, pos)
    }
  }

  reader.skipSpaces()
  if (reader.peek() === '(') {
    reader.index++
    if (word === 'unit_head' || word === 'manager') {
      const inner = parseExpr(reader, depth + 1)
      reader.expect(')', '«)»')
      return word === 'unit_head'
        ? { kind: 'unit_head', unit: inner, pos }
        : { kind: 'manager', of: inner, pos }
    }
    if (PREFIXES.has(word)) {
      reader.skipSpaces()
      const valuePos = reader.index
      const quote = reader.peek()
      const value = quote === "'" || quote === '"' ? reader.string() : reader.bare()
      reader.expect(')', '«)»')
      return prefixed(word, value.trim(), pos, valuePos)
    }
    throw new AssigneeSyntaxError(`Неизвестная функция «${word}»`, pos)
  }

  switch (word) {
    case 'author':
      return { kind: 'author', pos }
    case 'initiator':
      return { kind: 'initiator', pos }
    case 'chosen_by_initiator':
      return { kind: 'chosen_by_initiator', pos }
    default:
      throw new AssigneeSyntaxError(`Неизвестное выражение «${word}»`, pos)
  }
}

function prefixed(kind: string, value: string, pos: number, valuePos: number): AssigneeExpr {
  if (!value) throw new AssigneeSyntaxError(`После «${kind}:» ожидается значение`, valuePos)
  switch (kind) {
    case 'user':
    case 'group':
    case 'unit':
      if (!UUID.test(value)) {
        throw new AssigneeSyntaxError(`«${value}» — не идентификатор`, valuePos)
      }
      return { kind, id: value.toLowerCase(), pos }
    case 'role':
    case 'role_in_space':
      if (!KEY.test(value)) throw new AssigneeSyntaxError(`«${value}» — не ключ роли`, valuePos)
      return { kind, key: value, pos }
    case 'var':
      if (!NAME.test(value)) {
        throw new AssigneeSyntaxError(`«${value}» — не имя переменной`, valuePos)
      }
      return { kind: 'var', name: value, pos }
    default:
      if (!PATH.test(value)) throw new AssigneeSyntaxError(`«${value}» — не путь поля`, valuePos)
      return { kind: 'field', path: value.split('.'), pos }
  }
}

/** Каноническая запись выражения (для подписи источника назначения). */
export function formatAssignee(expr: AssigneeExpr): string {
  switch (expr.kind) {
    case 'user':
    case 'group':
    case 'unit':
      return `${expr.kind}:${expr.id}`
    case 'unit_code':
      return `'${expr.code}'`
    case 'role':
    case 'role_in_space':
      return `${expr.kind}:${expr.key}`
    case 'var':
      return `var:${expr.name}`
    case 'field':
      return `field:${expr.path.join('.')}`
    case 'author':
      return 'author'
    case 'author_unit':
      return 'author.unit'
    case 'initiator':
      return 'initiator'
    case 'chosen_by_initiator':
      return 'chosen_by_initiator'
    case 'previous_step':
      return 'previous_step.assignees'
    case 'step_assignees':
      return 'step.assignee'
    case 'unit_head':
      return `unit_head(${formatAssignee(expr.unit)})`
    case 'manager':
      return `manager(${formatAssignee(expr.of)})`
  }
}

/** Что выражение даёт само по себе: людей или подразделение (`var`/`field` — по данным). */
export function assigneeSort(expr: AssigneeExpr): 'users' | 'unit' | 'dynamic' {
  switch (expr.kind) {
    case 'unit':
    case 'unit_code':
    case 'author_unit':
      return 'unit'
    case 'var':
    case 'field':
      return 'dynamic'
    default:
      return 'users'
  }
}

export interface AssigneeCheckContext {
  /** Типы переменных маршрута: `var:` проверяется по ним. */
  variables: Readonly<Record<string, { type: string }>>
  /** Выражение в таймере: доступно `step.assignee`. */
  timer?: boolean
}

export interface AssigneeProblem {
  message: string
  position: number
}

/**
 * Проверка смысла: подразделение там, где ждут подразделение, известные
 * переменные подходящего типа, `step.assignee` — только в таймерах, строка-код —
 * только внутри `unit_head(…)`. Первая проблема или `null`.
 */
export function checkAssignee(
  source: string,
  context: AssigneeCheckContext,
): { expr: AssigneeExpr | null; problem: AssigneeProblem | null } {
  let expr: AssigneeExpr
  try {
    expr = parseAssignee(source)
  } catch (error) {
    if (error instanceof AssigneeSyntaxError) {
      return { expr: null, problem: { message: error.message, position: error.position } }
    }
    throw error
  }
  return { expr, problem: checkNode(expr, 'users', context) }
}

function checkNode(
  expr: AssigneeExpr,
  expected: 'users' | 'unit',
  context: AssigneeCheckContext,
): AssigneeProblem | null {
  switch (expr.kind) {
    case 'unit_code':
      return expected === 'unit'
        ? null
        : {
            message: 'Код подразделения в кавычках допустим только в unit_head(…)',
            position: expr.pos,
          }
    case 'var': {
      const variable = context.variables[expr.name]
      if (!variable) return { message: `Нет переменной «${expr.name}»`, position: expr.pos }
      const allowed = expected === 'unit' ? ['unit'] : ['user', 'users', 'group', 'unit']
      if (!allowed.includes(variable.type)) {
        return {
          message:
            expected === 'unit'
              ? `Переменная «${expr.name}» — не подразделение`
              : `Переменная «${expr.name}» не задаёт людей`,
          position: expr.pos,
        }
      }
      return null
    }
    case 'step_assignees':
      return context.timer
        ? null
        : { message: 'step.assignee доступно только в таймерах', position: expr.pos }
    case 'unit_head':
    case 'manager':
      if (expected === 'unit') {
        return {
          message: `unit_head ожидает подразделение, а «${formatAssignee(expr)}» — люди`,
          position: expr.pos,
        }
      }
      return expr.kind === 'unit_head'
        ? checkNode(expr.unit, 'unit', context)
        : checkNode(expr.of, 'users', context)
    default: {
      if (expected === 'unit' && assigneeSort(expr) === 'users') {
        return {
          message: `unit_head ожидает подразделение, а «${formatAssignee(expr)}» — люди`,
          position: expr.pos,
        }
      }
      return null
    }
  }
}

/** Все узлы выражения — для поиска зависимостей (`chosen_by_initiator`, `previous_step`). */
export function assigneeNodes(expr: AssigneeExpr): AssigneeExpr[] {
  if (expr.kind === 'unit_head') return [expr, ...assigneeNodes(expr.unit)]
  if (expr.kind === 'manager') return [expr, ...assigneeNodes(expr.of)]
  return [expr]
}
