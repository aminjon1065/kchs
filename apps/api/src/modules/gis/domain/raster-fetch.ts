import { type LookupAddress, lookup } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { config } from '~/shared/config/index.js'
import { errors, isAppError } from '~/shared/errors.js'

/**
 * Запрос тайла у растрового сервера для прокси подложки (ADR-0066). Адрес задаёт
 * управляющий подложками, но прокси не должен становиться ходом во внутренние
 * сервисы (17-security.md): закрыты loopback, link-local (метаданные облака),
 * «этот узел» и multicast — адрес проверяется после разрешения имени, в момент
 * соединения (подмена DNS не обходит проверку). Частные сети открыты: сервер
 * тайлов закрытого контура обычно в них. Ответ — только изображение не больше
 * 5 МБ, без перенаправлений.
 */

const TIMEOUT_MS = 10_000
const MAX_BYTES = 5 * 1024 * 1024

const denied = new BlockList()
denied.addSubnet('0.0.0.0', 8, 'ipv4')
denied.addSubnet('127.0.0.0', 8, 'ipv4')
denied.addSubnet('169.254.0.0', 16, 'ipv4')
denied.addSubnet('224.0.0.0', 3, 'ipv4')
denied.addAddress('::', 'ipv6')
denied.addAddress('::1', 'ipv6')
denied.addSubnet('fe80::', 10, 'ipv6')
denied.addSubnet('ff00::', 8, 'ipv6')

/** Сервер тайлов интеграционных тестов слушает loopback — только в тестовой среде. */
const loopbackAllowed = () => config().NODE_ENV === 'test'

/** Адрес закрыт для прокси; IPv4 в IPv6 (`::ffff:a.b.c.d`) проверяется как IPv4. */
export function deniedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  const ip = mapped?.[1] ?? address
  const family = isIP(ip)
  if (family === 0) return true
  if ((ip === '::1' || ip.startsWith('127.')) && loopbackAllowed()) return false
  return denied.check(ip, family === 4 ? 'ipv4' : 'ipv6')
}

class DeniedAddressError extends Error {
  readonly code = 'EKCHSDENIED'
}

/** Разрешение имени с проверкой каждого адреса (и при `all: true` — у Happy Eyeballs). */
const guardedLookup = ((hostname, options, callback) => {
  lookup(hostname, options, (error, address, family) => {
    if (error) {
      callback(error, address as string, family)
      return
    }
    const list: LookupAddress[] = Array.isArray(address)
      ? address
      : [{ address: address as string, family: family ?? 4 }]
    if (list.some((entry) => deniedAddress(entry.address))) {
      callback(new DeniedAddressError(`адрес ${hostname} закрыт для прокси`), '', 4)
      return
    }
    callback(null, address as string, family)
  })
}) as LookupFunction

export interface RasterTile {
  body: Buffer
  contentType: string
}

/** Тайл или null (у сервера нет тайла: 204/404); сбой сервера — `dependency_failed`. */
export async function fetchRasterTile(target: string): Promise<RasterTile | null> {
  const url = new URL(target)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw errors.validation('Адрес растрового сервера должен быть http(s)')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  // Адрес-литерал соединяется без разрешения имени — проверяем здесь
  if (isIP(host) && deniedAddress(host)) {
    throw errors.dependencyFailed('Адрес растрового сервера закрыт для прокси')
  }
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest

  let response: IncomingMessage
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = send(
        url,
        {
          method: 'GET',
          lookup: guardedLookup,
          headers: { accept: 'image/*', 'user-agent': 'kchs-basemap-proxy/1' },
          timeout: TIMEOUT_MS,
        },
        resolve,
      )
      request.on('timeout', () => request.destroy(new Error('тайм-аут')))
      request.on('error', reject)
      request.end()
    })
  } catch (error) {
    const blocked = error instanceof DeniedAddressError
    throw errors.dependencyFailed(
      blocked ? 'Адрес растрового сервера закрыт для прокси' : 'Растровый сервер недоступен',
      { reason: error instanceof Error ? error.message : String(error) },
    )
  }

  const status = response.statusCode ?? 0
  if (status === 204 || status === 404) {
    response.resume()
    return null
  }
  const contentType = String(response.headers['content-type'] ?? '')
  if (status !== 200 || !contentType.startsWith('image/')) {
    response.resume()
    throw errors.dependencyFailed('Растровый сервер вернул не изображение', {
      status,
      contentType,
    })
  }
  const declared = Number(response.headers['content-length'] ?? 0)
  if (declared > MAX_BYTES) {
    response.destroy()
    throw errors.dependencyFailed('Тайл растрового сервера слишком большой', { bytes: declared })
  }

  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response) {
      size += (chunk as Buffer).length
      if (size > MAX_BYTES) {
        response.destroy()
        throw errors.dependencyFailed('Тайл растрового сервера слишком большой', { bytes: size })
      }
      chunks.push(chunk as Buffer)
    }
  } catch (error) {
    if (isAppError(error)) throw error
    throw errors.dependencyFailed('Растровый сервер оборвал ответ', {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  return {
    body: Buffer.concat(chunks),
    contentType: contentType.split(';')[0]?.trim() ?? contentType,
  }
}
