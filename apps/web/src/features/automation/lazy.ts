import { lazy } from 'react'

/**
 * Компоненты «automation» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazyAutomationRulesSection = lazy(() =>
  import('./rules-section.js').then((module) => ({ default: module.AutomationRulesSection })),
)

export const LazySchedulesSection = lazy(() =>
  import('./schedules-section.js').then((module) => ({ default: module.SchedulesSection })),
)
