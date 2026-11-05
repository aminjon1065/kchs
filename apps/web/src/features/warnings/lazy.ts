import { lazy } from 'react'

/**
 * Компоненты «warnings» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а сам компонент грузится при показе.
 */

export const LazySituationWidget = lazy(() =>
  import('./situation-widget.js').then((module) => ({ default: module.SituationWidget })),
)

/** Обстановка крупной плашкой — шапка ситуационного экрана (TV-режим дашборда). */
export const LazySituationBand = lazy(() =>
  import('./situation-band.js').then((module) => ({ default: module.SituationBand })),
)

/** Поставщик зон действующих предупреждений для карт gis (реестр наложений, ADR-0230). */
export const LazyWarningZonesFeed = lazy(() =>
  import('./warning-zones.js').then((module) => ({ default: module.WarningZonesFeed })),
)
