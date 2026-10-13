import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { archivePath, archiveUrl, packedSource, wrapAssetUrls } from './pack-source.js'
import {
  type BasemapPack,
  commitPack,
  discardChunks,
  forgetIndex,
  listPacks,
  putChunk,
  readPacked,
  removePack,
} from './pack-store.js'

/** Cache Storage в памяти: ключ — адрес, значение — тело ответа. */
function memoryCaches() {
  const stores = new Map<string, Map<string, ArrayBuffer>>()
  const key = (request: RequestInfo | URL) =>
    String(request instanceof Request ? request.url : request)
  return {
    stores,
    caches: {
      open: async (name: string) => {
        const store = stores.get(name) ?? new Map<string, ArrayBuffer>()
        stores.set(name, store)
        return {
          match: async (request: RequestInfo | URL) => {
            const body = store.get(key(request))
            return body ? new Response(body.slice(0)) : undefined
          },
          put: async (request: RequestInfo | URL, response: Response) => {
            store.set(key(request), await response.arrayBuffer())
          },
          delete: async (request: RequestInfo | URL) => store.delete(key(request)),
        }
      },
    },
  }
}

const PATH = '/api/v1/gis/basemaps/b1/pmtiles/2026-09-19.pmtiles'
const URL_ = `https://kchs.example/api/v1/gis/basemaps/b1/pmtiles/2026-09-19.pmtiles`

/** Байты архива: значение байта — его смещение по модулю 251. */
const bytes = (offset: number, length: number) =>
  Uint8Array.from({ length }, (_, index) => (offset + index) % 251).buffer

function pack(id: string, chunks: Array<[number, number]>): BasemapPack {
  return {
    id,
    basemapId: 'b1',
    basemapName: 'Таджикистан',
    build: '2026-09-19',
    area: { territoryId: id, name: 'Варзоб', bbox: [68.5, 38.6, 69.1, 39.3] },
    maxZoom: 12,
    archives: [{ path: PATH, maxZoom: 12, tiles: 10, bytes: 0, chunks }],
    bytes: 0,
    createdAt: 0,
  }
}

let memory: ReturnType<typeof memoryCaches>

beforeEach(() => {
  memory = memoryCaches()
  vi.stubGlobal('caches', memory.caches)
  forgetIndex()
})

afterEach(() => {
  vi.unstubAllGlobals()
  forgetIndex()
})

describe('район на устройстве', () => {
  it('диапазон внутри куска читается с устройства, вне — нет; до описи района нет', async () => {
    await putChunk(PATH, [0, 16_384], bytes(0, 16_384))
    await putChunk(PATH, [100_000, 1000], bytes(100_000, 1000))
    expect(await readPacked(PATH, 0, 127)).toBeNull()

    await commitPack(
      pack('p1', [
        [0, 16_384],
        [100_000, 1000],
      ]),
    )
    const header = await readPacked(PATH, 0, 127)
    expect(new Uint8Array(header as ArrayBuffer)).toEqual(new Uint8Array(bytes(0, 127)))
    const tile = await readPacked(PATH, 100_600, 400)
    expect(new Uint8Array(tile as ArrayBuffer)).toEqual(new Uint8Array(bytes(100_600, 400)))
    expect(await readPacked(PATH, 100_900, 200)).toBeNull()
    expect(await readPacked('/api/v1/gis/basemaps/b2/pmtiles/x.pmtiles', 0, 127)).toBeNull()
  })

  it('удаление района убирает его куски, но не общие с другим районом', async () => {
    await putChunk(PATH, [0, 16_384], bytes(0, 16_384))
    await putChunk(PATH, [100_000, 1000], bytes(100_000, 1000))
    await putChunk(PATH, [500_000, 10], bytes(500_000, 10))
    await commitPack(
      pack('p1', [
        [0, 16_384],
        [100_000, 1000],
      ]),
    )
    await commitPack(
      pack('p2', [
        [0, 16_384],
        [500_000, 10],
      ]),
    )
    expect(await listPacks()).toHaveLength(2)

    await removePack('p1')
    expect((await listPacks()).map((item) => item.id)).toEqual(['p2'])
    expect(await readPacked(PATH, 100_000, 10)).toBeNull()
    expect(await readPacked(PATH, 0, 127)).not.toBeNull()
    const store = memory.stores.get('basemap-offline-1')
    expect([...(store?.keys() ?? [])].some((key) => key.includes('100000-1000'))).toBe(false)
  })

  it('оборванная загрузка убирает свои куски и не трогает куски готовых районов', async () => {
    await putChunk(PATH, [0, 16_384], bytes(0, 16_384))
    await commitPack(pack('p1', [[0, 16_384]]))
    await putChunk(PATH, [700_000, 10], bytes(700_000, 10))
    await discardChunks(PATH, [
      [0, 16_384],
      [700_000, 10],
    ])
    const keys = [...(memory.stores.get('basemap-offline-1')?.keys() ?? [])]
    expect(keys.some((key) => key.includes('0-16384'))).toBe(true)
    expect(keys.some((key) => key.includes('700000-10'))).toBe(false)
  })

  it('источник карты берёт покрытое с устройства, остальное — из сети', async () => {
    await putChunk(PATH, [0, 16_384], bytes(0, 16_384))
    await commitPack(pack('p1', [[0, 16_384]]))
    const network = { getKey: () => URL_, getBytes: vi.fn(async () => ({ data: bytes(0, 8) })) }
    const source = packedSource(network, URL_)
    expect(source.getKey()).toBe(URL_)
    const local = await source.getBytes(0, 16_384)
    expect(local.data.byteLength).toBe(16_384)
    expect(network.getBytes).not.toHaveBeenCalled()
    await source.getBytes(200_000, 8)
    expect(network.getBytes).toHaveBeenCalledWith(200_000, 8, undefined, undefined)
  })
})

describe('адреса подложки', () => {
  it('адрес архива — из адреса протокола тайла и TileJSON', () => {
    expect(archiveUrl(`pmtiles://${URL_}`)).toBe(URL_)
    expect(archiveUrl(`pmtiles://${URL_}/12/2830/1580`)).toBe(URL_)
    expect(archiveUrl('https://kchs.example/x')).toBeNull()
    expect(archivePath(URL_)).toBe(PATH)
  })

  it('шрифты и спрайты подложки — через kchs-asset://, остальное не меняется', () => {
    const style = {
      glyphs: 'https://kchs.example/api/v1/gis/glyphs/{fontstack}/{range}.pbf',
      sprite: 'https://kchs.example/api/v1/gis/sprites/basemap-light',
      sources: { base: { url: `pmtiles://${URL_}` } },
    }
    const wrapped = wrapAssetUrls(style)
    expect(wrapped.glyphs).toBe(`kchs-asset://${style.glyphs}`)
    expect(wrapped.sprite).toBe(`kchs-asset://${style.sprite}`)
    expect(wrapped.sources).toEqual(style.sources)
    expect(wrapAssetUrls(wrapped)).toEqual(wrapped)
    const many = wrapAssetUrls({
      sprite: [
        { id: 'a', url: style.sprite },
        { id: 'b', url: 'https://x/y' },
      ],
    })
    expect(many.sprite).toEqual([
      { id: 'a', url: `kchs-asset://${style.sprite}` },
      { id: 'b', url: 'https://x/y' },
    ])
  })
})
