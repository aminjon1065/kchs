import { lazy } from 'react'

/**
 * Компоненты «documents» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazyPrintMenu = lazy(() =>
  import('./print/print-menu.js').then((module) => ({ default: module.PrintMenu })),
)
