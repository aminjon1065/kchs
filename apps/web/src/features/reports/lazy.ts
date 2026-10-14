import { lazy } from 'react'

/**
 * Компоненты «reports» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazyCreateReportDialog = lazy(() =>
  import('./create-report-dialog.js').then((module) => ({ default: module.CreateReportDialog })),
)
