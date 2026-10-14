import { lazy } from 'react'

/**
 * Компоненты «admin» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazyRunAsSelect = lazy(() =>
  import('./run-as-select.js').then((module) => ({ default: module.RunAsSelect })),
)
