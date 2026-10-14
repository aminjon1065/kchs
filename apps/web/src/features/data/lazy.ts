import { lazy } from 'react'

/**
 * Компоненты «data» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazyFeedSourceDialog = lazy(() =>
  import('./sources/feed-dialog.js').then((module) => ({ default: module.FeedSourceDialog })),
)

export const LazyImportWizard = lazy(() =>
  import('./import-wizard.js').then((module) => ({ default: module.ImportWizard })),
)

export const LazyRowCard = lazy(() =>
  import('./row-card.js').then((module) => ({ default: module.RowCard })),
)

export const LazyAddToDashboardDialog = lazy(() =>
  import('./dashboard-dialogs.js').then((module) => ({ default: module.AddToDashboardDialog })),
)

export const LazyDatasetTable = lazy(() =>
  import('./dataset-table.js').then((module) => ({ default: module.DatasetTable })),
)

export const LazyExplorePlanEditor = lazy(() =>
  import('./explore-builder.js').then((module) => ({ default: module.ExplorePlanEditor })),
)

export const LazyResultTable = lazy(() =>
  import('./explore-builder.js').then((module) => ({ default: module.ResultTable })),
)
