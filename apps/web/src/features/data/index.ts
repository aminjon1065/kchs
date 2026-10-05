/**
 * Публичный вход модуля «data» для других фич (ADR-0183): только лёгкие
 * модули — запросы, ключи, подписи, форматы. Компоненты сюда не попадают, чтобы
 * не тянуть их в чанк потребителя.
 */
export * from './dashboard-layout.js'
export * from './field-options.js'
export * from './field-types.js'
export * from './pipelines/queries.js'
export * from './queries.js'
export * from './sources/queries.js'
