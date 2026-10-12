import { randomBytes, X509Certificate } from 'node:crypto'
import { QesCaConfig } from '@kchs/contracts'
import type { QualifiedSignatureAuthority } from '~/kernel/signature/port.js'
import { AppError, errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { checkOutboundUrl, OUTBOUND_TIMEOUT_MS } from './checks.js'

/**
 * Интеграция «Удостоверяющий центр» (`qes_ca`, ADR-0205): агент УЦ на рабочем
 * месте, сервер штампов времени, доверенные корни и строгость проверки отзыва.
 * Отсюда порт ядра `qualifiedSignature()` берёт подключённый УЦ, а «Проверить
 * соединение» — корни и ответ TSA. Агента сервер не видит: он на рабочем месте,
 * его проверяет страница подписания.
 */

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/** Блоки PEM сертификатов из текста конфигурации. */
export function pemBlocks(bundle: string): string[] {
  return bundle.match(PEM_BLOCK) ?? []
}

/** Конфигурация `qes_ca` по контракту; ошибка — понятная администратору. */
export function parseQesConfig(config: Record<string, unknown>): QesCaConfig {
  const parsed = QesCaConfig.safeParse(config)
  if (!parsed.success) {
    throw errors.validation(
      'Конфигурация удостоверяющего центра заполнена неверно',
      parsed.error.issues.map((issue) => ({
        path: `config.${issue.path.join('.')}`,
        message: issue.message,
      })),
    )
  }
  const roots = pemBlocks(parsed.data.trustRoots)
  if (roots.length === 0) {
    throw errors.validation('Укажите доверенные корни УЦ в формате PEM', [
      { path: 'config.trustRoots', message: 'Нет ни одного блока BEGIN CERTIFICATE' },
    ])
  }
  return parsed.data
}

interface RootReport {
  ok: boolean
  message: string
}

/** Корни: разбираются, это сертификаты УЦ и они действуют сейчас. */
export function checkRoots(bundle: string, now = new Date()): RootReport {
  const blocks = pemBlocks(bundle)
  if (blocks.length === 0) return { ok: false, message: 'Нет доверенных корней в PEM' }
  const problems: string[] = []
  let authorities = 0
  for (const [index, block] of blocks.entries()) {
    let cert: X509Certificate
    try {
      cert = new X509Certificate(block)
    } catch {
      problems.push(`сертификат ${index + 1} не разбирается`)
      continue
    }
    if (cert.ca) authorities += 1
    if (new Date(cert.validTo) < now || new Date(cert.validFrom) > now) {
      problems.push(`сертификат ${index + 1} не действует (${cert.validFrom} — ${cert.validTo})`)
    }
  }
  if (authorities === 0) problems.push('среди сертификатов нет сертификата УЦ (CA)')
  return problems.length > 0
    ? { ok: false, message: `Доверенные корни: ${problems.join('; ')}` }
    : { ok: true, message: `Доверенных сертификатов: ${blocks.length}` }
}

// ─── Запрос штампа времени (RFC 3161) без библиотек ASN.1 ───────────────────

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

/** `TimeStampReq` над хэшем: версия 1, SHA-256, случайный nonce, нужен сертификат TSA. */
export function timestampRequest(digest: Buffer, nonce = randomBytes(8)): Buffer {
  // nonce — положительное INTEGER: старший бит первого байта сброшен
  const positive = Buffer.from(nonce)
  positive[0] = (positive[0] ?? 0) & 0x7f
  const sha256 = Buffer.from('300d06096086480165030402010500', 'hex')
  return der(
    0x30,
    Buffer.concat([
      der(0x02, Buffer.from([1])),
      der(0x30, Buffer.concat([sha256, der(0x04, digest)])),
      der(0x02, positive),
      der(0x01, Buffer.from([0xff])),
    ]),
  )
}

function readHeader(data: Buffer, offset: number): { tag: number; start: number; end: number } {
  const tag = data[offset]
  const first = data[offset + 1]
  if (tag === undefined || first === undefined) throw new Error('ответ обрезан')
  if (first < 0x80) return { tag, start: offset + 2, end: offset + 2 + first }
  const count = first & 0x7f
  if (count === 0 || count > 4) throw new Error('неверная длина DER')
  let length = 0
  for (let index = 0; index < count; index += 1) {
    const byte = data[offset + 2 + index]
    if (byte === undefined) throw new Error('ответ обрезан')
    length = length * 256 + byte
  }
  return { tag, start: offset + 2 + count, end: offset + 2 + count + length }
}

/** `PKIStatus` из `TimeStampResp`: 0 — выдан, 1 — выдан с изменениями, остальное — отказ. */
export function timestampStatus(response: Buffer): number {
  const outer = readHeader(response, 0)
  if (outer.tag !== 0x30 || outer.end > response.length) throw new Error('не TimeStampResp')
  const info = readHeader(response, outer.start)
  if (info.tag !== 0x30) throw new Error('нет PKIStatusInfo')
  const status = readHeader(response, info.start)
  if (status.tag !== 0x02 || status.end - status.start !== 1) throw new Error('нет PKIStatus')
  return response[status.start] ?? -1
}

async function checkTimestampServer(
  config: QesCaConfig,
  secrets: Record<string, string>,
): Promise<RootReport> {
  if (!config.tsaUrl) {
    return { ok: true, message: 'Сервер штампов времени не задан — подпись без времени TSA' }
  }
  const allowed = await checkOutboundUrl(config.tsaUrl)
  if (!allowed.ok) return { ok: false, message: `TSA: ${allowed.reason ?? 'адрес недопустим'}` }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'content-type': 'application/timestamp-query' }
    if (config.tsaUsername) {
      const pair = `${config.tsaUsername}:${secrets.tsaPassword ?? ''}`
      headers.authorization = `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`
    }
    const response = await fetch(config.tsaUrl, {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers,
      body: new Uint8Array(timestampRequest(randomBytes(32))),
    })
    if (!response.ok) return { ok: false, message: `TSA: ответ ${response.status}` }
    const status = timestampStatus(Buffer.from(await response.arrayBuffer()))
    return status === 0 || status === 1
      ? { ok: true, message: 'TSA выдал штамп времени' }
      : { ok: false, message: `TSA отказал в штампе (статус ${status})` }
  } catch (error) {
    return {
      ok: false,
      message: `TSA: ${error instanceof Error ? error.message : 'нет соединения'}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** «Проверить соединение» для `qes_ca`: конфигурация, корни и сервер штампов времени. */
export async function checkQesAuthority(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): Promise<{ ok: boolean; message: string }> {
  let parsed: QesCaConfig
  try {
    parsed = parseQesConfig(config)
  } catch (error) {
    const fields = error instanceof AppError ? (error.fieldErrors ?? []) : []
    const text = fields.map((item) => `${item.path}: ${item.message}`).join('; ')
    return { ok: false, message: text || (error as Error).message }
  }
  const roots = checkRoots(parsed.trustRoots)
  const tsa = await checkTimestampServer(parsed, secrets)
  const agent = `агент УЦ проверяется на рабочем месте (${parsed.agentUrl})`
  return {
    ok: roots.ok && tsa.ok,
    message: [roots.message, tsa.message, agent].join('. '),
  }
}

/** Подключённый УЦ для порта ядра: первая включённая интеграция `qes_ca` по ключу. */
export function authorityFrom(
  integration: {
    id: string
    name: string
    config: Record<string, unknown>
    secrets: Record<string, string>
  } | null,
): QualifiedSignatureAuthority | null {
  if (!integration) return null
  let config: QesCaConfig
  try {
    config = parseQesConfig(integration.config)
  } catch (error) {
    logger().warn(
      { integrationId: integration.id, error: (error as Error).message },
      'интеграция УЦ настроена неверно — квалифицированная подпись недоступна',
    )
    return null
  }
  return {
    integrationId: integration.id,
    name: integration.name,
    agentUrl: config.agentUrl.replace(/\/+$/, ''),
    timestamp: config.tsaUrl
      ? {
          url: config.tsaUrl,
          username: config.tsaUsername ?? null,
          password: config.tsaUsername ? (integration.secrets.tsaPassword ?? null) : null,
        }
      : null,
    policy: {
      trustRootsPem: pemBlocks(config.trustRoots),
      revocation: config.revocation,
      fetchRevocation: config.fetchRevocation,
    },
  }
}
