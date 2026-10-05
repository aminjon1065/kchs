/**
 * Действия аудита публичного API, вебхуков, интеграций и пакета конфигурации (ADR-0182).
 * Ядро держит в `AUDIT_ACTIONS` только свои действия и обязательные действия
 * безопасности (17-security.md §6); модуль объявляет свои здесь и регистрирует
 * их при старте — каталог действий видит администратор.
 */
export const INTEGRATIONS_AUDIT = {
  // Публичный API, вебхуки, интеграции (ADR-0097)
  apiTokenCreated: 'api_token.created',
  apiTokenRevoked: 'api_token.revoked',
  /** Предъявлен недействительный токен: отозванный, просроченный или чужой. */
  apiTokenRejected: 'api_token.rejected',
  /** Токену не хватило области доступа на маршруте. */
  apiTokenScopeDenied: 'api_token.scope_denied',
  integrationCreated: 'integration.created',
  integrationUpdated: 'integration.updated',
  integrationDeleted: 'integration.deleted',
  integrationSecretRotated: 'integration.secret_rotated',
  integrationChecked: 'integration.checked',
  webhookCreated: 'webhook.created',
  webhookUpdated: 'webhook.updated',
  webhookDeleted: 'webhook.deleted',
  webhookSecretRotated: 'webhook.secret_rotated',
  /** Входящий вебхук интеграции принят. */
  webhookReceived: 'webhook.received',
  configExported: 'config.exported',
  configImported: 'config.imported',
} as const
