import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Базовые карты (P2-E01 S04, ADR-0066): реестр `basemap` (глобальный объект,
 * виден всем сотрудникам, управление — `gis.basemaps.manage`), сборка PMTiles
 * в хранилище → `sync`, стиль MapLibre с абсолютными адресами, архив
 * диапазонами (206), шрифты и спрайты, растровый прокси (ключ скрыт, кэш).
 * Хранилище — свой каталог тестов в бакете тайлов (`BASEMAPS_PREFIX`).
 */
registerLifecycle()

const { BasemapService, uploadBasemapBuild } = await import('../src/modules/gis/public.js')
const { buckets, deletePrefix, listObjects } = await import('../src/kernel/storage/s3.js')
const { config } = await import('../src/shared/config/index.js')
const { systemCtx } = await import('../src/shared/context.js')

const KEY = 'tajik-test'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

let fx: TestContext
let gisAdmin: TestUser
let build: string
let noneId: string
let vectorId: string
let rasterId: string
const upstream: { requests: string[]; url: string; close: () => Promise<void> } = {
  requests: [],
  url: '',
  close: async () => undefined,
}

const prefix = () => `${config().BASEMAPS_PREFIX}/`
const base = () => `${config().KCHS_BASE_URL.replace(/\/+$/, '')}/api/v1`

/** Архив с заголовком PMTiles v3 и произвольным телом — API его не разбирает. */
function fakeArchive(size: number, seed: string): Buffer {
  const body = Buffer.alloc(size)
  Buffer.from('PMTiles', 'latin1').copy(body, 0)
  body[7] = 3
  createHash('sha256').update(seed).digest().copy(body, 8)
  return body
}

async function writeBuild(version: string, archive: Buffer): Promise<void> {
  const file = `${version}.pmtiles`
  await rm(join(build, KEY), { recursive: true, force: true })
  await mkdir(join(build, KEY), { recursive: true })
  await writeFile(join(build, KEY, file), archive)
  await writeFile(
    join(build, KEY, 'manifest.json'),
    JSON.stringify({
      format: 'kchs-basemap/1',
      key: KEY,
      name: 'OSM — тест',
      kind: 'vector',
      schema: 'openmaptiles',
      version,
      file,
      bytes: archive.length,
      sha256: createHash('sha256').update(archive).digest('hex'),
      tileType: 'mvt',
      tileCompression: 'gzip',
      minZoom: 0,
      maxZoom: 14,
      bounds: [60, 33, 81, 45],
      center: [70.5, 39, 5],
      tiles: 42,
      attribution:
        '<a href="https://www.openmaptiles.org/">&copy; OpenMapTiles</a> <img src=x onerror=alert(1)>',
      layers: ['boundary', 'place', 'water'],
    }),
  )
}

async function outbox(type: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db().execute<{ event: { payload: Record<string, unknown> } }>(
    sql`SELECT event FROM ops.outbox WHERE type = ${type} ORDER BY id`,
  )
  return rows.map((row) => row.event.payload)
}

beforeAll(async () => {
  fx = await setupFixture()
  gisAdmin = await createUser(fx.app, 'gis_admin_test', ['gis_admin'])
  await deletePrefix(prefix(), buckets.tiles())

  build = await mkdtemp(join(tmpdir(), 'kchs-basemaps-'))
  await writeBuild('2026-09-19', fakeArchive(4096, 'v1'))
  await mkdir(join(build, 'glyphs', 'Noto Sans Regular'), { recursive: true })
  await mkdir(join(build, 'glyphs', 'Noto Sans Bold'), { recursive: true })
  await writeFile(join(build, 'glyphs', 'Noto Sans Regular', '0-255.pbf'), randomBytes(300))
  await writeFile(join(build, 'glyphs', 'Noto Sans Bold', '1024-1279.pbf'), randomBytes(200))
  await mkdir(join(build, 'sprites'), { recursive: true })
  await writeFile(
    join(build, 'sprites', 'basemap-light.json'),
    JSON.stringify({ city: { x: 0, y: 0, width: 1, height: 1, pixelRatio: 1 } }),
  )
  await writeFile(join(build, 'sprites', 'basemap-light.png'), PNG)

  // Растровый сервер: тайл только с правильным ключом, иначе 404
  const server = createServer((request: IncomingMessage, response) => {
    upstream.requests.push(request.url ?? '')
    const match = /^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png\?key=SECRET-123$/.exec(request.url ?? '')
    if (!match || match[1] === '9') {
      response.statusCode = 404
      response.end()
      return
    }
    response.setHeader('content-type', 'image/png')
    response.end(PNG)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  upstream.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  upstream.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
})

afterAll(async () => {
  await upstream.close()
  await rm(build, { recursive: true, force: true })
  // Каталог тестов в общем бакете не оставляет сборок следующим прогонам и init.test
  await deletePrefix(prefix(), buckets.tiles())
})

describe('реестр базовых карт', () => {
  it('без сборок: «без подложки» по умолчанию — объект реестра, виден всем сотрудникам', async () => {
    const summary = await BasemapService.sync(systemCtx('test'))
    expect(summary).toMatchObject({
      created: ['none'],
      updated: [],
      defaultKind: 'none',
      storageAvailable: true,
    })

    const list = await call(fx.app, { url: '/gis/basemaps', as: fx.users.stranger })
    expect(list.statusCode, list.body).toBe(200)
    const items = list.json().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: 'none', kind: 'none', isDefault: true, url: null })
    noneId = items[0].id

    const [object] = await db().execute<{ type: string; space_id: string | null; owner_id: null }>(
      sql`SELECT type, space_id, owner_id FROM objects WHERE id = ${noneId}`,
    )
    expect(object).toEqual({ type: 'basemap', space_id: null, owner_id: null })

    // Повторная синхронизация ничего не меняет
    expect(await BasemapService.sync(systemCtx('test'))).toMatchObject({ created: [], updated: [] })
  })

  it('сборка → хранилище → sync: векторная регистрируется и сменяет «без подложки»', async () => {
    const upload = await uploadBasemapBuild(build)
    expect(upload).toEqual({
      builds: [{ key: KEY, version: '2026-09-19', uploaded: true }],
      glyphs: { uploaded: 2, skipped: 0 },
      sprites: { uploaded: 2, skipped: 0 },
    })
    // Повтор не загружает неизменённое
    const again = await uploadBasemapBuild(build, { key: KEY })
    expect(again.builds[0]?.uploaded).toBe(false)
    expect(again.glyphs).toEqual({ uploaded: 0, skipped: 2 })

    const summary = await BasemapService.sync(systemCtx('test'))
    expect(summary).toMatchObject({
      created: [KEY],
      defaultKind: 'vector',
      defaultName: 'OSM — тест',
    })

    const list = await call(fx.app, { url: '/gis/basemaps', as: fx.users.stranger })
    const items = list.json().items as Array<Record<string, unknown>>
    expect(items.map((item) => item.key)).toEqual([KEY, 'none'])
    expect(items[0]).toMatchObject({
      kind: 'vector',
      isDefault: true,
      build: { version: '2026-09-19', bytes: 4096, tiles: 42 },
      bounds: [60, 33, 81, 45],
      // HTML атрибуции сборки — только текст
      attribution: '© OpenMapTiles',
    })
    vectorId = items[0]?.id as string
    expect(await outbox('basemap.default_changed')).toContainEqual({ previousId: noneId })
  })

  it('манифест без архива или с чужим SHA-256 не загружается', async () => {
    const broken = await mkdtemp(join(tmpdir(), 'kchs-basemaps-broken-'))
    await mkdir(join(broken, 'other'), { recursive: true })
    await writeFile(
      join(broken, 'other', 'manifest.json'),
      JSON.stringify({ format: 'kchs-basemap/1', key: 'other' }),
    )
    await expect(uploadBasemapBuild(broken)).rejects.toThrow()
    await rm(broken, { recursive: true, force: true })
  })
})

describe('стиль MapLibre', () => {
  it('векторная: абсолютные адреса через API, валидный стиль во всех темах', async () => {
    for (const theme of ['light', 'dark', 'muted']) {
      const response = await call(fx.app, {
        url: `/gis/basemaps/${vectorId}/style.json?theme=${theme}&lang=tg`,
        as: fx.users.stranger,
      })
      expect(response.statusCode, response.body).toBe(200)
      const style = response.json()
      expect(validateStyleMin(style)).toEqual([])
      expect(style.sources.openmaptiles.url).toBe(
        `pmtiles://${base()}/gis/basemaps/${vectorId}/pmtiles/2026-09-19.pmtiles`,
      )
      expect(style.sources.openmaptiles.attribution).toBe('© OpenMapTiles')
      expect(style.glyphs).toBe(`${base()}/gis/glyphs/{fontstack}/{range}.pbf`)
      expect(style.sprite).toBe(`${base()}/gis/sprites/basemap-${theme}`)
      expect(style.metadata['kchs:theme']).toBe(theme)
    }
  })

  it('«без подложки» — только фон; неизвестная тема — 400', async () => {
    const style = await call(fx.app, {
      url: `/gis/basemaps/${noneId}/style.json`,
      as: fx.users.member,
    })
    expect(style.statusCode).toBe(200)
    expect(validateStyleMin(style.json())).toEqual([])
    expect(style.json().layers).toHaveLength(1)

    const wrong = await call(fx.app, {
      url: `/gis/basemaps/${noneId}/style.json?theme=neon`,
      as: fx.users.member,
    })
    expect(wrong.statusCode).toBe(400)
    const anonymous = await call(fx.app, { url: `/gis/basemaps/${noneId}/style.json` })
    expect(anonymous.statusCode).toBe(401)
  })
})

describe('архив PMTiles диапазонами', () => {
  const url = () => `/gis/basemaps/${vectorId}/pmtiles/2026-09-19.pmtiles`

  it('Range → 206 с Content-Range; без Range — весь архив', async () => {
    const head = await call(fx.app, {
      url: url(),
      as: fx.users.stranger,
      headers: { range: 'bytes=0-126' },
    })
    expect(head.statusCode, head.body).toBe(206)
    expect(head.headers['content-range']).toBe('bytes 0-126/4096')
    expect(head.headers['accept-ranges']).toBe('bytes')
    expect(head.headers['content-length']).toBe('127')
    const raw = (head as unknown as { rawPayload: Buffer }).rawPayload
    expect(raw.subarray(0, 7).toString('latin1')).toBe('PMTiles')

    const tail = await call(fx.app, {
      url: url(),
      as: fx.users.stranger,
      headers: { range: 'bytes=-16' },
    })
    expect(tail.statusCode).toBe(206)
    expect(tail.headers['content-range']).toBe('bytes 4080-4095/4096')

    const whole = await call(fx.app, { url: url(), as: fx.users.stranger })
    expect(whole.statusCode).toBe(200)
    expect(whole.headers['content-length']).toBe('4096')
  })

  it('недопустимый диапазон — 416, чужой файл — 404, без входа — 401', async () => {
    for (const range of ['bytes=5000-6000', 'bytes=0-1,5-6', 'items=0-1']) {
      const response = await call(fx.app, { url: url(), as: fx.users.stranger, headers: { range } })
      expect(response.statusCode, range).toBe(416)
      expect(response.headers['content-range']).toBe('bytes */4096')
    }
    const other = await call(fx.app, {
      url: `/gis/basemaps/${vectorId}/pmtiles/2020-01-01.pmtiles`,
      as: fx.users.stranger,
    })
    expect(other.statusCode).toBe(404)
    const none = await call(fx.app, {
      url: `/gis/basemaps/${noneId}/pmtiles/2026-09-19.pmtiles`,
      as: fx.users.stranger,
    })
    expect(none.statusCode).toBe(404)
    expect((await call(fx.app, { url: url() })).statusCode).toBe(401)
  })
})

describe('шрифты и спрайты', () => {
  it('glyphs PBF: стек через запятую — первый найденный шрифт', async () => {
    const regular = await call(fx.app, {
      url: '/gis/glyphs/Noto%20Sans%20Regular/0-255.pbf',
      as: fx.users.stranger,
    })
    expect(regular.statusCode, regular.body).toBe(200)
    expect(regular.headers['content-type']).toBe('application/x-protobuf')
    expect((regular as unknown as { rawPayload: Buffer }).rawPayload).toHaveLength(300)

    const stack = await call(fx.app, {
      url: '/gis/glyphs/Noto%20Sans%20Italic,Noto%20Sans%20Bold/1024-1279.pbf',
      as: fx.users.stranger,
    })
    expect(stack.statusCode).toBe(200)
    expect((stack as unknown as { rawPayload: Buffer }).rawPayload).toHaveLength(200)

    const missing = await call(fx.app, {
      url: '/gis/glyphs/Noto%20Sans%20Regular/65280-65535.pbf',
      as: fx.users.stranger,
    })
    expect(missing.statusCode).toBe(404)
    const traversal = await call(fx.app, {
      url: '/gis/glyphs/..%2F..%2Fsecret/0-255.pbf',
      as: fx.users.stranger,
    })
    expect(traversal.statusCode).toBe(400)
  })

  it('спрайт темы: JSON и PNG; чужое имя — 400', async () => {
    const json = await call(fx.app, {
      url: '/gis/sprites/basemap-light.json',
      as: fx.users.stranger,
    })
    expect(json.statusCode).toBe(200)
    expect(json.json()).toHaveProperty('city')
    const png = await call(fx.app, { url: '/gis/sprites/basemap-light.png', as: fx.users.stranger })
    expect(png.headers['content-type']).toBe('image/png')
    const other = await call(fx.app, { url: '/gis/sprites/secret.json', as: fx.users.stranger })
    expect(other.statusCode).toBe(400)
  })
})

describe('управление подложками', () => {
  const raster = () => ({
    name: 'Спутник',
    url: `${upstream.url}/tiles/{z}/{x}/{y}.png?key={key}`,
    apiKey: 'SECRET-123',
    attribution: '<b>Спутник</b>',
    maxZoom: 18,
  })

  it('сотрудник без способности не создаёт, не правит и не удаляет', async () => {
    const create = await call(fx.app, {
      method: 'POST',
      url: '/gis/basemaps',
      as: fx.users.stranger,
      payload: raster(),
    })
    expect(create.statusCode).toBe(403)
    for (const request of [
      { method: 'PATCH' as const, url: `/gis/basemaps/${vectorId}`, payload: { name: 'x' } },
      { method: 'DELETE' as const, url: `/gis/basemaps/${vectorId}` },
      { method: 'POST' as const, url: `/gis/basemaps/${noneId}/default` },
    ]) {
      const response = await call(fx.app, { ...request, as: fx.users.stranger })
      expect(response.statusCode, request.url).toBe(403)
    }
  })

  it('шаблон и ключ проверяются: {z}{x}{y}, http(s), без учётных данных, {key} ⇔ ключ', async () => {
    const cases = [
      { url: 'https://tiles.example/{z}/{x}.png' },
      { url: 'ftp://tiles.example/{z}/{x}/{y}.png' },
      { url: 'https://user:pass@tiles.example/{z}/{x}/{y}.png' },
      { url: 'https://{s}.tiles.example/{z}/{x}/{y}.png' },
      { url: 'https://tiles.example/{z}/{x}/{y}.png?key={key}' },
      { url: 'https://tiles.example/{z}/{x}/{y}.png', apiKey: 'unused' },
    ]
    for (const payload of cases) {
      const response = await call(fx.app, {
        method: 'POST',
        url: '/gis/basemaps',
        as: gisAdmin,
        payload: { name: 'x', ...payload },
      })
      expect(response.statusCode, payload.url).toBe(400)
    }
  })

  it('администратор ГИС добавляет растровую: ключ не отдаётся никому, адрес — только управляющим', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/basemaps',
      as: gisAdmin,
      payload: raster(),
    })
    expect(created.statusCode, created.body).toBe(200)
    expect(created.json()).toMatchObject({
      kind: 'raster',
      key: null,
      hasKey: true,
      tileSize: 256,
      url: `${upstream.url}/tiles/{z}/{x}/{y}.png?key={key}`,
    })
    expect(created.body).not.toContain('SECRET-123')
    rasterId = created.json().id

    const list = await call(fx.app, { url: '/gis/basemaps', as: fx.users.stranger })
    expect(list.body).not.toContain('SECRET-123')
    expect(list.body).not.toContain(upstream.url)
    const item = list.json().items.find((entry: { id: string }) => entry.id === rasterId)
    expect(item).toMatchObject({ url: null, hasKey: true })

    const style = await call(fx.app, {
      url: `/gis/basemaps/${rasterId}/style.json?theme=dark`,
      as: fx.users.stranger,
    })
    expect(style.statusCode).toBe(200)
    expect(validateStyleMin(style.json())).toEqual([])
    expect(style.body).not.toContain('SECRET-123')
    expect(style.body).not.toContain(upstream.url)
    expect(style.json().sources.raster.tiles[0]).toMatch(
      new RegExp(
        `^${base()}/gis/basemaps/${rasterId}/tiles/\\{z\\}/\\{x\\}/\\{y\\}\\?v=[0-9a-f]{12}$`,
      ),
    )
    // Атрибуция администратора — текстом, не разметкой
    expect(style.json().sources.raster.attribution).toBe('&lt;b&gt;Спутник&lt;/b&gt;')
  })

  it('растровый прокси: ключ подставляет сервер, повторный тайл — из кэша', async () => {
    upstream.requests.length = 0
    const first = await call(fx.app, {
      url: `/gis/basemaps/${rasterId}/tiles/3/4/2`,
      as: fx.users.stranger,
    })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.headers['content-type']).toBe('image/png')
    expect((first as unknown as { rawPayload: Buffer }).rawPayload.equals(PNG)).toBe(true)
    expect(upstream.requests).toEqual(['/tiles/3/4/2.png?key=SECRET-123'])

    const cached = await call(fx.app, {
      url: `/gis/basemaps/${rasterId}/tiles/3/4/2`,
      as: fx.users.member,
    })
    expect(cached.statusCode).toBe(200)
    expect(upstream.requests).toHaveLength(1)

    // Нет у сервера (9) и вне масштабов подложки (19) — 404; вне сетки — 400
    expect(
      (await call(fx.app, { url: `/gis/basemaps/${rasterId}/tiles/9/1/1`, as: gisAdmin }))
        .statusCode,
    ).toBe(404)
    expect(
      (await call(fx.app, { url: `/gis/basemaps/${rasterId}/tiles/19/1/1`, as: gisAdmin }))
        .statusCode,
    ).toBe(404)
    expect(
      (await call(fx.app, { url: `/gis/basemaps/${rasterId}/tiles/1/2/0`, as: gisAdmin }))
        .statusCode,
    ).toBe(400)
  })

  it('смена адреса очищает кэш; закрытые адреса (link-local) прокси не запрашивает', async () => {
    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/basemaps/${rasterId}`,
      as: gisAdmin,
      payload: { url: `${upstream.url}/tiles/{z}/{x}/{y}.png?key={key}&v=2` },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(await outbox('basemap.updated')).toContainEqual({ changed: ['url'] })
    const cache = await listObjects(`${prefix()}raster/${rasterId}/`, buckets.tiles())
    expect(cache).toHaveLength(0)

    // Прежний шаблон снова — кэш пуст, сервер получает запрос заново
    await call(fx.app, {
      method: 'PATCH',
      url: `/gis/basemaps/${rasterId}`,
      as: gisAdmin,
      payload: { url: `${upstream.url}/tiles/{z}/{x}/{y}.png?key={key}` },
    })
    upstream.requests.length = 0
    await call(fx.app, { url: `/gis/basemaps/${rasterId}/tiles/3/4/2`, as: gisAdmin })
    expect(upstream.requests).toHaveLength(1)

    const metadata = await call(fx.app, {
      method: 'POST',
      url: '/gis/basemaps',
      as: gisAdmin,
      payload: { name: 'Метаданные', url: 'http://169.254.169.254/{z}/{x}/{y}' },
    })
    expect(metadata.statusCode, metadata.body).toBe(200)
    const blocked = await call(fx.app, {
      url: `/gis/basemaps/${metadata.json().id}/tiles/1/1/1`,
      as: gisAdmin,
    })
    expect(blocked.statusCode).toBe(424)
    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/gis/basemaps/${metadata.json().id}`,
      as: gisAdmin,
    })
    expect(removed.statusCode).toBe(200)
  })

  it('по умолчанию: одна на установку; удалить её и «без подложки» нельзя', async () => {
    const set = await call(fx.app, {
      method: 'POST',
      url: `/gis/basemaps/${rasterId}/default`,
      as: gisAdmin,
    })
    expect(set.statusCode, set.body).toBe(200)
    const list = await call(fx.app, { url: '/gis/basemaps', as: fx.users.stranger })
    const defaults = list.json().items.filter((item: { isDefault: boolean }) => item.isDefault)
    expect(defaults.map((item: { id: string }) => item.id)).toEqual([rasterId])
    expect(await outbox('basemap.default_changed')).toContainEqual({ previousId: vectorId })

    for (const id of [rasterId, noneId]) {
      const response = await call(fx.app, {
        method: 'DELETE',
        url: `/gis/basemaps/${id}`,
        as: gisAdmin,
      })
      expect(response.statusCode).toBe(409)
    }

    // Векторная меняет только название
    const url = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/basemaps/${vectorId}`,
      as: gisAdmin,
      payload: { maxZoom: 10 },
    })
    expect(url.statusCode).toBe(400)
    const renamed = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/basemaps/${vectorId}`,
      as: gisAdmin,
      payload: { name: 'Таджикистан (OSM)' },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().name).toBe('Таджикистан (OSM)')

    await call(fx.app, { method: 'POST', url: `/gis/basemaps/${vectorId}/default`, as: gisAdmin })
    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/gis/basemaps/${rasterId}`,
      as: gisAdmin,
    })
    expect(removed.statusCode).toBe(200)
    expect(await listObjects(`${prefix()}raster/${rasterId}/`, buckets.tiles())).toHaveLength(0)
    const [object] = await db().execute(sql`SELECT 1 FROM objects WHERE id = ${rasterId}`)
    expect(object).toBeUndefined()
  })
})

describe('обновление и удаление сборки', () => {
  it('новая версия: sync переходит на неё, прошлый архив удаляется и не отдаётся', async () => {
    await writeBuild('2026-10-01', fakeArchive(8192, 'v2'))
    await uploadBasemapBuild(build, { key: KEY })
    const summary = await BasemapService.sync(systemCtx('test'))
    expect(summary).toMatchObject({ created: [], updated: [KEY] })
    expect(await outbox('basemap.updated')).toContainEqual({ changed: ['build'] })

    const style = await call(fx.app, {
      url: `/gis/basemaps/${vectorId}/style.json`,
      as: fx.users.stranger,
    })
    expect(style.json().sources.openmaptiles.url).toContain('/pmtiles/2026-10-01.pmtiles')
    const old = await call(fx.app, {
      url: `/gis/basemaps/${vectorId}/pmtiles/2026-09-19.pmtiles`,
      as: fx.users.stranger,
      headers: { range: 'bytes=0-126' },
    })
    expect(old.statusCode).toBe(404)
    const files = await listObjects(`${prefix()}vector/${KEY}/`, buckets.tiles())
    expect(files.map((item) => item.key.split('/').pop()).sort()).toEqual([
      '2026-10-01.pmtiles',
      'manifest.json',
    ])
  })

  it('удалённая векторная уходит из хранилища и не возвращается при sync', async () => {
    await call(fx.app, { method: 'POST', url: `/gis/basemaps/${noneId}/default`, as: gisAdmin })
    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/gis/basemaps/${vectorId}`,
      as: gisAdmin,
    })
    expect(removed.statusCode, removed.body).toBe(200)
    expect(await listObjects(`${prefix()}vector/${KEY}/`, buckets.tiles())).toHaveLength(0)
    const summary = await BasemapService.sync(systemCtx('test'))
    expect(summary).toMatchObject({ created: [], defaultKind: 'none' })
  })
})
