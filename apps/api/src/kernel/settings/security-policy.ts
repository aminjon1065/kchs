import { SecurityPolicy, type SecurityPolicyPatch } from '@kchs/contracts'
import type { Ctx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'
import { SETTING_KEYS, SettingsService } from './service.js'

type Field = keyof SecurityPolicy

/**
 * Роли, которым второй фактор обязателен на рабочей установке (05-risks N3, ADR-0139):
 * администратор системы и аудитор безопасности. Их записывает `kchs init`, пока политику
 * никто не задавал; демо-профиль сида это умолчание снимает.
 */
export const INSTALL_MFA_ROLES: readonly string[] = ['system_admin', 'security_auditor']

const sameRoles = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((role) => b.includes(role))

const KEYS: Record<Field, string> = {
  requireMfaRoles: SETTING_KEYS.securityRequireMfaRoles,
  allowShareLinks: SETTING_KEYS.securityAllowShareLinks,
  sessionIdleHours: SETTING_KEYS.securitySessionIdleHours,
}

/**
 * Политика читается на каждом запросе (вход, сессия, гостевая ссылка), поэтому
 * процесс держит её в памяти недолго: изменение применяется сразу в процессе,
 * где его сделали, и не позже чем через CACHE_TTL_MS в остальных.
 */
const CACHE_TTL_MS = 10_000
let cached: { policy: SecurityPolicy; at: number } | null = null

/** Испорченное значение настройки заменяется умолчанием: сбой данных не должен запирать вход. */
function fromSettings(system: Record<string, unknown>): SecurityPolicy {
  const policy = SecurityPolicy.parse({})
  for (const field of Object.keys(KEYS) as Field[]) {
    const raw = system[KEYS[field]]
    if (raw === undefined) continue
    const parsed = SecurityPolicy.shape[field].safeParse(raw)
    if (parsed.success) Object.assign(policy, { [field]: parsed.data })
  }
  return policy
}

export const SecurityPolicyService = {
  async current(): Promise<SecurityPolicy> {
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.policy
    const policy = fromSettings(await SettingsService.system())
    cached = { policy, at: Date.now() }
    return policy
  },

  /**
   * Изменение политики — событие аудита уровня notice с состоянием до и после
   * (17-security.md §6: «изменения политик»). Кэш процесса сбрасывает вызывающий
   * после коммита — см. `invalidate`.
   */
  async update(tx: Executor, ctx: Ctx, patch: SecurityPolicyPatch): Promise<SecurityPolicy> {
    const before = fromSettings(await SettingsService.system())
    const after: SecurityPolicy = { ...before }
    for (const field of Object.keys(KEYS) as Field[]) {
      const value = patch[field]
      if (value === undefined) continue
      Object.assign(after, { [field]: value })
      if (value === null) await SettingsService.remove(tx, 'system', null, KEYS[field])
      else await SettingsService.set(tx, ctx, 'system', null, KEYS[field], value)
    }
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.securityPolicyChanged,
        severity: 'notice',
        details: { before, after },
      },
      tx,
    )
    return after
  },

  /**
   * Умолчание рабочей установки (`kchs init`): обязательный второй фактор для
   * администраторов и аудиторов, если политику ещё никто не задавал. Выбор администратора
   * — в том числе пустой список — повторный запуск не трогает.
   */
  async applyInstallDefault(
    tx: Executor,
    ctx: Ctx,
  ): Promise<{ requireMfaRoles: string[]; applied: boolean }> {
    const system = await SettingsService.system()
    if (KEYS.requireMfaRoles in system) {
      return { requireMfaRoles: fromSettings(system).requireMfaRoles, applied: false }
    }
    const after = await this.update(tx, ctx, { requireMfaRoles: [...INSTALL_MFA_ROLES] })
    return { requireMfaRoles: after.requireMfaRoles, applied: true }
  },

  /**
   * Демо-установка (профиль `demo`): общие учётные записи демонстрационного мира входят
   * без второго фактора, поэтому умолчание `kchs init` снимается. Политику, которую
   * администратор задал по-своему, демо-сид не трогает.
   */
  async relaxInstallDefaultForDemo(tx: Executor, ctx: Ctx): Promise<boolean> {
    const current = fromSettings(await SettingsService.system())
    if (!sameRoles(current.requireMfaRoles, INSTALL_MFA_ROLES)) return false
    await this.update(tx, ctx, { requireMfaRoles: [] })
    return true
  },

  /** Сброс кэша процесса: после изменения политики и в тестах. */
  invalidate(): void {
    cached = null
  },

  /** Роль пользователя требует второго фактора по политике. */
  requiresMfa(policy: SecurityPolicy, roleKeys: readonly string[]): boolean {
    return policy.requireMfaRoles.some((role) => roleKeys.includes(role))
  },
}
