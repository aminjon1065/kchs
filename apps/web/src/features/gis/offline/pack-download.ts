import type { Bbox, ByteRange } from './pack-plan.js'
import { fitMaxZoom, mergeRanges, tilesOf, totalBytes } from './pack-plan.js'
import { archivePath, archiveUrl } from './pack-source.js'
import {
  type BasemapPack,
  commitPack,
  discardChunks,
  type PackArchive,
  putChunk,
  requestPersistence,
} from './pack-store.js'

/**
 * Загрузка района на устройство (ADR-0211). Сервер ничего не вырезает: архив подложки
 * уже отдаётся диапазонами (`GET /gis/basemaps/:id/pmtiles/:file`, право `view`), и
 * клиент по каталогам архива находит байты тайлов района, склеивает соседние и
 * забирает кусками. Размер известен до загрузки — сумма кусков.
 */

/** Заголовок и корневой каталог: библиотека PMTiles всегда читает первые 16 КБ. */
const HEADER_RANGE: ByteRange = [0, 16_384]
/** Сколько кусков грузится одновременно. */
const PARALLEL = 4

export interface ArchivePlan extends PackArchive {
  url: string
  minZoom: number
}

/** Архивы PMTiles стиля подложки: векторный, рельеф, подписи «Гибрида». */
export function styleArchives(style: Record<string, unknown>): string[] {
  const sources = (style.sources ?? {}) as Record<string, { url?: unknown }>
  const urls = new Set<string>()
  for (const source of Object.values(sources)) {
    const url = typeof source?.url === 'string' ? archiveUrl(source.url) : null
    if (url) urls.add(url)
  }
  return [...urls]
}

/**
 * План архива: тайлы рамки до `wantedMaxZoom` (но не больше бюджета тайлов и масштабов
 * самого архива), их диапазоны и каталоги, через которые к ним идёт библиотека.
 */
export async function planArchive(
  url: string,
  bbox: Bbox,
  wantedMaxZoom: number,
  signal?: AbortSignal,
): Promise<ArchivePlan> {
  const pmtiles = await import('pmtiles')
  const source = new pmtiles.FetchSource(url)
  // Каталогов района бывают сотни: кэш библиотеки по умолчанию (100) вытеснял бы их
  const cache = new pmtiles.SharedPromiseCache(4096)
  const archive = new pmtiles.PMTiles(source, cache)
  const header = await archive.getHeader()
  const maxZoom = Math.min(
    wantedMaxZoom,
    fitMaxZoom(bbox, header.minZoom, header.maxZoom),
    header.maxZoom,
  )
  const ranges: ByteRange[] = [HEADER_RANGE]
  let tiles = 0
  for (const [z, x, y] of tilesOf(bbox, header.minZoom, maxZoom)) {
    signal?.throwIfAborted()
    const tileId = pmtiles.zxyToTileId(z, x, y)
    let offset = header.rootDirectoryOffset
    let length = header.rootDirectoryLength
    for (let depth = 0; depth <= 3; depth += 1) {
      const entries = await cache.getDirectory(source, offset, length, header, signal)
      const entry = pmtiles.findTile(entries, tileId)
      if (!entry) break
      if (entry.runLength > 0) {
        ranges.push([header.tileDataOffset + entry.offset, entry.length])
        tiles += 1
        break
      }
      offset = header.leafDirectoryOffset + entry.offset
      length = entry.length
      ranges.push([offset, length])
    }
  }
  const chunks = mergeRanges(ranges)
  return {
    url,
    path: archivePath(url) ?? url,
    minZoom: header.minZoom,
    maxZoom,
    tiles,
    chunks,
    bytes: totalBytes(chunks),
  }
}

export interface PackRequest {
  id: string
  basemapId: string
  basemapName: string
  build: string | null
  area: BasemapPack['area']
  maxZoom: number
  plans: ArchivePlan[]
}

/**
 * Загрузить район: куски — в хранилище браузера, опись — в самом конце. Оборванная
 * загрузка за собой убирает; прежняя версия района работает, пока новая не готова.
 */
export async function downloadPack(
  request: PackRequest,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<BasemapPack> {
  await requestPersistence()
  const pmtiles = await import('pmtiles')
  const total = request.plans.reduce((sum, plan) => sum + plan.bytes, 0)
  let done = 0
  onProgress(0, total)
  const written = new Map<string, ByteRange[]>()
  try {
    for (const plan of request.plans) {
      const source = new pmtiles.FetchSource(plan.url)
      const saved: ByteRange[] = []
      written.set(plan.path, saved)
      const queue = [...plan.chunks]
      const worker = async () => {
        for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
          signal?.throwIfAborted()
          const response = await source.getBytes(chunk[0], chunk[1], signal)
          if (response.data.byteLength !== chunk[1]) throw new Error('range')
          await putChunk(plan.path, chunk, response.data)
          saved.push(chunk)
          done += chunk[1]
          onProgress(done, total)
        }
      }
      await Promise.all(Array.from({ length: PARALLEL }, worker))
    }
  } catch (error) {
    for (const [path, chunks] of written) await discardChunks(path, chunks).catch(() => {})
    throw error
  }
  const pack: BasemapPack = {
    id: request.id,
    basemapId: request.basemapId,
    basemapName: request.basemapName,
    build: request.build,
    area: request.area,
    maxZoom: request.maxZoom,
    archives: request.plans.map(({ path, maxZoom, tiles, bytes, chunks }) => ({
      path,
      maxZoom,
      tiles,
      bytes,
      chunks,
    })),
    bytes: total,
    createdAt: Date.now(),
  }
  await commitPack(pack)
  return pack
}
