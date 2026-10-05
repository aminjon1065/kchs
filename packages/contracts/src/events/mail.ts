import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Почта установки и канцелярии (ADR-0113, ADR-0150). Домены `mail` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const MAIL_EVENTS = {
  // ── mail: почта установки (ADR-0150) ──────────────────────────────────────
  /** Сотрудник задал (`set`) или отозвал пароль для почты. */
  'mail.password_changed': z.object({ userId: Uuid, address: z.string(), set: z.boolean() }),
  /** Синхронизация завела новые ящики; `accounts` — всего в файле учёток. */
  'mail.mailboxes_synced': z.object({
    created: z.number().int(),
    accounts: z.number().int(),
  }),
  // ── почта канцелярии: регистрация входящих из ящика (ADR-0113) ────────────
  /**
   * Письмо разобрано и стало черновиком входящего. Объект события — черновик
   * (если он завёлся); письмо само по себе объектом реестра не становится.
   */
  'mail.received': z.object({
    messageId: Uuid,
    integrationId: Uuid.nullable().default(null),
    documentId: Uuid.nullable().default(null),
    from: z.string(),
    subject: z.string(),
    attachments: z.number().int().nonnegative().default(0),
  }),
  /** Делопроизводитель отклонил письмо: документа не будет, причина записана. */
  'mail.rejected': z.object({ messageId: Uuid, reason: z.string() }),
  /** Письмо не разобралось: оно помечено в очереди «Из почты», а не потеряно. */
  'mail.failed': z.object({ messageId: Uuid, error: z.string() }),
  /** Срок хранения очереди «Из почты»: удалены отклонённые и неразобранные письма (ADR-0136). */
  'mail.purged': z.object({ count: z.number().int(), before: z.string() }),
} as const satisfies Record<string, z.ZodType>
