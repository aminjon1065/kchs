/**
 * Публичный API справочника территорий (ADR-0180) для других модулей и загрузки
 * данных: индекс единиц для разбора значений, поиск единицы по геометрии и сервис
 * справочника (импорт, население, дочерние единицы).
 */
export { normalizeName, type TerritoryIndex, territoryIndex } from './domain/territory-index.js'
export { type LocatableGeometry, TerritoryLocator } from './domain/territory-locate.js'
export {
  type TerritoryChild,
  type TerritoryInput,
  type TerritoryPopulationInput,
  TerritoryService,
} from './domain/territory-service.js'
