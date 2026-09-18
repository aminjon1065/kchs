import { z } from 'zod'

/**
 * Политика безопасности организации (17-security.md §2; 05-risks N3).
 * Хранится системными настройками `security.*`; меняет её администратор,
 * каждое изменение пишется в аудит.
 */
export const SecurityPolicy = z.object({
  /** Роли, которым второй фактор обязателен: без него доступны только профиль и подключение MFA. */
  requireMfaRoles: z.array(z.string().min(1).max(64)).max(50).default([]),
  /** Гостевые ссылки разрешены; выключение отзывает действие уже выданных ссылок. */
  allowShareLinks: z.boolean().default(true),
  /** Простой сессии до выхода, часов; null — значение из конфигурации сервера. */
  sessionIdleHours: z.number().int().min(1).max(720).nullable().default(null),
})
export type SecurityPolicy = z.infer<typeof SecurityPolicy>

export const SecurityPolicyPatch = z
  .object({
    requireMfaRoles: SecurityPolicy.shape.requireMfaRoles.unwrap(),
    allowShareLinks: SecurityPolicy.shape.allowShareLinks.unwrap(),
    sessionIdleHours: SecurityPolicy.shape.sessionIdleHours.unwrap(),
  })
  .partial()
export type SecurityPolicyPatch = z.infer<typeof SecurityPolicyPatch>
