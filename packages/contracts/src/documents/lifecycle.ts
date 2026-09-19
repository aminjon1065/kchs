import { z } from 'zod'

/**
 * Жизненный цикл документа (08-documents.md §3). Статус меняют только доменные
 * действия (регистрация, аннулирование) и движок процессов по маршруту типа;
 * ручной смены статуса нет — кроме `cancelled` со способностью и обоснованием.
 */
export const DOCUMENT_STATUSES = [
  'draft',
  'on_approval',
  'returned',
  'approved',
  'on_signing',
  'signed',
  'registered',
  'on_execution',
  'executed',
  'filed',
  'archived',
  'cancelled',
] as const
export const DocumentStatus = z.enum(DOCUMENT_STATUSES)
export type DocumentStatus = z.infer<typeof DocumentStatus>

/**
 * Допустимые переходы — диаграмма 08-documents.md §3 ребро в ребро. Маршрут без
 * этапа согласования начинается с подписи (`draft|returned → on_signing`),
 * возвращённый документ можно аннулировать (`returned → cancelled`) — ADR-0083.
 */
export const DOCUMENT_TRANSITIONS: Record<DocumentStatus, readonly DocumentStatus[]> = {
  draft: ['on_approval', 'on_signing', 'registered', 'cancelled'],
  on_approval: ['returned', 'approved'],
  returned: ['on_approval', 'on_signing', 'cancelled'],
  approved: ['on_signing'],
  on_signing: ['returned', 'signed'],
  signed: ['registered'],
  registered: ['on_execution', 'executed', 'cancelled'],
  on_execution: ['executed'],
  executed: ['filed'],
  filed: ['archived'],
  archived: [],
  cancelled: [],
}

export function canTransition(from: DocumentStatus, to: DocumentStatus): boolean {
  return DOCUMENT_TRANSITIONS[from].includes(to)
}

/**
 * Причина перехода: какое доменное действие его выполнило. `process` —
 * движок процессов по маршруту (вторая волна), `resolution` — резолюция
 * с поручениями, `execution` — закрыты все поручения.
 */
export const DOCUMENT_TRANSITION_CAUSES = [
  'register',
  'cancel',
  'process',
  'resolution',
  'execution',
  'filing',
  'archive',
] as const
export const DocumentTransitionCause = z.enum(DOCUMENT_TRANSITION_CAUSES)
export type DocumentTransitionCause = z.infer<typeof DocumentTransitionCause>

/** Документ закрыт для правок карточки: исполнен, в деле, в архиве или аннулирован. */
export const CLOSED_DOCUMENT_STATUSES: readonly DocumentStatus[] = [
  'executed',
  'filed',
  'archived',
  'cancelled',
]

/** Срок не отслеживается: исполнено или документ выбыл. */
export function isDocumentClosed(status: DocumentStatus): boolean {
  return CLOSED_DOCUMENT_STATUSES.includes(status)
}

/** Статусы «до регистрации»: карточка правится свободно, номера ещё нет. */
export const PRE_REGISTRATION_STATUSES: readonly DocumentStatus[] = [
  'draft',
  'on_approval',
  'returned',
  'approved',
  'on_signing',
  'signed',
]
