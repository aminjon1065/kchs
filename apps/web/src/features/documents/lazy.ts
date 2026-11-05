import { lazy } from 'react'

/**
 * Компоненты «documents» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazyPrintMenu = lazy(() =>
  import('./print/print-menu.js').then((module) => ({ default: module.PrintMenu })),
)

/** Документ дела во Входящих — только для чтения (ADR-0230). */
export const LazyDocumentSummary = lazy(() =>
  import('./card/document-summary.js').then((module) => ({ default: module.DocumentSummary })),
)
