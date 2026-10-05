/**
 * Публичный API модуля «Идентификация» — вход: сессии, второй фактор, пароли
 * (01-overview.md §Как модули взаимодействуют). Справочник людей и оргструктуры —
 * в ядре: `kernel/directory` и порт `directory()` (ADR-0179).
 */
export { AuthService } from './domain/auth-service.js'
