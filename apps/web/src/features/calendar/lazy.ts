import { lazy } from 'react'

/**
 * Компоненты «calendar» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazyTodayWidget = lazy(() =>
  import('./today-widget.js').then((module) => ({ default: module.TodayWidget })),
)
