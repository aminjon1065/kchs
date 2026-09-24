import { type LookupAddress, lookup } from 'node:dns'
import { BlockList, isIP, type LookupFunction } from 'node:net'
import { Agent, Dispatcher, ProxyAgent, request, setGlobalDispatcher } from 'undici'
import { config, type Env } from '~/shared/config/index.js'
import { errors, isAppError } from '~/shared/errors.js'
import { deniedAddress } from './private-address.js'

/**
 * Исходящие запросы платформы по адресу, который задают люди: ленты (ADR-0132),
 * растровые подложки и ГИС-службы (ADR-0066, ADR-0108), ICS-подписки (ADR-0081).
 * Реализация одна на всех (17-security.md §5):
 *
 * - напрямую — адрес проверяется после разрешения имени, в момент соединения:
 *   служебные сети (loopback, link-local, multicast, «этот узел») закрыты всегда,
 *   частные — по политике вызова;
 * - через исходящий прокси (`HTTPS_PROXY`/`HTTP_PROXY`, `NO_PROXY`) — имя разрешает
 *   прокси, поэтому закрыты адреса-литералы служебных сетей и `localhost`;
 * - перенаправления — не больше заданного числа, каждый шаг проверяется заново;
 * - ответ ограничен по времени, размеру и типу. В сообщении об ошибке нет адреса:
 *   в нём бывает ключ API.
 */

const DEFAULT_TIMEOUT_MS = 15_000
const USER_AGENT = 'kchs/1'

class BlockedAddressError extends Error {}

/** Loopback открыт интеграционным тестам и локальной отладке (`OUTBOUND_ALLOW_LOOPBACK`). */
const loopbackAllowed = () => config().NODE_ENV === 'test' || config().OUTBOUND_ALLOW_LOOPBACK

const privateNets = new BlockList()
privateNets.addSubnet('10.0.0.0', 8, 'ipv4')
privateNets.addSubnet('172.16.0.0', 12, 'ipv4')
privateNets.addSubnet('192.168.0.0', 16, 'ipv4')
privateNets.addSubnet('100.64.0.0', 10, 'ipv4')
privateNets.addSubnet('fc00::', 7, 'ipv6')

/**
 * Адрес закрыт для исходящего запроса: служебные сети — всегда (loopback — кроме
 * тестов и отладки), частные — если их закрывает политика вызова.
 */
export function outboundAddressDenied(address: string, denyPrivate = false): boolean {
  if (deniedAddress(address, loopbackAllowed())) return true
  if (!denyPrivate) return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  const ip = mapped?.[1] ?? address
  return privateNets.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6')
}

/** Разрешение имени с проверкой каждого адреса (и списка при `all: true` у Happy Eyeballs). */
function guardedLookup(denyPrivate: boolean): LookupFunction {
  return ((hostname, options, callback) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) {
        callback(error, address as string, family)
        return
      }
      const list: LookupAddress[] = Array.isArray(address)
        ? address
        : [{ address: address as string, family: family ?? 4 }]
      if (list.some((entry) => outboundAddressDenied(entry.address, denyPrivate))) {
        callback(new BlockedAddressError(hostname), '', 4)
        return
      }
      callback(null, address as string, family)
    })
  }) as LookupFunction
}

/** Настройки прокси установки: адреса прокси и узлы мимо него. */
export interface ProxySettings {
  http: string | null
  https: string | null
  /** Значение `NO_PROXY` со внутренними службами установки. */
  noProxy: string
}

/** Узлы служб установки: к ним запросы идут напрямую, даже если `NO_PROXY` их забыл. */
function internalHosts(env: Env): string[] {
  const hosts = new Set(['localhost', '127.0.0.1', '::1'])
  const urls = [
    env.KCHS_API_URL,
    env.S3_ENDPOINT,
    env.MEILI_HOST,
    env.ENGINE_INTERNAL_URL,
    env.ONLYOFFICE_INTERNAL_URL,
    env.LIVEKIT_URL,
  ]
  for (const value of urls) {
    if (!value) continue
    try {
      hosts.add(new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase())
    } catch {
      // Не адрес (например, пустая строка) — такого узла нет
    }
  }
  return [...hosts]
}

export function proxySettings(env: Env = config()): ProxySettings {
  const own = (env.NO_PROXY ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
  return {
    http: env.HTTP_PROXY ?? null,
    https: env.HTTPS_PROXY ?? env.HTTP_PROXY ?? null,
    noProxy: own.includes('*') ? '*' : [...own, ...internalHosts(env)].join(','),
  }
}

const proxied = (settings: ProxySettings) => Boolean(settings.http || settings.https)

interface NoProxyEntry {
  host: string
  /** 0 — любой порт. */
  port: number
}

/** Разбор `NO_PROXY`: `*`, имя, `.домен`, адрес, `[IPv6]:порт`, `имя:порт`. */
function parseNoProxy(value: string): NoProxyEntry[] | '*' {
  const entries: NoProxyEntry[] = []
  for (const raw of value.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return '*'
    if (isIP(entry)) {
      entries.push({ host: entry, port: 0 })
      continue
    }
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry)
    const named = /^(.+):(\d+)$/.exec(entry)
    if (bracketed) entries.push({ host: bracketed[1] as string, port: Number(bracketed[2] ?? 0) })
    else if (named) entries.push({ host: named[1] as string, port: Number(named[2]) })
    else entries.push({ host: entry, port: 0 })
  }
  return entries
}

/**
 * Узел идёт мимо прокси — по правилам undici: имя совпадает точно, запись с точки
 * (`.corp`, `*.corp`) — суффикс; порт записи, если задан, должен совпасть.
 */
export function bypassesProxy(url: URL, noProxy: string): boolean {
  const entries = parseNoProxy(noProxy)
  if (entries === '*') return true
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  return entries.some((entry) => {
    if (entry.port && entry.port !== port) return false
    return /^[.*]/.test(entry.host)
      ? host.endsWith(entry.host.replace(/^\*/, ''))
      : host === entry.host
  })
}

/**
 * Маршрутизатор запросов: узлы из `NO_PROXY` и службы установки — прямым агентом,
 * остальные — агентом прокси своей схемы. Адрес http через прокси идёт обычным
 * запросом, а не туннелем CONNECT: прокси вроде Squid туннели на порт 80
 * обычно не пускают; https — всегда туннелем.
 */
class RoutingDispatcher extends Dispatcher {
  private readonly http: Dispatcher | null
  private readonly https: Dispatcher | null

  constructor(
    private readonly direct: Dispatcher,
    private readonly settings: ProxySettings,
  ) {
    super()
    const agent = (uri: string | null) => (uri ? new ProxyAgent({ uri, proxyTunnel: false }) : null)
    this.http = agent(settings.http)
    this.https = settings.https === settings.http ? this.http : agent(settings.https)
  }

  private route(origin: string | URL | undefined): Dispatcher {
    const url = new URL(String(origin))
    if (bypassesProxy(url, this.settings.noProxy)) return this.direct
    const proxy = url.protocol === 'https:' ? this.https : this.http
    return proxy ?? this.direct
  }

  private all(): Dispatcher[] {
    return [...new Set([this.direct, this.http, this.https])].filter(
      (item): item is Dispatcher => item !== null,
    )
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandlers,
  ): boolean {
    return this.route(options.origin).dispatch(options, handler)
  }

  override close(): Promise<void>
  override close(callback: () => void): void
  override close(callback?: () => void): Promise<void> | undefined {
    const done = Promise.all(this.all().map((item) => item.close())).then(() => undefined)
    if (!callback) return done
    void done.then(callback)
    return undefined
  }

  override destroy(): Promise<void>
  override destroy(err: Error | null): Promise<void>
  override destroy(callback: () => void): void
  override destroy(err: Error | null, callback: () => void): void
  override destroy(
    first?: Error | null | (() => void),
    second?: () => void,
  ): Promise<void> | undefined {
    const err = typeof first === 'function' ? null : (first ?? null)
    const callback = typeof first === 'function' ? first : second
    const done = Promise.all(this.all().map((item) => item.destroy(err))).then(() => undefined)
    if (!callback) return done
    void done.then(callback)
    return undefined
  }
}

/**
 * Диспетчер запросов с заданной политикой частных сетей: прямые соединения —
 * с проверкой адреса в момент соединения, через прокси — имя разрешает прокси.
 */
const dispatchers = new Map<string, Dispatcher>()

function dispatcherFor(denyPrivate: boolean): Dispatcher {
  const settings = proxySettings()
  const key = JSON.stringify([denyPrivate, settings])
  let dispatcher = dispatchers.get(key)
  if (!dispatcher) {
    const direct = new Agent({ connect: { lookup: guardedLookup(denyPrivate) } })
    dispatcher = proxied(settings) ? new RoutingDispatcher(direct, settings) : direct
    dispatchers.set(key, dispatcher)
  }
  return dispatcher
}

/**
 * Прокси для остальных исходящих запросов процесса (глобальный `fetch`: вебхуки,
 * провайдеры ИИ, проверка интеграций): если прокси задан, `fetch` ходит через
 * него, а службы установки и `NO_PROXY` — напрямую. Вызывается при старте.
 */
export function configureOutboundProxy(): boolean {
  const settings = proxySettings()
  if (!proxied(settings)) return false
  setGlobalDispatcher(new RoutingDispatcher(new Agent(), settings))
  return true
}

export interface OutboundOptions {
  /** Что за служба — в сообщениях об ошибке («лента по адресу», «растровый сервер»). */
  what: string
  accept?: string
  headers?: Record<string, string>
  /**
   * Требуемый `content-type` успешного ответа: список — точный перечень типов,
   * строка — требуемое начало (`''` — любой).
   */
  expect?: string | readonly string[]
  maxBytes: number
  timeoutMs?: number
  /** Сколько перенаправлений выполнить; 0 — ответ 3xx возвращается как есть. */
  maxRedirects?: number
  /** Закрыть и частные сети (10/8, 172.16/12, 192.168/16…), а не только служебные. */
  denyPrivateNetworks?: boolean
}

export interface OutboundResponse {
  status: number
  /** Тип ответа без параметров, в нижнем регистре. */
  contentType: string
  /** Тело успешного ответа; у остальных — пусто. */
  body: Buffer
}

function mediaType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? ''
}

/** Тип ответа допустим: точный перечень или требуемое начало. */
function typeAllowed(contentType: string, expect: string | readonly string[]): boolean {
  const media = mediaType(contentType)
  return typeof expect === 'string' ? media.startsWith(expect) : expect.includes(media)
}

function headerOf(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

/** Адрес запроса: только http(s), служебные адреса-литералы и `localhost` закрыты сразу. */
function checkedUrl(target: string | URL, what: string, denyPrivate: boolean): URL {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw errors.validation(`Некорректный адрес: ${what}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw errors.validation(`Адрес должен быть http или https: ${what}`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const named = host === 'localhost' || host.endsWith('.localhost')
  if ((named && !loopbackAllowed()) || (isIP(host) && outboundAddressDenied(host, denyPrivate))) {
    throw errors.dependencyFailed(`Адрес закрыт для исходящих запросов: ${what}`)
  }
  return url
}

function failure(error: unknown, what: string, timeoutMs: number, signal: AbortSignal): Error {
  if (isAppError(error)) return error
  if (signal.aborted) {
    return errors.dependencyFailed(`Нет ответа за ${Math.round(timeoutMs / 1000)} с: ${what}`)
  }
  let cause: unknown = error
  for (let depth = 0; cause instanceof Error && depth < 5; depth++) {
    if (cause instanceof BlockedAddressError) {
      return errors.dependencyFailed(`Адрес закрыт для исходящих запросов: ${what}`)
    }
    cause = cause.cause
  }
  return errors.dependencyFailed(`Нет соединения: ${what}`, {
    reason: error instanceof Error ? error.message : String(error),
  })
}

/**
 * GET внешней службы. Успешный ответ (2xx) приходит с телом, проверенным по типу и
 * размеру; остальные — только с кодом, решает вызывающий. Сбой сети, тайм-аут,
 * закрытый адрес, лишний размер — `dependency_failed` без адреса в сообщении.
 */
export async function outboundGet(
  target: string,
  options: OutboundOptions,
): Promise<OutboundResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const denyPrivate = options.denyPrivateNetworks ?? false
  const signal = AbortSignal.timeout(timeoutMs)
  let url = checkedUrl(target, options.what, denyPrivate)
  for (let hop = 0; ; hop++) {
    let response: Dispatcher.ResponseData
    try {
      response = await request(url, {
        method: 'GET',
        dispatcher: dispatcherFor(denyPrivate),
        headers: {
          accept: options.accept ?? '*/*',
          'user-agent': USER_AGENT,
          ...options.headers,
        },
        signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      })
    } catch (error) {
      throw failure(error, options.what, timeoutMs, signal)
    }
    const status = response.statusCode
    const location = headerOf(response.headers, 'location')
    if (status >= 300 && status < 400 && location && (options.maxRedirects ?? 0) > 0) {
      await response.body.dump().catch(() => undefined)
      if (hop >= (options.maxRedirects ?? 0)) {
        throw errors.dependencyFailed(`Слишком много перенаправлений: ${options.what}`)
      }
      url = checkedUrl(new URL(location, url), options.what, denyPrivate)
      continue
    }
    const contentType = headerOf(response.headers, 'content-type')
    if (status < 200 || status >= 300) {
      await response.body.dump().catch(() => undefined)
      return { status, contentType: mediaType(contentType), body: Buffer.alloc(0) }
    }
    if (options.expect !== undefined && !typeAllowed(contentType, options.expect)) {
      await response.body.dump().catch(() => undefined)
      throw errors.dependencyFailed(`Неожиданный ответ: ${options.what}`, {
        status,
        contentType: mediaType(contentType),
      })
    }
    const declared = Number(headerOf(response.headers, 'content-length') || 0)
    if (declared > options.maxBytes) {
      response.body.destroy()
      throw errors.dependencyFailed(`Ответ слишком большой: ${options.what}`, { bytes: declared })
    }
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of response.body) {
        size += (chunk as Buffer).length
        if (size > options.maxBytes) {
          response.body.destroy()
          throw errors.dependencyFailed(`Ответ слишком большой: ${options.what}`, { bytes: size })
        }
        chunks.push(chunk as Buffer)
      }
    } catch (error) {
      if (isAppError(error)) throw error
      if (signal.aborted) throw failure(error, options.what, timeoutMs, signal)
      throw errors.dependencyFailed(`Ответ оборвался: ${options.what}`, {
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    return { status, contentType: mediaType(contentType), body: Buffer.concat(chunks) }
  }
}
