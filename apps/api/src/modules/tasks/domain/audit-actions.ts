/**
 * Действия аудита поручений: продление срока и переназначение (ADR-0182).
 * Ядро держит в `AUDIT_ACTIONS` только свои действия и обязательные действия
 * безопасности (17-security.md §6); модуль объявляет свои здесь и регистрирует
 * их при старте — каталог действий видит администратор.
 */
export const TASKS_AUDIT = {
  // Поручения (ADR-0082): продление срока и переназначение исполнителя
  taskExtensionRequested: 'task.extension_requested',
  taskExtensionDecided: 'task.extension_decided',
  taskReassigned: 'task.reassigned',
} as const
