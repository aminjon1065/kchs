import { type LookupAddress, lookup } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { config } from '~/shared/config/index.js'
import { errors, isAppError } from '~/shared/errors.js'

/**
 * Чтение внешнего ICS-канала для подписки (ADR-0081, 17-security.md): адрес
 * задаёт пользователь, поэтому запрос не должен становиться ходом во
 * внутренние сервисы. Закрыты loopback, link-local (метаданные облака), «этот
 * узел», multicast и частные сети (включаются настройкой
 * `CALENDAR_FEEDS_ALLOW_PRIVATE` для каналов закрытого контура). Адрес
 * проверяется после разрешения имени, в момент соединения, и на каждом
 * перенаправлении. Ответ — не больше 5 МБ, 15 секунд.
 */

const TIMEOUT_MS = 15_000
const MAX_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 3

const always = new BlockList()
always.addSubnet('0.0.0.0', 8, 'ipv4')
always.addSubnet('127.0.0.0', 8, 'ipv4')
always.addSubnet('169.254.0.0', 16, 'ipv4')
always.addSubnet('224.0.0.0', 3, 'ipv4')
always.addAddress('::', 'ipv6')
always.addAddress('::1', 'ipv6')
always.addSubnet('fe80::', 10, 'ipv6')
always.addSubnet('ff00::', 8, 'ipv6')

const privateNets = new BlockList()
privateNets.addSubnet('10.0.0.0', 8, 'ipv4')
privateNets.addSubnet('172.16.0.0', 12, 'ipv4')
privateNets.addSubnet('192.168.0.0', 16, 'ipv4')
privateNets.addSubnet('100.64.0.0', 10, 'ipv4')
privateNets.addSubnet('fc00::', 7, 'ipv6')

/** Сервер интеграционных тестов слушает loopback — только в тестовой среде. */
const loopbackAllowed = () => config().NODE_ENV === 'test'

/** Адрес закрыт для чтения канала; IPv4 в IPv6 (`::ffff:a.b.c.d`) проверяется как IPv4. */
export function feedAddressDenied(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  const ip = mapped?.[1] ?? address
  const family = isIP(ip)
  if (family === 0) return true
  const type = family === 4 ? 'ipv4' : 'ipv6'
  if ((ip === '::1' || ip.startsWith('127.')) && loopbackAllowed()) return false
  if (always.check(ip, type)) return true
  return privateNets.check(ip, type) && !config().CALENDAR_FEEDS_ALLOW_PRIVATE
}

class DeniedAddressError extends Error {}

const guardedLookup = ((hostname, options, callback) => {
  lookup(hostname, options, (error, address, family) => {
    if (error) {
      callback(error, address as string, family)
      return
    }
    const list: LookupAddress[] = Array.isArray(address)
      ? address
      : [{ address: address as string, family: family ?? 4 }]
    if (list.some((entry) => feedAddressDenied(entry.address))) {
      callback(new DeniedAddressError(`адрес ${hostname} закрыт`), '', 4)
      return
    }
    callback(null, address as string, family)
  })
}) as LookupFunction

function checkUrl(url: URL): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw errors.validation('Адрес календаря должен быть http(s)')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && feedAddressDenied(host)) {
    throw errors.dependencyFailed('Адрес календаря закрыт для подписки')
  }
}

function send(url: URL): Promise<IncomingMessage> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup,
        headers: {
          accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1',
          'user-agent': 'kchs-calendar/1',
        },
        timeout: TIMEOUT_MS,
      },
      resolve,
    )
    outgoing.on('timeout', () => outgoing.destroy(new Error('тайм-аут')))
    outgoing.on('error', reject)
    outgoing.end()
  })
}

/** Текст канала подписки; сбой — `dependency_failed` с причиной без содержимого ответа. */
export async function fetchIcs(address: string): Promise<string> {
  let url = new URL(address)
  for (let hop = 0; ; hop++) {
    checkUrl(url)
    let response: IncomingMessage
    try {
      response = await send(url)
    } catch (error) {
      throw errors.dependencyFailed(
        error instanceof DeniedAddressError
          ? 'Адрес календаря закрыт для подписки'
          : 'Календарь по адресу недоступен',
      )
    }
    const status = response.statusCode ?? 0
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume()
      if (hop >= MAX_REDIRECTS) throw errors.dependencyFailed('Слишком много перенаправлений')
      url = new URL(response.headers.location, url)
      continue
    }
    if (status !== 200) {
      response.resume()
      throw errors.dependencyFailed('Календарь по адресу не отдан', { status })
    }
    const declared = Number(response.headers['content-length'] ?? 0)
    if (declared > MAX_BYTES) {
      response.destroy()
      throw errors.dependencyFailed('Календарь больше 5 МБ')
    }
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of response) {
        size += (chunk as Buffer).length
        if (size > MAX_BYTES) {
          response.destroy()
          throw errors.dependencyFailed('Календарь больше 5 МБ')
        }
        chunks.push(chunk as Buffer)
      }
    } catch (error) {
      if (isAppError(error)) throw error
      throw errors.dependencyFailed('Календарь по адресу оборвал ответ')
    }
    return Buffer.concat(chunks).toString('utf8')
  }
}
