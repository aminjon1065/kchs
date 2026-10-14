/**
 * Действия аудита УЦ Комитета (ADR-0218, ADR-0182): модуль объявляет свои и регистрирует
 * их при старте — каталог действий видит администратор.
 */
export const PKI_AUDIT = {
  initialized: 'pki.initialized',
  certificateIssued: 'pki.certificate_issued',
  certificateRevoked: 'pki.certificate_revoked',
  /** Выпуск отклонён: неверное доказательство владения ключом или второй фактор. */
  enrollmentRejected: 'pki.enrollment_rejected',
} as const
