import { z } from 'zod'

/**
 * Почтовый ящик сотрудника в почте установки (ADR-0150): адрес по логину, пароль для почты —
 * отдельный от пароля платформы (второй фактор к почтовым программам не применим).
 */
export const MailStatus = z.object({
  /** Почта установки включена (задан домен ящиков). */
  enabled: z.boolean(),
  address: z.string().nullable(),
  /** Сотрудник задал пароль для почты; иначе ящик только принимает письма. */
  passwordSet: z.boolean(),
  webmailUrl: z.string().nullable(),
})
export type MailStatus = z.infer<typeof MailStatus>

/** Новый пароль для почты — показывается один раз. */
export const MailPassword = z.object({ address: z.string(), password: z.string() })
export type MailPassword = z.infer<typeof MailPassword>
