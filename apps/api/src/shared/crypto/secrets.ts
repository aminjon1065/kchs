import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { config } from '../config/index.js'

/**
 * AES-256-GCM с мастер-ключом из окружения (17-security.md §4):
 * секреты интеграций, TOTP-секреты, токены. При смене ключа (ADR-0143) прежний
 * ключ задаётся в `KCHS_MASTER_KEY_PREVIOUS`: расшифровка пробует сначала текущий,
 * потом прежний, а `kchs secrets rotate` перешифровывает всё текущим.
 */
const ALGO = 'aes-256-gcm'

// допускаем base64 (32 байта) и произвольную строку (хэшируем до 32 байт)
function keyFrom(raw: string): Buffer {
  const asB64 = Buffer.from(raw, 'base64')
  return asB64.length === 32 ? asB64 : createHash('sha256').update(raw, 'utf8').digest()
}

function masterKey(): Buffer {
  return keyFrom(config().KCHS_MASTER_KEY)
}

function previousKey(): Buffer | null {
  const raw = config().KCHS_MASTER_KEY_PREVIOUS
  return raw ? keyFrom(raw) : null
}

function decryptWith(key: Buffer, buf: Buffer): string {
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const data = buf.subarray(28)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

export function encryptSecret(plain: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, masterKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc])
}

/** Тег GCM проверяет ключ: чужим ключом расшифровка не проходит, а не даёт мусор. */
export function decryptSecret(payload: Buffer | Uint8Array): string {
  const buf = Buffer.from(payload)
  try {
    return decryptWith(masterKey(), buf)
  } catch (error) {
    const previous = previousKey()
    if (!previous) throw error
    return decryptWith(previous, buf)
  }
}

/**
 * Перешифрование текущим ключом (`kchs secrets rotate`): уже зашифрованное им не
 * трогается, прежним — перешифровывается, не читаемое ни одним — `null`.
 */
export function reencryptSecret(
  payload: Buffer | Uint8Array,
): { state: 'current' } | { state: 'rotated'; payload: Buffer } | { state: 'unreadable' } {
  const buf = Buffer.from(payload)
  try {
    decryptWith(masterKey(), buf)
    return { state: 'current' }
  } catch {
    const previous = previousKey()
    if (!previous) return { state: 'unreadable' }
    try {
      return { state: 'rotated', payload: encryptSecret(decryptWith(previous, buf)) }
    } catch {
      return { state: 'unreadable' }
    }
  }
}

/** Хэш для хранения токенов сессий/ссылок: сравнение в постоянное время. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
