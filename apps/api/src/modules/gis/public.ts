/**
 * Публичный API модуля GIS для других модулей и загрузки данных
 * (01-overview.md §Как модули взаимодействуют): справочник территорий, реестр
 * базовых карт и загрузка сборки подложки (`kchs basemaps`), демо-слои сида.
 */
export { BasemapService, type BasemapSyncSummary } from './domain/basemap-service.js'
export { type UploadSummary, uploadBasemapBuild } from './domain/basemap-storage.js'
export { DemoLayers, type DemoLayersResult } from './domain/demo-layers.js'
export { normalizeName, type TerritoryIndex, territoryIndex } from './domain/territory-index.js'
export { type TerritoryInput, TerritoryService } from './domain/territory-service.js'
