/**
 * Публичный API модуля ИИ для других модулей (ADR-0061): структурированный
 * ответ модели с лимитами, способностью `ai.use` и аудитом.
 */
export { AiService, invalidAnswer } from './domain/service.js'
