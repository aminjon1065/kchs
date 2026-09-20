import type { EventEnvelope, RuleCondition } from '@kchs/contracts'
import { type EvalScope, evaluateCondition, evaluateExpression } from '@kchs/query/expr'

/**
 * Область вычисления правила (contracts/automation-rule.md §Контекст выражений):
 * `event.*`, `object.*` (сводка и поля карточки), `actor.*`, `previous.*`
 * (значения до изменения), `now`. Язык — тот же, что у условий маршрутов
 * (`@kchs/query/expr`): второго языка выражений в продукте нет.
 */
export interface RuleScopeData {
  event: {
    id: string
    type: string
    occurredAt: string
    payload: Record<string, unknown>
    changedFields: string[] | null
    correlationId: string | null
  } | null
  object: Record<string, unknown> | null
  actor: { id: string | null; kind: string; displayName: string | null }
  previous: Record<string, unknown>
  now: string
}

function pick(source: unknown, path: readonly string[]): unknown {
  let current = source
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/** Область вычисления для выражений и шаблонов правила. */
export function ruleScope(data: RuleScopeData, timezone: string): EvalScope {
  const roots: Record<string, unknown> = {
    event: data.event,
    object: data.object,
    actor: data.actor,
    previous: data.previous,
    now: data.now,
  }
  return {
    resolve: (path) => (path.length === 1 && path[0] === 'now' ? data.now : pick(roots, path)),
    now: () => new Date(data.now),
    timezone,
  }
}

/** Данные области из конверта события — то, что доступно без чтения объекта. */
export function scopeFromEvent(event: EventEnvelope, now = new Date()): RuleScopeData {
  const previous = event.payload.previous
  return {
    event: {
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      payload: event.payload,
      changedFields: event.changedFields,
      correlationId: event.correlationId,
    },
    object: event.object
      ? {
          id: event.object.id,
          type: event.object.type,
          spaceId: event.object.spaceId,
          title: event.object.title,
          fields: {},
        }
      : null,
    actor: { id: event.actor.userId, kind: event.actor.kind, displayName: null },
    previous: previous && typeof previous === 'object' ? (previous as Record<string, unknown>) : {},
    now: now.toISOString(),
  }
}

/** Условие правила: дерево `and` / `or` / `not` над выражениями. */
export function evaluateRuleCondition(condition: RuleCondition, scope: EvalScope): boolean {
  if ('expr' in condition) return evaluateCondition(condition.expr, scope)
  if ('and' in condition) return condition.and.every((item) => evaluateRuleCondition(item, scope))
  if ('or' in condition) return condition.or.some((item) => evaluateRuleCondition(item, scope))
  return !evaluateRuleCondition(condition.not, scope)
}

/** Все выражения условия — для проверки в конструкторе. */
export function conditionExpressions(condition: RuleCondition): string[] {
  if ('expr' in condition) return [condition.expr]
  if ('and' in condition) return condition.and.flatMap(conditionExpressions)
  if ('or' in condition) return condition.or.flatMap(conditionExpressions)
  return conditionExpressions(condition.not)
}

const TEMPLATE = /\{\{([^}]+)\}\}/g

/** Выражения внутри `{{…}}` — для проверки шаблонов. */
export function templateExpressions(template: string): string[] {
  return [...template.matchAll(TEMPLATE)].map((match) => (match[1] ?? '').trim()).filter(Boolean)
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * Подстановка `{{…}}`: содержимое — то же выражение, значение приводится к
 * строке. Вся строка — одно выражение (`{{object.fields.amount}}`) отдаётся
 * значением, а не строкой: так `update_fields` кладёт число числом.
 */
export function renderTemplate(template: string, scope: EvalScope): string {
  return template.replace(TEMPLATE, (_match, expression: string) =>
    text(evaluateExpression(expression.trim(), scope)),
  )
}

/** Значение шаблона с сохранением типа, если вся строка — одно выражение. */
export function renderValue(template: string, scope: EvalScope): unknown {
  const whole = /^\s*\{\{([^}]+)\}\}\s*$/.exec(template)
  if (whole) return evaluateExpression((whole[1] as string).trim(), scope)
  return renderTemplate(template, scope)
}
