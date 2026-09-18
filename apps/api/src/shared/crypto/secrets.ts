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
 * секреты интеграций, TOTP-секреты, токены.
 */
const ALGO = 'aes-256-gcm'

function masterKey(): Buffer {
  const raw = config().KCHS_MASTER_KEY
  // допускаем base64 (32 байта) и произвольную строку (хэшируем до 32 байт)
  const asB64 = Buffer.from(raw, 'base64')
  return asB64.length === 32 ? asB64 : createHash('sha256').update(raw, 'utf8').digest()
}

export function encryptSecret(plain: string): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, masterKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc])
}

export function decryptSecret(payload: Buffer | Uint8Array): string {
  const buf = Buffer.from(payload)
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const data = buf.subarray(28)
  const decipher = createDecipheriv(ALGO, masterKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
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
