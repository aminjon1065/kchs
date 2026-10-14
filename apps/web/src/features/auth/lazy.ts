import { lazy } from 'react'

/**
 * Компоненты «auth» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazyMfaSetup = lazy(() =>
  import('./mfa-setup.js').then((module) => ({ default: module.MfaSetup })),
)
