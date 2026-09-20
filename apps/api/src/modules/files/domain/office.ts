import { createHmac, timingSafeEqual } from 'node:crypto'
import { OFFICE_FORMATS, type OfficeDocumentType, officeFormat } from '@kchs/contracts'
import { config } from '~/shared/config/index.js'

/**
 * Связь с сервером документов ONLYOFFICE (09-files.md §7, ADR-0112).
 *
 * Сервер документов — посторонняя служба: она забирает файл по адресу, который
 * мы ей дали, и возвращает правку колбэком. Поэтому оба направления подписаны
 * общим секретом (`ONLYOFFICE_JWT_SECRET`): конфигурация редактора уезжает с
 * подписью, а колбэк без действительной подписи не принимается.
 */

export interface OfficeConfig {
  /** Адрес сервера документов для браузера. */
  url: string
  /** Адрес сервера документов изнутри развёртывания (проверка живости). */
  internalUrl: string
  /** Адрес api, каким его видит сервер документов. */
  callbackUrl: string
  secret: string
}

/** Настройка установки; `null` — совместное редактирование выключено. */
export function officeConfig(): OfficeConfig | null {
  const env = config()
  const url = env.ONLYOFFICE_URL?.replace(/\/+$/, '')
  const secret = env.ONLYOFFICE_JWT_SECRET
  if (!url || !secret) return null
  return {
    url,
    internalUrl: (env.ONLYOFFICE_INTERNAL_URL ?? url).replace(/\/+$/, ''),
    // Сервер документов живёт в сети развёртывания: `localhost` для него — он сам
    callbackUrl: (env.ONLYOFFICE_CALLBACK_URL ?? 'http://host.docker.internal:3000').replace(
      /\/+$/,
      '',
    ),
    secret,
  }
}

export const OFFICE_EXTENSIONS = Object.keys(OFFICE_FORMATS)

/** Вид документа для редактора: текст, таблица, презентация. */
export function officeDocumentType(name: string): OfficeDocumentType | null {
  const format = officeFormat(name)
  return format ? OFFICE_FORMATS[format] : null
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

/**
 * JWT HS256 — формат, который понимает сервер документов. Своя реализация на
 * восемь строк: ради одного алгоритма с одним секретом зависимость не нужна.
 */
export function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds = 600,
): string {
  const now = Math.floor(Date.now() / 1000)
  const body = { ...payload, iat: now, exp: now + ttlSeconds }
  const head = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const data = `${head}.${base64url(JSON.stringify(body))}`
  const signature = createHmac('sha256', secret).update(data).digest('base64url')
  return `${data}.${signature}`
}

/** Разбор и проверка подписи; `null` — подпись не сошлась или срок вышел. */
export function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [head, body, signature] = parts as [string, string, string]
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const claims = parsed as Record<string, unknown>
    const exp = typeof claims.exp === 'number' ? claims.exp : null
    if (exp !== null && exp < Math.floor(Date.now() / 1000)) return null
    return claims
  } catch {
    return null
  }
}

/**
 * Одноразовый пропуск для сервера документов: он ходит за файлом и шлёт колбэк
 * без сессии, поэтому адрес несёт подпись с сроком. Сессия в подписи — свой
 * пропуск у каждой сессии редактирования.
 */
export function officeTicket(sessionId: string, purpose: string, secret: string, ttlMs: number) {
  const expires = Date.now() + ttlMs
  const mac = createHmac('sha256', secret)
    .update(`${purpose}:${sessionId}:${expires}`)
    .digest('hex')
  return `${expires}.${mac}`
}

export function checkTicket(
  ticket: string,
  sessionId: string,
  purpose: string,
  secret: string,
): boolean {
  const dot = ticket.indexOf('.')
  if (dot <= 0) return false
  const expires = Number(ticket.slice(0, dot))
  if (!Number.isInteger(expires) || expires < Date.now()) return false
  const expected = createHmac('sha256', secret)
    .update(`${purpose}:${sessionId}:${expires}`)
    .digest('hex')
  const a = Buffer.from(ticket.slice(dot + 1))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Живость сервера документов: по ней карточка решает, открывать ли редактор. */
export async function officeHealthy(
  timeoutMs = 5000,
): Promise<{ ok: boolean; message: string | null }> {
  const office = officeConfig()
  if (!office) return { ok: false, message: null }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${office.internalUrl}/healthcheck`, {
      signal: controller.signal,
      redirect: 'manual',
    })
    if (!response.ok) return { ok: false, message: `Ответ ${response.status}` }
    // Сервер документов отвечает строкой `true`, пока все его службы живы
    const body = (await response.text()).trim().toLowerCase()
    return body === 'true'
      ? { ok: true, message: null }
      : { ok: false, message: 'Сервер документов не готов' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Нет соединения' }
  } finally {
    clearTimeout(timer)
  }
}
