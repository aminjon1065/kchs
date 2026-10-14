import { lazy } from 'react'

/**
 * Компоненты «files» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazyNewVersionDialog = lazy(() =>
  import('./version-dialogs.js').then((module) => ({ default: module.NewVersionDialog })),
)

export const LazyRestoreVersionDialog = lazy(() =>
  import('./version-dialogs.js').then((module) => ({ default: module.RestoreVersionDialog })),
)

export const LazyFilesScreen = lazy(() =>
  import('./files-screen.js').then((module) => ({ default: module.FilesScreen })),
)
