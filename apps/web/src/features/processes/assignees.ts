/**
 * Выражения назначений маршрута (docs/contracts/process-definition.md) для
 * конструктора: распознавание частых форм, чтобы показать их словами, и
 * ключи принципалов для подписи людей, подразделений и групп именами.
 * Прочие выражения показываются как есть; их проверяет сервер.
 */

export type AssigneeDescription =
  | { kind: 'user' | 'unit' | 'group'; key: string }
  | { kind: 'role' | 'role_in_space'; role: string }
  | {
      kind:
        | 'author'
        | 'author_unit'
        | 'author_unit_head'
        | 'author_manager'
        | 'author_unit_head_manager'
        | 'initiator'
        | 'chosen'
        | 'previous'
        | 'overdue_assignee'
        | 'overdue_assignee_manager'
    }
  | { kind: 'variable' | 'field'; name: string }
  | { kind: 'unit_head_code'; code: string }
  | { kind: 'expression'; source: string }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const PRINCIPAL = new RegExp(`^(user|unit|group):(${UUID})$`, 'i')
const ROLE = /^(role|role_in_space):([a-z][a-z0-9_]*)$/
const ROLE_CALL = /^role_in_space\('([a-z][a-z0-9_]*)'\)$/
const VARIABLE = /^var(?::([a-zA-Z][a-zA-Z0-9_]*)|\('([a-zA-Z][a-zA-Z0-9_]*)'\))$/
const FIELD = /^field(?::([a-zA-Z_][a-zA-Z0-9_.]*)|\('([a-zA-Z_][a-zA-Z0-9_.]*)'\))$/
const HEAD_BY_CODE = /^unit_head\('([^']+)'\)$/

const FIXED: Record<string, AssigneeDescription['kind']> = {
  author: 'author',
  'author.unit': 'author_unit',
  'unit_head(author.unit)': 'author_unit_head',
  'manager(author)': 'author_manager',
  'manager(unit_head(author.unit))': 'author_unit_head_manager',
  initiator: 'initiator',
  chosen_by_initiator: 'chosen',
  'previous_step.assignees': 'previous',
  'step.assignee': 'overdue_assignee',
  'step.assignees': 'overdue_assignee',
  'manager(step.assignee)': 'overdue_assignee_manager',
}

/** Распознать выражение: пробелы вокруг скобок и запятых не важны. */
export function describeAssignee(expression: string): AssigneeDescription {
  const source = expression.trim()
  const compact = source.replace(/\s+/g, '')
  const fixed = FIXED[compact]
  if (fixed) return { kind: fixed } as AssigneeDescription
  const principal = PRINCIPAL.exec(compact)
  if (principal) {
    const kind = (principal[1] as string).toLowerCase() as 'user' | 'unit' | 'group'
    return { kind, key: `${kind}:${(principal[2] as string).toLowerCase()}` }
  }
  const role = ROLE.exec(compact)
  if (role) return { kind: role[1] as 'role' | 'role_in_space', role: role[2] as string }
  const roleCall = ROLE_CALL.exec(compact)
  if (roleCall) return { kind: 'role_in_space', role: roleCall[1] as string }
  const variable = VARIABLE.exec(compact)
  if (variable) return { kind: 'variable', name: (variable[1] ?? variable[2]) as string }
  const field = FIELD.exec(compact)
  if (field) return { kind: 'field', name: (field[1] ?? field[2]) as string }
  const head = HEAD_BY_CODE.exec(source.replace(/\s+/g, ' ').trim())
  if (head) return { kind: 'unit_head_code', code: head[1] as string }
  return { kind: 'expression', source }
}

/** Ключи принципалов выражений — для одного запроса названий. */
export function principalKeysOf(expressions: Iterable<string>): string[] {
  const keys = new Set<string>()
  for (const expression of expressions) {
    const description = describeAssignee(expression)
    if (
      description.kind === 'user' ||
      description.kind === 'unit' ||
      description.kind === 'group'
    ) {
      keys.add(description.key)
    }
  }
  return [...keys].sort()
}

/** Быстрые варианты меню «Добавить»: выражение и ключ подписи. */
export const QUICK_ASSIGNEES: ReadonlyArray<{
  expression: string
  kind: AssigneeDescription['kind']
}> = [
  { expression: 'unit_head(author.unit)', kind: 'author_unit_head' },
  { expression: 'manager(author)', kind: 'author_manager' },
  { expression: 'manager(unit_head(author.unit))', kind: 'author_unit_head_manager' },
  { expression: 'author', kind: 'author' },
  { expression: 'author.unit', kind: 'author_unit' },
  { expression: 'initiator', kind: 'initiator' },
  { expression: 'chosen_by_initiator', kind: 'chosen' },
  { expression: 'previous_step.assignees', kind: 'previous' },
]

/** Получатели эскалации: к быстрым вариантам — не ответившие и их руководители. */
export const TIMER_ASSIGNEES: ReadonlyArray<{
  expression: string
  kind: AssigneeDescription['kind']
}> = [
  { expression: 'manager(step.assignee)', kind: 'overdue_assignee_manager' },
  { expression: 'step.assignee', kind: 'overdue_assignee' },
  { expression: 'author', kind: 'author' },
  { expression: 'unit_head(author.unit)', kind: 'author_unit_head' },
]

/** Выражения назначений всего определения — для подписей именами. */
export function allAssigneeExpressions(value: unknown): string[] {
  const found: string[] = []
  const walk = (node: unknown, key: string | null) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (typeof item === 'string' && (key === 'assignees' || key === 'to')) found.push(item)
        else walk(item, key)
      }
      return
    }
    if (node && typeof node === 'object') {
      for (const [name, child] of Object.entries(node)) {
        if (typeof child === 'string' && (name === 'to' || name === 'assignees')) found.push(child)
        else walk(child, name)
      }
    }
  }
  walk(value, null)
  return found
}
