import { type LookupAddress, lookup } from 'node:dns'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { config } from '~/shared/config/index.js'
import { errors, isAppError } from '~/shared/errors.js'
import { deniedAddress as deniedNetAddress } from '~/shared/net/private-address.js'

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

/** Сервер тайлов интеграционных тестов слушает loopback — только в тестовой среде. */
const loopbackAllowed = () => config().NODE_ENV === 'test'

/**
 * Адрес закрыт для прокси. Перечень служебных сетей — один на платформу
 * (`shared/net/private-address.ts`, ADR-0108): вторая копия успела разойтись с
 * первой по обработке loopback, а расхождение в таком списке — это дыра.
 */
export function deniedAddress(address: string): boolean {
  return deniedNetAddress(address, loopbackAllowed())
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

/**
 * Типы, которые прокси готов отдать браузером со своего origin. `image/` целиком
 * сюда не годится: `image/svg+xml` — исполняемый документ, и чужая служба (или
 * тот, кто завёл её адрес) получила бы через наш прокси хранимый XSS на домене
 * установки. Растровые форматы браузер только рисует.
 */
export const RASTER_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/tiff',
  'image/bmp',
]

export interface FetchOptions {
  /** Заголовок `accept` запроса. */
  accept: string
  /**
   * Требуемый `content-type` ответа: список — точный перечень допустимых типов
   * (тайл), строка — требуемое начало (`` — любой).
   */
  expect: string | readonly string[]
  maxBytes: number
  /** Имя службы в сообщениях об ошибке. */
  what: string
}

/** Тип ответа допустим: точный перечень или требуемое начало. */
function typeAllowed(contentType: string, expect: string | readonly string[]): boolean {
  const media = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return Array.isArray(expect) ? expect.includes(media) : media.startsWith(expect as string)
}

/**
 * Запрос к внешней ГИС-службе с той же защитой, что у прокси тайлов (ADR-0066,
 * ADR-0108): адрес проверяется в момент соединения, перенаправления не
 * выполняются, ответ ограничен по размеру и типу. null — у службы нет ответа
 * (204/404).
 */
export async function fetchExternal(
  target: string,
  options: FetchOptions,
): Promise<RasterTile | null> {
  const url = new URL(target)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw errors.validation(`Адрес ${options.what} должен быть http(s)`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  // Адрес-литерал соединяется без разрешения имени — проверяем здесь
  if (isIP(host) && deniedAddress(host)) {
    throw errors.dependencyFailed(`Адрес ${options.what} закрыт для прокси`)
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
          headers: { accept: options.accept, 'user-agent': 'kchs-basemap-proxy/1' },
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
      blocked ? `Адрес ${options.what} закрыт для прокси` : `${options.what} недоступен`,
      { reason: error instanceof Error ? error.message : String(error) },
    )
  }

  const status = response.statusCode ?? 0
  if (status === 204 || status === 404) {
    response.resume()
    return null
  }
  const contentType = String(response.headers['content-type'] ?? '')
  if (status !== 200 || (options.expect.length > 0 && !typeAllowed(contentType, options.expect))) {
    response.resume()
    throw errors.dependencyFailed(`${options.what} вернул неожиданный ответ`, {
      status,
      contentType,
    })
  }
  const declared = Number(response.headers['content-length'] ?? 0)
  if (declared > options.maxBytes) {
    response.destroy()
    throw errors.dependencyFailed(`Ответ ${options.what} слишком большой`, { bytes: declared })
  }

  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response) {
      size += (chunk as Buffer).length
      if (size > options.maxBytes) {
        response.destroy()
        throw errors.dependencyFailed(`Ответ ${options.what} слишком большой`, { bytes: size })
      }
      chunks.push(chunk as Buffer)
    }
  } catch (error) {
    if (isAppError(error)) throw error
    throw errors.dependencyFailed(`${options.what} оборвал ответ`, {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  return {
    body: Buffer.concat(chunks),
    // Наружу уходит проверенный тип, а не строка чужой службы целиком
    contentType: contentType.split(';')[0]?.trim().toLowerCase() ?? contentType,
  }
}

/** Тайл или null (у сервера нет тайла: 204/404); сбой сервера — `dependency_failed`. */
export async function fetchRasterTile(target: string): Promise<RasterTile | null> {
  return fetchExternal(target, {
    accept: 'image/*',
    expect: RASTER_CONTENT_TYPES,
    maxBytes: MAX_BYTES,
    what: 'растровый сервер',
  })
}
