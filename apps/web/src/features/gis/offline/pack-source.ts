import type { RangeResponse, Source } from 'pmtiles'
import { matchAsset, putAsset, readPacked } from './pack-store.js'

/**
 * Чтение подложки с учётом района на устройстве (ADR-0211). Архив PMTiles читается
 * диапазонами байтов: диапазон, который покрывает район, берётся с устройства — и без
 * сети, и при связи (быстрее и не зависит от «связь есть, интернета нет»), остальное —
 * из сети, как раньше.
 */

/** Адрес архива из адреса протокола: `pmtiles://<адрес>` и `pmtiles://<адрес>/z/x/y`. */
export function archiveUrl(url: string): string | null {
  const match = /^pmtiles:\/\/(.+?)(?:\/\d+\/\d+\/\d+)?$/.exec(url)
  return match?.[1] ?? null
}

/** Путь архива в API без origin — ключ района: страницу открывают и по другим адресам. */
export function archivePath(url: string): string | null {
  try {
    return new URL(url).pathname
  } catch {
    return null
  }
}

/** Источник архива: сначала район на устройстве, затем сеть. */
export function packedSource(network: Source, url: string): Source {
  const path = archivePath(url)
  return {
    getKey: () => url,
    getBytes: async (offset, length, signal, etag): Promise<RangeResponse> => {
      const local = path ? await readPacked(path, offset, length).catch(() => null) : null
      if (local) return { data: local }
      return network.getBytes(offset, length, signal, etag)
    },
  }
}

/**
 * Шрифты подписей и значки подложки — свой протокол карты: без него подложка района без
 * сети осталась бы без названий сёл и рек. Ответ с устройства отдаётся сразу и
 * обновляется в фоне; первого раза хватает сети. Файлы общие (открытый маршрут
 * оформления), данных сотрудника в них нет.
 */
export const ASSET_PROTOCOL = 'kchs-asset'
const ASSET_PREFIX = `${ASSET_PROTOCOL}://`

const ASSET_URL = /\/api\/v1\/gis\/(glyphs|sprites)\//

const wrap = (url: unknown): unknown =>
  typeof url === 'string' && ASSET_URL.test(url) && !url.startsWith(ASSET_PREFIX)
    ? `${ASSET_PREFIX}${url}`
    : url

/** Стиль подложки: адреса шрифтов и спрайтов — через протокол `kchs-asset://`. */
export function wrapAssetUrls<T>(style: T): T {
  if (!style || typeof style !== 'object') return style
  const value = style as Record<string, unknown>
  const sprite = Array.isArray(value.sprite)
    ? value.sprite.map((item: unknown) =>
        item && typeof item === 'object'
          ? { ...item, url: wrap((item as { url?: unknown }).url) }
          : item,
      )
    : wrap(value.sprite)
  return {
    ...value,
    ...('glyphs' in value ? { glyphs: wrap(value.glyphs) } : {}),
    ...('sprite' in value ? { sprite } : {}),
  } as T
}

async function read(response: Response, type: string | undefined): Promise<unknown> {
  if (type === 'json') return response.json()
  if (type === 'string') return response.text()
  return response.arrayBuffer()
}

/**
 * Обработчик протокола `kchs-asset://` для `addProtocol` MapLibre.
 * @public `registerPmtilesProtocol` регистрирует его через динамический импорт.
 */
export async function loadAsset(
  params: { url: string; type?: string },
  abort: AbortController,
): Promise<{ data: unknown }> {
  const url = params.url.slice(ASSET_PREFIX.length)
  const fresh = fetch(url, { signal: abort.signal, credentials: 'same-origin' }).then(
    async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`)
      await putAsset(url, response.clone()).catch(() => {})
      return response
    },
  )
  const cached = await matchAsset(url).catch(() => null)
  if (cached) {
    void fresh.catch(() => {})
    return { data: await read(cached, params.type) }
  }
  return { data: await read(await fresh, params.type) }
}

/** Диапазоны шрифтов подписей: латиница, её расширение, кириллица с таджикскими буквами, знаки. */
const GLYPH_RANGES = [0, 256, 1024, 8192]

const unwrap = (url: string) =>
  url.startsWith(ASSET_PREFIX) ? url.slice(ASSET_PREFIX.length) : url

/** Шрифты стиля: только явно заданные наборы `text-font`. */
function fontstacks(style: Record<string, unknown>): string[] {
  const stacks = new Set<string>()
  for (const layer of (style.layers ?? []) as Array<{ layout?: Record<string, unknown> }>) {
    const font = layer.layout?.['text-font']
    if (Array.isArray(font) && font.every((item) => typeof item === 'string')) {
      stacks.add(font.join(','))
    }
  }
  return [...stacks]
}

/** Адреса шрифтов и спрайтов стиля, которые карта района запросит без сети. */
export function assetUrls(style: Record<string, unknown>): string[] {
  const urls = new Set<string>()
  if (typeof style.glyphs === 'string') {
    const template = unwrap(style.glyphs)
    for (const stack of fontstacks(style)) {
      for (const start of GLYPH_RANGES) {
        urls.add(
          template.replace('{fontstack}', stack).replace('{range}', `${start}-${start + 255}`),
        )
      }
    }
  }
  const sprites = Array.isArray(style.sprite)
    ? style.sprite.map((item: { url?: unknown }) => item?.url)
    : [style.sprite]
  for (const sprite of sprites) {
    if (typeof sprite !== 'string') continue
    const base = unwrap(sprite)
    for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) urls.add(`${base}${suffix}`)
  }
  return [...urls]
}

/** Шрифты и значки стилей — на устройство; недоступный файл пропускается. */
export async function prefetchAssets(styles: Array<Record<string, unknown>>): Promise<void> {
  const urls = new Set(styles.flatMap(assetUrls))
  await Promise.all(
    [...urls].map(async (url) => {
      const response = await fetch(url, { credentials: 'same-origin' }).catch(() => null)
      if (response?.ok) await putAsset(url, response).catch(() => {})
    }),
  )
}
