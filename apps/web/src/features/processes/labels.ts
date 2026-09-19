import type { BadgeProps } from '@kchs/ui'

type Tone = NonNullable<BadgeProps['tone']>

/** Шаги, которые видит человек: решения и действия; ветвления и завершение — нет. */
export const VISIBLE_STEP_TYPES = new Set([
  'approval',
  'sign',
  'register',
  'acknowledge',
  'return',
  'task',
  'notify',
  'wait',
  'call',
  'set',
])

/** Цвет ответа назначенного (решение, очередь, засчитанное одобрение). */
export function entryTone(state: string): Tone {
  if (
    ['approved', 'signed', 'acknowledged', 'registered', 'resubmitted', 'carried'].includes(state)
  )
    return 'success'
  if (['rejected', 'refused', 'withdrawn'].includes(state)) return 'danger'
  if (state === 'remarks') return 'warning'
  if (state === 'pending') return 'accent'
  return 'neutral'
}

/** Цвет итога шага и маршрута. */
export function outcomeTone(outcome: string | null): Tone {
  if (!outcome) return 'neutral'
  if (['rejected', 'refused', 'withdrawn', 'timeout', 'cancelled'].includes(outcome))
    return 'danger'
  if (outcome === 'remarks') return 'warning'
  return 'success'
}

/** Ключ словаря с запасным вариантом: итоги шагов модулей и `end:<исход>` — свободные. */
export function knownKey(key: string, known: readonly string[], fallback: string): string {
  return known.includes(key) ? key : fallback
}

export const ENTRY_STATES = [
  'waiting',
  'pending',
  'approved',
  'rejected',
  'remarks',
  'signed',
  'refused',
  'acknowledged',
  'registered',
  'resubmitted',
  'withdrawn',
  'carried',
  'cancelled',
  'delegated',
  'assigned',
  'notified',
] as const

export const OUTCOMES = [
  'approved',
  'rejected',
  'remarks',
  'signed',
  'refused',
  'acknowledged',
  'registered',
  'resubmitted',
  'withdrawn',
  'completed',
  'timeout',
  'done',
  'sent',
  'cancelled',
] as const

export const STEP_TYPES = [
  'approval',
  'sign',
  'register',
  'acknowledge',
  'return',
  'task',
  'notify',
  'wait',
  'call',
  'set',
] as const

/** Решения, которым нужен комментарий (замечания — комментарий или файл). */
export const COMMENT_REQUIRED = new Set(['reject', 'refuse', 'withdraw'])

/** Подписи решений и изменений состава в линии маршрута. */
export const DECISION_LABELS = [
  'approve',
  'remarks',
  'reject',
  'sign',
  'refuse',
  'acknowledge',
  'register',
  'resubmit',
  'withdraw',
  'delegate',
  'add_approver',
  'reassign',
] as const
