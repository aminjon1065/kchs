import type { Step } from '@kchs/process'

/**
 * Шаг-«пул» (ADR-0229): решает любой один из назначенных — регистрация, согласование
 * в режиме «любой» или с кворумом «любой». Из такого пула можно убрать тех, кто не
 * может работать с объектом, не меняя смысла шага.
 */
export function isPoolStep(step: Step): boolean {
  if (step.type === 'register') return true
  if (step.type === 'approval') return step.mode === 'any' || step.quorum === 'any'
  return false
}
