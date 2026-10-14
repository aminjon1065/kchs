import { lazy } from 'react'

/**
 * Компоненты «processes» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazyProcessesSection = lazy(() =>
  import('./processes-section.js').then((module) => ({ default: module.ProcessesSection })),
)

export const LazyRouteLine = lazy(() =>
  import('./route-line.js').then((module) => ({ default: module.RouteLine })),
)

export const LazyProcessStepActions = lazy(() =>
  import('./step-actions.js').then((module) => ({ default: module.ProcessStepActions })),
)
