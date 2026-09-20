import { z } from 'zod'
import { Timestamp } from '../common/primitives.js'
import { GroupRoleMapping } from './directory.js'

/**
 * Единый вход через корпоративный IdP по OpenID Connect (14-automation-integrations.md §5,
 * P5-E04, ADR-0098): Authorization Code + PKCE, один провайдер на установку.
 * `clientSecret` хранится зашифрованным и наружу не возвращается.
 */

/** Соответствие claims токена полям профиля. */
export const SsoClaimMap = z.object({
  login: z.string().min(1).max(64).default('preferred_username'),
  email: z.string().max(64).default('email'),
  firstName: z.string().max(64).default('given_name'),
  lastName: z.string().max(64).default('family_name'),
  middleName: z.string().max(64).default(''),
  displayName: z.string().max(64).default('name'),
  /** Массив групп IdP — для сопоставления с ролями. */
  groups: z.string().max(64).default('groups'),
})
export type SsoClaimMap = z.infer<typeof SsoClaimMap>

export const SsoSettings = z.object({
  enabled: z.boolean().default(false),
  /** Адрес издателя: по нему читается `/.well-known/openid-configuration`. */
  issuer: z.string().max(300).default(''),
  clientId: z.string().max(200).default(''),
  scopes: z.string().max(200).default('openid profile email'),
  /** Подпись кнопки на экране входа. */
  buttonLabel: z.string().max(60).default(''),
  claims: SsoClaimMap.prefault({}),
  groupMappings: z.array(GroupRoleMapping).max(100).default([]),
  defaultRoleKeys: z.array(z.string().max(64)).max(10).default(['employee']),
  /** Создавать сотрудника при первом входе (JIT). Выключено — пускать только заведённых. */
  jitCreate: z.boolean().default(true),
  /** Завершать сессию IdP при выходе из системы (end-session endpoint). */
  endSessionOnLogout: z.boolean().default(true),
  /** Разрешить издателя по http — только для внутреннего стенда. */
  allowInsecureHttp: z.boolean().default(false),
})
export type SsoSettings = z.infer<typeof SsoSettings>

export const SsoSettingsInput = SsoSettings.extend({
  /** Новый секрет клиента; не передан — прежний сохраняется, `''` — стирается. */
  clientSecret: z.string().max(400).optional(),
})
export type SsoSettingsInput = z.infer<typeof SsoSettingsInput>

export const SsoState = SsoSettings.extend({
  hasClientSecret: z.boolean(),
  updatedAt: Timestamp.nullable(),
  /** Адрес возврата, который нужно прописать в IdP. */
  redirectUri: z.string(),
})
export type SsoState = z.infer<typeof SsoState>

export const SsoTestResult = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  issuer: z.string().nullable(),
  authorizationEndpoint: z.string().nullable(),
  tokenEndpoint: z.string().nullable(),
  endSessionEndpoint: z.string().nullable(),
  elapsedMs: z.number().int().nonnegative(),
})
export type SsoTestResult = z.infer<typeof SsoTestResult>

/**
 * Что знает о способах входа неаутентифицированный экран входа:
 * только включённость и подпись кнопки — ни адресов, ни идентификаторов клиента.
 */
export const AuthMethods = z.object({
  password: z.boolean(),
  sso: z.object({ enabled: z.boolean(), buttonLabel: z.string() }),
  passkeys: z.boolean(),
})
export type AuthMethods = z.infer<typeof AuthMethods>
