import type { CapSeverity, WarningStatus } from '@kchs/contracts'

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'purple'

/** Тон состояния предупреждения: опубликованное — заметно, снятое — приглушено. */
export const STATUS_TONE: Record<WarningStatus, Tone> = {
  draft: 'neutral',
  on_approval: 'warning',
  approved: 'accent',
  published: 'success',
  updated: 'neutral',
  cancelled: 'danger',
}

export const SEVERITY_TONE: Record<CapSeverity, Tone> = {
  Extreme: 'danger',
  Severe: 'danger',
  Moderate: 'warning',
  Minor: 'accent',
  Unknown: 'neutral',
}
