import type { CapSeverity, WarningStatus } from '@kchs/contracts'
import type { HazardLevel } from '@kchs/ui'

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'purple'

/**
 * Тон состояния предупреждения: опубликованное — заметно, снятое — приглушено. «На
 * утверждении» — фиолетовым процесса, а не `warning`: тон состояния интерфейса «срок
 * близко» рядом со шкалой обстановки читался бы как уровень опасности (ADR-0230).
 */
export const STATUS_TONE: Record<WarningStatus, Tone> = {
  draft: 'neutral',
  on_approval: 'purple',
  approved: 'accent',
  published: 'success',
  updated: 'neutral',
  cancelled: 'danger',
}

/**
 * Уровень шкалы обстановки по строгости CAP (ADR-0230). Неизвестная строгость — как
 * «внимание»: действующее предупреждение не должно пропасть из виду из-за пустого поля.
 */
export const HAZARD_LEVEL: Record<CapSeverity, HazardLevel> = {
  Extreme: 3,
  Severe: 2,
  Moderate: 1,
  Minor: 0,
  Unknown: 1,
}
