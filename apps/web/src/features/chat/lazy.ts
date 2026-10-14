import { lazy } from 'react'

/**
 * Компоненты «chat» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazyPresenceDialog = lazy(() =>
  import('./presence-dialog.js').then((module) => ({ default: module.PresenceDialog })),
)
