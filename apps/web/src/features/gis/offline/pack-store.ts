import { type ByteRange, findChunk } from './pack-plan.js'

/**
 * Подложка района на устройстве (ADR-0211): куски архивов PMTiles подложки в Cache
 * Storage браузера. Ключ куска — адрес архива в API и диапазон байтов; опись районов —
 * отдельная запись того же кэша. Подложка — общие картографические данные, а не данные
 * сотрудника: район на устройстве один для всех, кто на нём входит, и при выходе не
 * стирается.
 *
 * Имя кэша — без префикса `kchs-`: служебный поток при обновлении удаляет свои старые
 * кэши по этому префиксу (`public/sw.js`), а район должен пережить новую сборку.
 */
const CACHE_NAME = 'basemap-offline-1'
const INDEX_KEY = '/__offline/basemap/index.json'

/** Архив района: путь в API (без origin), что из него взято и сколько это весит. */
export interface PackArchive {
  /** `/api/v1/gis/basemaps/<id>/pmtiles/<файл>` — имя файла несёт версию сборки. */
  path: string
  maxZoom: number
  tiles: number
  bytes: number
  /** Склеенные диапазоны по порядку смещений; заголовок архива — первый. */
  chunks: ByteRange[]
}

export interface BasemapPack {
  id: string
  basemapId: string
  basemapName: string
  /** Версия сборки подложки: новая сборка — район устарел, его можно обновить. */
  build: string | null
  area: {
    territoryId: string | null
    name: string
    bbox: [number, number, number, number]
  }
  maxZoom: number
  archives: PackArchive[]
  bytes: number
  createdAt: number
}

const supported = (): boolean => typeof caches !== 'undefined'

let index: Promise<BasemapPack[]> | null = null

async function open(): Promise<Cache | null> {
  if (!supported()) return null
  try {
    return await caches.open(CACHE_NAME)
  } catch {
    // Cache Storage закрыт (приватный режим, запрет сайта): района на устройстве нет
    return null
  }
}

/** Районы на устройстве — из описи; опись читается один раз за страницу. */
export function listPacks(): Promise<BasemapPack[]> {
  index ??= (async () => {
    const cache = await open()
    const response = await cache?.match(INDEX_KEY)
    if (!response) return []
    try {
      return (await response.json()) as BasemapPack[]
    } catch {
      return []
    }
  })()
  return index
}

async function saveIndex(cache: Cache, packs: BasemapPack[]): Promise<void> {
  await cache.put(
    INDEX_KEY,
    new Response(JSON.stringify(packs), { headers: { 'content-type': 'application/json' } }),
  )
  index = Promise.resolve(packs)
}

const chunkKey = (path: string, [offset, length]: ByteRange) =>
  `${path}?offline-range=${offset}-${length}`

export async function putChunk(path: string, range: ByteRange, data: ArrayBuffer): Promise<void> {
  const cache = await open()
  if (!cache) throw new Error('storage')
  await cache.put(chunkKey(path, range), new Response(data))
}

/** Район записан целиком — только теперь он попадает в опись и карта берёт его. */
export async function commitPack(pack: BasemapPack): Promise<void> {
  const cache = await open()
  if (!cache) throw new Error('storage')
  const all = await listPacks()
  const previous = all.find((item) => item.id === pack.id)
  const next = [...all.filter((item) => item.id !== pack.id), pack]
  await saveIndex(cache, next)
  // Куски прежней версии района, которых нет в новой, — удалить
  if (previous) await dropChunks(cache, previous, next)
}

/** Удалить район: опись — сразу, куски — те, что не нужны другим районам. */
export async function removePack(id: string): Promise<void> {
  const cache = await open()
  if (!cache) return
  const packs = await listPacks()
  const pack = packs.find((item) => item.id === id)
  const rest = packs.filter((item) => item.id !== id)
  await saveIndex(cache, rest)
  if (pack) await dropChunks(cache, pack, rest)
}

async function dropChunks(cache: Cache, pack: BasemapPack, keep: BasemapPack[]): Promise<void> {
  const kept = new Set(
    keep.flatMap((item) => item.archives.flatMap((a) => a.chunks.map((c) => chunkKey(a.path, c)))),
  )
  for (const archive of pack.archives) {
    for (const chunk of archive.chunks) {
      const key = chunkKey(archive.path, chunk)
      if (!kept.has(key)) await cache.delete(key)
    }
  }
}

/** Куски, записанные загрузкой, которая не дошла до конца, — в опись они не попали. */
export async function discardChunks(path: string, chunks: readonly ByteRange[]): Promise<void> {
  const cache = await open()
  if (!cache) return
  const kept = new Set(
    (await listPacks()).flatMap((item) =>
      item.archives.flatMap((a) => a.chunks.map((c) => chunkKey(a.path, c))),
    ),
  )
  for (const chunk of chunks) {
    const key = chunkKey(path, chunk)
    if (!kept.has(key)) await cache.delete(key)
  }
}

/**
 * Байты архива с устройства, если какой-нибудь район покрывает диапазон целиком,
 * иначе null. Путь — без origin: страницу открывают и по другим адресам.
 */
export async function readPacked(
  path: string,
  offset: number,
  length: number,
): Promise<ArrayBuffer | null> {
  const packs = await listPacks()
  for (const pack of packs) {
    for (const archive of pack.archives) {
      if (archive.path !== path) continue
      const found = findChunk(archive.chunks, offset, length)
      if (found < 0) continue
      const chunk = archive.chunks[found] as ByteRange
      const cache = await open()
      const response = await cache?.match(chunkKey(path, chunk))
      if (!response) continue
      const data = await response.arrayBuffer()
      const start = offset - chunk[0]
      return data.slice(start, start + length)
    }
  }
  return null
}

/** Сколько занимает сайт и сколько браузер готов отдать (оценка браузера). */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
  const estimate = await navigator.storage.estimate()
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }
}

/**
 * Просьба не вытеснять данные сайта при нехватке места. Браузер решает сам (Chrome —
 * для установленного приложения, Safari — по истории посещений); отказ не мешает
 * загрузке, но район могут вытеснить.
 */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
  try {
    return (await navigator.storage.persisted()) || (await navigator.storage.persist())
  } catch {
    return false
  }
}

/** Опись перечитать: другая вкладка могла загрузить или удалить район. */
export function forgetIndex(): void {
  index = null
}

/** Шрифт или спрайт подложки с устройства (`kchs-asset://`, ADR-0211). */
export async function matchAsset(url: string): Promise<Response | null> {
  const cache = await open()
  return (await cache?.match(url)) ?? null
}

export async function putAsset(url: string, response: Response): Promise<void> {
  const cache = await open()
  await cache?.put(url, response)
}
