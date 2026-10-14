import { lazy } from 'react'

/**
 * Компоненты «notebooks» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazyCreateNotebookDialog = lazy(() =>
  import('./create-notebook-dialog.js').then((module) => ({
    default: module.CreateNotebookDialog,
  })),
)

export const LazyQueryCell = lazy(() =>
  import('./query-cell.js').then((module) => ({ default: module.QueryCell })),
)

export const LazyChartCell = lazy(() =>
  import('./source-cells.js').then((module) => ({ default: module.ChartCell })),
)

export const LazyNotebookParamsBar = lazy(() =>
  import('./notebook-params.js').then((module) => ({ default: module.NotebookParamsBar })),
)
