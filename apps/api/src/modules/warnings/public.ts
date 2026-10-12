/**
 * Публичный API модуля «Предупреждения» (ADR-0202) для пакетов и служебных
 * команд: ключ маршрута выпуска и настройки установки — пространство
 * предупреждений и реестр сообщений-источников.
 */
export { WarningSettingsService as WarningSettings } from './domain/settings.js'
export { WARNING_ROUTE_KEY } from './domain/warning-service.js'
