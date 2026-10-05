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
  // Выгрузка контроля исполнения в CSV/XLSX — экспорт (17-security.md §6, ADR-0185)
  controlExported: 'tasks.control_exported',
} as const
