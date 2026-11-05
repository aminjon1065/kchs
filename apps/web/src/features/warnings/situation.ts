import type { WarningSummary } from '@kchs/contracts'
import type { HazardLevel } from '@kchs/ui'
import { HAZARD_LEVEL } from './labels.js'

/** Действует сейчас: опубликовано, не учения и не отмена, срок не истёк. */
function isActive(warning: WarningSummary, now: number): boolean {
  return (
    warning.status === 'published' &&
    warning.capStatus === 'Actual' &&
    warning.msgType !== 'Cancel' &&
    (warning.expires === null || Date.parse(warning.expires) > now)
  )
}

const issuedAt = (warning: WarningSummary): number =>
  Date.parse(warning.publishedAt ?? warning.updatedAt)

export interface ActiveWarning {
  warning: WarningSummary
  level: HazardLevel
}

/**
 * Действующие предупреждения по шкале обстановки (ADR-0230): самые строгие первыми, при
 * равной строгости — самые свежие.
 */
export function activeWarnings(items: readonly WarningSummary[], now: number): ActiveWarning[] {
  return items
    .filter((warning) => isActive(warning, now))
    .map((warning) => ({ warning, level: HAZARD_LEVEL[warning.severity] }))
    .sort((a, b) => b.level - a.level || issuedAt(b.warning) - issuedAt(a.warning))
}

/**
 * Что показать в полосе обстановки: самое строгое из действующих и сколько их всего.
 * Уровень 0 полосу не поднимает — это обычный фон.
 */
export function pickSituation(
  items: readonly WarningSummary[],
  now: number,
): (ActiveWarning & { count: number }) | null {
  const raised = activeWarnings(items, now).filter((item) => item.level > 0)
  const [top] = raised
  return top ? { ...top, count: raised.length } : null
}

/** Слово уровня в словаре оболочки: `shell.opsBand.levels.<слово>`. */
export const HAZARD_WORD = {
  0: 'normal',
  1: 'caution',
  2: 'danger',
  3: 'extreme',
} as const satisfies Record<HazardLevel, string>

/** Запрос полосы и виджета: опубликованные, видимые сотруднику, раз в минуту. */
export const ACTIVE_WARNINGS_QUERY = { status: 'published', limit: 50 } as const
