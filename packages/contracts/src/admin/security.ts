import { z } from 'zod'

/**
 * Домен из белого списка (N38, ADR-0141): нижний регистр, без схемы, «@», «*.», пути и
 * точки в конце — администратор может вставить адрес как угодно.
 */
export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^(\*\.|@)/, '')
    .replace(/[/:?#].*$/, '')
    .replace(/\.$/, '')
}

const DOMAIN_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export const AllowedDomain = z
  .string()
  .max(300)
  .transform(normalizeDomain)
  .pipe(z.string().regex(DOMAIN_RE, { message: 'Домен вида kchs.tj или hooks.example.org' }))

/** Хост совпадает с доменом белого списка или лежит под ним (`hooks.kchs.tj` под `kchs.tj`). */
export function domainAllowed(host: string, domains: readonly string[]): boolean {
  const name = normalizeDomain(host)
  return name.length > 0 && domains.some((domain) => name === domain || name.endsWith(`.${domain}`))
}

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
  /**
   * Куда правилам автоматизации можно писать письма (N38, ADR-0141): кроме сотрудников из
   * справочника — только на адреса этих доменов и их поддоменов. Пусто — только сотрудникам.
   */
  ruleEmailDomains: z.array(AllowedDomain).max(100).default([]),
  /** Какие домены правила могут вызывать вебхуком; пусто — никакие. */
  ruleWebhookDomains: z.array(AllowedDomain).max(100).default([]),
})
export type SecurityPolicy = z.infer<typeof SecurityPolicy>

export const SecurityPolicyPatch = z
  .object({
    requireMfaRoles: SecurityPolicy.shape.requireMfaRoles.unwrap(),
    allowShareLinks: SecurityPolicy.shape.allowShareLinks.unwrap(),
    sessionIdleHours: SecurityPolicy.shape.sessionIdleHours.unwrap(),
    ruleEmailDomains: SecurityPolicy.shape.ruleEmailDomains.unwrap(),
    ruleWebhookDomains: SecurityPolicy.shape.ruleWebhookDomains.unwrap(),
  })
  .partial()
export type SecurityPolicyPatch = z.infer<typeof SecurityPolicyPatch>
