import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { config } from '~/shared/config/index.js'
import type { IntegrationRow } from '~/shared/db/schema/index.js'
import { checkMailbox } from '~/shared/mail/imap.js'
import { DATABASE_KINDS, ExternalDatabases } from './database-source.js'

/** Сколько ждём ответа при проверке связи и при доставке вебхука. */
export const OUTBOUND_TIMEOUT_MS = 10_000

/**
 * Частные и служебные диапазоны адресов. Исходящий вебхук и проверка связи не
 * должны становиться способом постучаться во внутренний периметр чужими руками
 * (SSRF, 17-security.md §5): адрес назначения проверяется до запроса.
 */
function isPrivateAddress(address: string): boolean {
  if (address.includes(':')) {
    const lower = address.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    // уникальные локальные (fc00::/7) и link-local (fe80::/10)
    if (/^f[cd]/.test(lower) || lower.startsWith('fe8') || lower.startsWith('fe9')) return true
    if (/^::ffff:/.test(lower)) return isPrivateAddress(lower.slice('::ffff:'.length))
    return false
  }
  const parts = address.split('.').map((part) => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true
  const [a = 0, b = 0] = parts
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

export interface UrlCheck {
  ok: boolean
  reason?: string
}

/** Проверяет, что по адресу можно ходить: только http/https и не внутрь сети. */
export async function checkOutboundUrl(raw: string): Promise<UrlCheck> {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: 'Некорректный адрес' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'Допустимы только http и https' }
  }
  if (config().WEBHOOKS_ALLOW_PRIVATE_ADDRESSES) return { ok: true }

  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, reason: 'Адрес во внутренней сети запрещён' }
      : { ok: true }
  }
  try {
    const records = await lookup(host, { all: true })
    if (records.length === 0) return { ok: false, reason: 'Имя не разрешается' }
    if (records.some((record) => isPrivateAddress(record.address))) {
      return { ok: false, reason: 'Имя указывает во внутреннюю сеть' }
    }
    return { ok: true }
  } catch {
    return { ok: false, reason: 'Имя не разрешается' }
  }
}

/**
 * Проверка соединения интеграции. Для `http` — запрос по адресу из
 * конфигурации, для `imap` — вход в ящик канцелярии (ADR-0113); остальные
 * виды сообщают, чего не хватает в конфигурации.
 */
export async function checkIntegration(
  row: IntegrationRow,
  secrets: Record<string, string>,
): Promise<{ ok: boolean; message: string }> {
  if (!row.enabled) return { ok: false, message: 'Интеграция выключена' }

  // Ящик канцелярии: настоящий вход по IMAP — открывается ли папка
  if (row.kind === 'imap') return checkMailbox(row.config, secrets)

  if (row.kind === 'http') {
    const url = typeof row.config.url === 'string' ? row.config.url : ''
    if (!url) return { ok: false, message: 'В конфигурации нет поля url' }
    const allowed = await checkOutboundUrl(url)
    if (!allowed.ok) return { ok: false, message: allowed.reason ?? 'Адрес недопустим' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: secrets.token ? { authorization: `Bearer ${secrets.token}` } : {},
      })
      return response.ok
        ? { ok: true, message: `Ответ ${response.status}` }
        : { ok: false, message: `Ответ ${response.status}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Нет соединения' }
    } finally {
      clearTimeout(timer)
    }
  }

  if (DATABASE_KINDS.has(row.kind)) return ExternalDatabases.check(row, secrets)

  const required = REQUIRED_SECRETS[row.kind] ?? []
  const missing = required.filter((key) => !secrets[key])
  if (missing.length > 0) {
    return { ok: false, message: `Не заданы секреты: ${missing.join(', ')}` }
  }
  return { ok: true, message: 'Конфигурация заполнена; проверка связи для этого вида не сделана' }
}

/** Что обязательно должно быть в секретах у каждого вида интеграции. */
const REQUIRED_SECRETS: Record<string, string[]> = {
  smtp: ['url'],
  telegram: ['botToken'],
  imap: ['password'],
  ldap: ['bindPassword'],
  oidc: ['clientSecret'],
  s3: ['secretKey'],
  sftp: ['password'],
  postgres: ['password'],
  mysql: ['password'],
  custom: [],
}
