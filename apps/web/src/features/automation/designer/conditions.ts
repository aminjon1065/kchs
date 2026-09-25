import type { RuleCondition } from '@kchs/contracts'

/** В выражении есть «и»/«или» верхнего уровня — внутри группы его берут в скобки. */
const COMPOUND = /\b(and|or)\b/i

function part(condition: RuleCondition): string {
  const text = conditionText(condition)
  // «not» связывает сильнее «and» и «or» (и слабее сравнения): скобки ему не нужны
  if ('not' in condition) return text
  return 'expr' in condition && !COMPOUND.test(text) ? text : `(${text})`
}

/** Дерево условия — одним выражением того же языка: группы «или» и «не» без потери смысла. */
export function conditionText(condition: RuleCondition): string {
  if ('expr' in condition) return condition.expr
  if ('and' in condition) return condition.and.map(part).join(' and ')
  if ('or' in condition) return condition.or.map(part).join(' or ')
  return `not ${part(condition.not)}`
}

/**
 * Узел конструктора условий (ADR-0163): выражение или группа «все» / «любое» с флажком
 * «не». Дерево контракта (`and` / `or` / `not`) переводится в узлы и обратно без потери
 * смысла: вложенные группы правятся группами, а не одной строкой со скобками.
 */
export type ConditionNode =
  | { kind: 'expr'; expr: string; negated: boolean }
  | { kind: 'group'; op: 'and' | 'or'; items: ConditionNode[]; negated: boolean }

/** Глубина вложенности групп в форме: глубже — правка в JSON. */
export const MAX_CONDITION_DEPTH = 3

function node(condition: RuleCondition): ConditionNode {
  if ('expr' in condition) return { kind: 'expr', expr: condition.expr, negated: false }
  if ('not' in condition) {
    const inner = node(condition.not)
    return { ...inner, negated: !inner.negated }
  }
  const op = 'and' in condition ? 'and' : 'or'
  const items = 'and' in condition ? condition.and : condition.or
  return { kind: 'group', op, items: items.map(node), negated: false }
}

/** Условие правила → корневая группа конструктора (пустое условие — пустая группа «все»). */
export function toConditionNode(condition: RuleCondition | null): ConditionNode {
  if (!condition) return { kind: 'group', op: 'and', items: [], negated: false }
  const root = node(condition)
  return root.kind === 'group' && !root.negated
    ? root
    : { kind: 'group', op: 'and', items: [root], negated: false }
}

/** Узлы → дерево контракта: пустые выражения и группы отбрасываются, группа из одного — узел. */
export function fromConditionNode(item: ConditionNode): RuleCondition | null {
  let condition: RuleCondition | null
  if (item.kind === 'expr') {
    const expr = item.expr.trim()
    condition = expr ? { expr } : null
  } else {
    const items = item.items
      .map(fromConditionNode)
      .filter((value): value is RuleCondition => value !== null)
    if (items.length === 0) condition = null
    else if (items.length === 1) condition = items[0] as RuleCondition
    else condition = item.op === 'and' ? { and: items } : { or: items }
  }
  if (!condition) return null
  return item.negated ? { not: condition } : condition
}
