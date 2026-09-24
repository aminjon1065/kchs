/**
 * Публичный API модуля «Интеграции» для ядра и других модулей
 * (01-overview.md §Как модули взаимодействуют; ADR-0097).
 */
export { ApiTokens } from './domain/api-tokens.js'
export {
  ExternalDatabase,
  type ExternalReadRequest,
  externalValue,
} from './domain/database-access.js'
export { HttpIntegration, hasSecretRef } from './domain/http-integration.js'
export { Integrations } from './domain/integration-service.js'
export { authenticateApiToken, enforceTokenScope } from './domain/token-auth.js'
export { pruneDeliveries, verifySignature } from './domain/webhook-delivery.js'
