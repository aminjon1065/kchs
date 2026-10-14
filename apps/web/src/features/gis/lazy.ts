import { lazy } from 'react'

/**
 * Компоненты «gis» для других фич — только лениво (ADR-0183): в чанк потребителя
 * попадает ссылка на загрузку, а MapLibre и сам компонент грузятся при показе.
 */

/** Хороплет по параметрам анализа — вид «Карта» в «Исследовании» (ADR-0217). */
export const LazyChoroplethPreview = lazy(() =>
  import('./choropleth/choropleth-preview.js').then((module) => ({
    default: module.ChoroplethPreview,
  })),
)

/** Точки поля-точки с кластерами — вид «Карта» в «Исследовании» (ADR-0217, «Дополнено»). */
export const LazyPointsPreview = lazy(() =>
  import('./points-preview.js').then((module) => ({ default: module.PointsPreview })),
)

export const LazyMapEmbed = lazy(() =>
  import('./map-embed.js').then((module) => ({ default: module.MapEmbed })),
)

export const LazyChoroplethButton = lazy(() =>
  import('./choropleth/choropleth-button.js').then((module) => ({
    default: module.ChoroplethButton,
  })),
)

export const LazyShowOnMapButton = lazy(() =>
  import('./show-on-map.js').then((module) => ({ default: module.ShowOnMapButton })),
)

export const LazyPointField = lazy(() =>
  import('./edit/point-field.js').then((module) => ({ default: module.PointField })),
)

export const LazyChoroplethMapButton = lazy(() =>
  import('./choropleth/choropleth-summary.js').then((module) => ({
    default: module.ChoroplethMapButton,
  })),
)
