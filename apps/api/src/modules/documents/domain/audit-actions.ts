/**
 * Действия аудита документооборота (ADR-0182): регистрация, дела и архив, печать,
 * резолюции, почта канцелярии.
 * Ядро держит в `AUDIT_ACTIONS` только свои действия и обязательные действия
 * безопасности (17-security.md §6); модуль объявляет свои здесь и регистрирует
 * их при старте — каталог действий видит администратор.
 */
export const DOCUMENTS_AUDIT = {
  documentRegistered: 'document.registered',
  documentCancelled: 'document.cancelled',
  documentConfidentialityChanged: 'document.confidentiality_changed',
  journalNumbersReserved: 'journal.numbers_reserved',
  // Дела и архив (ADR-0086): подшивка, закрытие, передача в архив, уничтожение по акту
  documentFiled: 'document.filed',
  documentDispatched: 'document.dispatched',
  caseClosed: 'case.closed',
  caseArchived: 'case.archived',
  caseDestroyed: 'case.destroyed',
  /** Печатная форма объекта с грифом от «конфиденциально» (ADR-0085). */
  documentPrinted: 'document.printed',
  /** Копия файла с грифом под водяным знаком (ADR-0085). */
  documentFileExported: 'document.file_exported',
  /** Реестр выбранных документов выгружен в Excel (ADR-0152). */
  documentsRegistryExported: 'document.registry_exported',
  /** Резолюция, в том числе от имени руководителя (ADR-0084). */
  resolutionAdded: 'document.resolution_added',
  /** Письмо из ящика канцелярии отклонено делопроизводителем (ADR-0113). */
  mailRejected: 'mail.rejected',
  /** Входящий заведён из файлов, выгруженных из госЭДО (ADR-0219). */
  govEdmsImported: 'document.edms_imported',
  /** Собран пакет исходящего для ручной загрузки в госЭДО (ADR-0219). */
  govEdmsPackagePrepared: 'document.edms_package_prepared',
  /** Начато подписание квалифицированной подписью (ADR-0205). */
  qualifiedSigningStarted: 'document.qes_started',
  /** Сеанс квалифицированной подписи закончился: подпись встроена или не принята. */
  qualifiedSigningFinished: 'document.qes_finished',
} as const
