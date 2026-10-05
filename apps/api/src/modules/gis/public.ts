/**
 * Публичный API модуля GIS для других модулей и загрузки данных
 * (01-overview.md §Как модули взаимодействуют): реестр базовых карт и загрузка
 * сборки подложки (`kchs basemaps`). Справочник территорий — модуль `territories`
 * (ADR-0180).
 */
export { BasemapService, type BasemapSyncSummary } from './domain/basemap-service.js'
export { type UploadSummary, uploadBasemapBuild } from './domain/basemap-storage.js'
