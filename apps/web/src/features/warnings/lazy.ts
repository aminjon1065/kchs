import { lazy } from 'react'

/**
 * Компоненты «warnings» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazySituationWidget = lazy(() =>
  import('./situation-widget.js').then((module) => ({ default: module.SituationWidget })),
)
