import type { EventEnvelope, RuleDefinition } from '@kchs/contracts'
import { matchesType } from '~/kernel/events/bus.js'

/**
 * Сопоставление события с триггером правила (ADR-0096): тип из каталога или
 * префикс домена и отбор по полям конверта. Отбор — сравнение значений, без
 * вычисления выражений: он отсеивает большинство событий до чтения объекта.
 */
export function valueAt(event: EventEnvelope, path: string): unknown {
  let current: unknown = event
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export function matchesFilter(event: EventEnvelope, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([path, expected]) => {
    const actual = valueAt(event, path)
    if (Array.isArray(expected)) return expected.some((item) => String(item) === String(actual))
    if (expected === null) return actual === null || actual === undefined
    return String(expected) === String(actual)
  })
}

export function matchesTrigger(definition: RuleDefinition, event: EventEnvelope): boolean {
  if (definition.trigger.kind !== 'event') return false
  if (!matchesType([definition.trigger.type], event.type)) return false
  return matchesFilter(event, definition.trigger.filter)
}
