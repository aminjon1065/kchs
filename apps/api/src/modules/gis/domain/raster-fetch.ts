import { config } from '~/shared/config/index.js'
import { errors } from '~/shared/errors.js'
import { outboundGet } from '~/shared/net/outbound.js'
import { deniedAddress as deniedNetAddress } from '~/shared/net/private-address.js'

/**
 * Запрос тайла у растрового сервера для прокси подложки (ADR-0066). Адрес задаёт
 * управляющий подложками, но прокси не должен становиться ходом во внутренние
 * сервисы (17-security.md): закрыты loopback, link-local (метаданные облака),
 * «этот узел» и multicast — адрес проверяется после разрешения имени, в момент
 * соединения (подмена DNS не обходит проверку). Частные сети открыты: сервер
 * тайлов закрытого контура обычно в них. Ответ — только изображение не больше
 * 5 МБ, без перенаправлений. Запрос идёт общим исходящим клиентом платформы —
 * через исходящий прокси, если он задан (ADR-0132).
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
  const response = await outboundGet(target, {
    what: options.what,
    accept: options.accept,
    expect: options.expect,
    maxBytes: options.maxBytes,
    timeoutMs: TIMEOUT_MS,
  })
  if (response.status === 204 || response.status === 404) return null
  if (response.status !== 200) {
    throw errors.dependencyFailed(`Неожиданный ответ: ${options.what}`, {
      status: response.status,
      contentType: response.contentType,
    })
  }
  // Наружу уходит проверенный тип, а не строка чужой службы целиком
  return { body: response.body, contentType: response.contentType }
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
