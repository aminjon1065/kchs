import { z } from 'zod'
import { Timestamp } from '../common/primitives.js'

/**
 * Ключи входа (passkeys, WebAuthn — 17-security.md §2, P5-E04, ADR-0098).
 * Ключ с подтверждением пользователя (отпечаток, PIN) сам по себе двухфакторный:
 * он и входит самостоятельно, и закрывает требование второго фактора.
 *
 * Структуры браузера (`PublicKeyCredentialCreationOptionsJSON` и ответы
 * `navigator.credentials`) описаны свободными объектами: их состав задаёт
 * стандарт WebAuthn, платформа передаёт их насквозь и не интерпретирует.
 */

export const PasskeyInfo = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  /** Ключ подтверждает личность (UV): годится как самостоятельный вход. */
  userVerified: z.boolean(),
  /** Ключ синхронизируется между устройствами (облачный passkey). */
  backedUp: z.boolean(),
  transports: z.array(z.string()).default([]),
})
export type PasskeyInfo = z.infer<typeof PasskeyInfo>

/** Параметры для `navigator.credentials.create()`. */
export const PasskeyRegistrationOptions = z.looseObject({ challenge: z.string() })
export type PasskeyRegistrationOptions = z.infer<typeof PasskeyRegistrationOptions>

/** Параметры для `navigator.credentials.get()`. */
export const PasskeyAuthenticationOptions = z.looseObject({ challenge: z.string() })
export type PasskeyAuthenticationOptions = z.infer<typeof PasskeyAuthenticationOptions>

/** Ответ браузера — проверяется сервером целиком. */
export const PasskeyCredentialResponse = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.string().max(32),
  response: z.looseObject({}),
})
export type PasskeyCredentialResponse = z.infer<typeof PasskeyCredentialResponse>

export const PasskeyRegisterInput = z.object({
  name: z.string().min(1).max(100).default('Ключ входа'),
  credential: PasskeyCredentialResponse,
})
export type PasskeyRegisterInput = z.infer<typeof PasskeyRegisterInput>

export const PasskeyLoginInput = z.object({ credential: PasskeyCredentialResponse })
export type PasskeyLoginInput = z.infer<typeof PasskeyLoginInput>
