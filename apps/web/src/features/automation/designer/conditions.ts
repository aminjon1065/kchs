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
 * Условия правила в конструкторе — список выражений, объединённых «и». Верхний уровень
 * «и» раскладывается на строки, вложенные «или» и «не» становятся одной строкой со
 * скобками: правка одной строки не меняет смысла остальных.
 */
export function conditionList(condition: RuleCondition | null): string[] {
  if (!condition) return []
  if ('and' in condition) return condition.and.map(conditionText)
  return [conditionText(condition)]
}

export function conditionOf(expressions: string[]): RuleCondition | null {
  const list = expressions.map((item) => item.trim()).filter(Boolean)
  if (list.length === 0) return null
  if (list.length === 1) return { expr: list[0] as string }
  return { and: list.map((expr) => ({ expr })) }
}
