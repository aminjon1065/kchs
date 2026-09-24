/**
 * Публичный API модуля GIS для других модулей и загрузки данных
 * (01-overview.md §Как модули взаимодействуют): справочник территорий, реестр
 * базовых карт и загрузка сборки подложки (`kchs basemaps`).
 */
export { BasemapService, type BasemapSyncSummary } from './domain/basemap-service.js'
export { type UploadSummary, uploadBasemapBuild } from './domain/basemap-storage.js'
export { normalizeName, type TerritoryIndex, territoryIndex } from './domain/territory-index.js'
export {
  type TerritoryInput,
  type TerritoryPopulationInput,
  TerritoryService,
} from './domain/territory-service.js'
