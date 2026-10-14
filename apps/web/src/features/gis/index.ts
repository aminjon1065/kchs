/**
 * Публичный вход модуля «gis» для других фич (ADR-0183): только лёгкие
 * модули — запросы, ключи, подписи, форматы. Компоненты сюда не попадают, чтобы
 * не тянуть их в чанк потребителя.
 */
export * from './basemaps.js'
export * from './choropleth/param-items.js'
export * from './lazy.js'
export * from './map-slots.js'
export * from './queries.js'
export * from './service-layer-queries.js'
