import type { Confidentiality, DocumentStatus } from '@kchs/contracts'
import type { BadgeProps } from '@kchs/ui'
import { ApiError } from '~/shared/api/client.js'

/**
 * Цвет статуса — ключ `STATUS_TONES` дизайн-системы (StatusBadge): палитру не
 * расширяем, а сопоставляем статусы документа с её ключами.
 */
export const DOCUMENT_STATUS_TONE: Record<DocumentStatus, string> = {
  draft: 'draft',
  on_approval: 'on_approval',
  returned: 'returned',
  approved: 'in_progress',
  on_signing: 'on_signing',
  signed: 'in_progress',
  registered: 'registered',
  on_execution: 'in_progress',
  executed: 'executed',
  filed: 'done',
  archived: 'cancelled',
  cancelled: 'cancelled',
}

/** Гриф — тон бейджа: общедоступное без акцента, секретное — тревожным цветом. */
export const CONFIDENTIALITY_TONE: Record<Confidentiality, NonNullable<BadgeProps['tone']>> = {
  public: 'neutral',
  internal: 'neutral',
  confidential: 'warning',
  secret: 'danger',
}

/** Текст ошибки API для тоста и формы. */
export function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback
}

/** Ошибки полей API по ключам (`fields.amount` → `amount` для полей карточки типа). */
export function fieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError)) return {}
  return error.fieldErrors()
}

/** Сегодняшняя дата по часам пользователя (`YYYY-MM-DD`), а не по UTC. */
export function localToday(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}
