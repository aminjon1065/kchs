/**
 * Публичный вход модуля «processes» для других фич (ADR-0183): только лёгкие
 * модули — запросы, ключи, подписи, форматы. Компоненты сюда не попадают, чтобы
 * не тянуть их в чанк потребителя; панель маршрута объекта — только ленивой обёрткой.
 */
export * from './labels.js'
export * from './lazy.js'
export * from './queries.js'
export { ObjectRoutePanel } from './route-panel-lazy.js'
