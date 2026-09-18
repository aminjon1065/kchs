/**
 * Публичный API модуля GIS для других модулей и загрузки данных
 * (01-overview.md §Как модули взаимодействуют): справочник территорий.
 */
export { normalizeName, type TerritoryIndex, territoryIndex } from './domain/territory-index.js'
export { type TerritoryInput, TerritoryService } from './domain/territory-service.js'
