import { uuidv7 } from 'uuidv7'

/** UUID v7 — упорядоченные по времени идентификаторы (05-data-model.md). */
export function newId(): string {
  return uuidv7()
}

/** Идентификатор события: тот же формат, отдельная функция для читаемости. */
export function newEventId(): string {
  return uuidv7()
}

const HEX = '0123456789abcdef'

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  let out = ''
  for (const b of buf) out += HEX[b >> 4]! + HEX[b & 0x0f]!
  return out
}

/** Короткий человекочитаемый код (ссылки, коды восстановления). */
export function randomCode(length = 10): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const buf = new Uint8Array(length)
  crypto.getRandomValues(buf)
  let out = ''
  for (const b of buf) out += alphabet[b % alphabet.length]
  return out
}
