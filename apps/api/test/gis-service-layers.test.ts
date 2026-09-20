import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Внешние ГИС-службы (P5-E03, ADR-0108): слой-ссылка — объект реестра
 * установки, ключ доступа наружу не отдаётся, адрес виден только управляющим,
 * а запрос в служебную сеть прокси не делает.
 */
registerLifecycle()

let fx: TestContext
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
})

describe('слой-ссылка на внешнюю службу', () => {
  let serviceId = ''

  it('создаётся администратором ГИС; ключ наружу не уходит', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/service-layers',
      as: fx.admin,
      payload: {
        name: `Служба WMS ${run}`,
        kind: 'wms',
        url: 'https://geo.example.org/geoserver/ows?token={key}',
        params: {
          kind: 'wms',
          layers: 'kchs:regions',
          version: '1.3.0',
          format: 'image/png',
          styles: '',
          transparent: true,
        },
        apiKey: 'super-secret-key',
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    serviceId = created.json().id
    expect(created.json().hasKey).toBe(true)
    expect(created.body).not.toContain('super-secret-key')
  })

  it('сотрудник видит службу, но не её адрес', async () => {
    const list = await call(fx.app, {
      method: 'GET',
      url: '/gis/service-layers',
      as: fx.users.member,
    })
    expect(list.statusCode, list.body).toBe(200)
    const item = list.json().items.find((entry: { id: string }) => entry.id === serviceId)
    expect(item).toBeTruthy()
    expect(item.url).toBeNull()
    expect(item.hasKey).toBe(true)
  })

  it('сотрудник службу не заводит', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/service-layers',
      as: fx.users.member,
      payload: {
        name: `Чужая служба ${run}`,
        kind: 'xyz',
        url: 'https://tiles.example.org/{z}/{x}/{y}.png',
        params: { kind: 'xyz' },
      },
    })
    expect(created.statusCode).toBe(403)
  })

  it('шаблон XYZ без номера тайла не принимается', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/service-layers',
      as: fx.admin,
      payload: {
        name: `Кривая XYZ ${run}`,
        kind: 'xyz',
        url: 'https://tiles.example.org/tiles.png',
        params: { kind: 'xyz' },
      },
    })
    expect(created.statusCode).toBe(400)
  })

  it('служебный адрес прокси не запрашивает', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/service-layers',
      as: fx.admin,
      payload: {
        name: `Метаданные облака ${run}`,
        kind: 'wfs',
        url: 'http://169.254.169.254/geoserver/ows',
        params: { kind: 'wfs', typeName: 'kchs:any', version: '2.0.0', cql: '' },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const check = await call(fx.app, {
      method: 'POST',
      url: `/gis/service-layers/${created.json().id}/check`,
      as: fx.admin,
    })
    expect(check.statusCode, check.body).toBe(200)
    expect(check.json().ok).toBe(false)
    expect(check.json().message).toContain('закрыт')
  })

  it('вид службы менять нельзя', async () => {
    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/service-layers/${serviceId}`,
      as: fx.admin,
      payload: { kind: 'xyz', params: { kind: 'xyz' } },
    })
    expect(patched.statusCode).toBe(400)
  })
})

describe('базовая карта WMS', () => {
  it('заводится и отдаёт стиль с растровым источником через прокси', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/basemaps',
      as: fx.admin,
      payload: {
        name: `Подложка WMS ${run}`,
        kind: 'wms',
        url: 'https://geo.example.org/geoserver/ows',
        service: {
          kind: 'wms',
          layers: 'kchs:base',
          version: '1.3.0',
          format: 'image/png',
          styles: '',
          transparent: true,
        },
        minZoom: 0,
        maxZoom: 18,
        tileSize: 256,
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    expect(created.json().kind).toBe('wms')
    expect(created.json().service.layers).toBe('kchs:base')

    const style = await call(fx.app, {
      method: 'GET',
      url: `/gis/basemaps/${created.json().id}/style.json?theme=light&lang=ru`,
      as: fx.users.member,
    })
    expect(style.statusCode, style.body).toBe(200)
    const spec = style.json() as { sources: Record<string, { type: string; tiles?: string[] }> }
    expect(spec.sources.raster?.type).toBe('raster')
    expect(spec.sources.raster?.tiles?.[0]).toContain(
      `/gis/basemaps/${created.json().id}/tiles/{z}/{x}/{y}`,
    )
  })

  it('адрес службы с номером тайла не принимается', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/basemaps',
      as: fx.admin,
      payload: {
        name: `Кривая WMS ${run}`,
        kind: 'wms',
        url: 'https://geo.example.org/{z}/{x}/{y}',
        service: {
          kind: 'wms',
          layers: 'kchs:base',
          version: '1.3.0',
          format: 'image/png',
          styles: '',
          transparent: true,
        },
      },
    })
    expect(created.statusCode).toBe(400)
  })
})

/**
 * Прокси тайлов отдаёт ответ чужой службы со своего происхождения, поэтому тип
 * содержимого — вопрос безопасности, а не удобства: `image/svg+xml` браузер
 * исполняет, и такой «тайл» стал бы хранимым XSS на домене установки
 * (17-security.md §5).
 */
describe('прокси тайлов: тип содержимого чужой службы', () => {
  let upstream: Server
  let upstreamBase = ''
  let respond: { type: string; body: Buffer } = { type: 'image/png', body: Buffer.alloc(0) }

  beforeAll(async () => {
    upstream = createServer((_request, response) => {
      response.statusCode = 200
      response.setHeader('content-type', respond.type)
      response.end(respond.body)
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  async function createXyz(name: string): Promise<string> {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/service-layers',
      as: fx.admin,
      payload: {
        name,
        kind: 'xyz',
        url: `${upstreamBase}/{z}/{x}/{y}.png`,
        params: { kind: 'xyz' },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    return created.json().id as string
  }

  it('растровый тайл проходит и отдаётся своим типом', async () => {
    const id = await createXyz(`Тайлы PNG ${run}`)
    respond = { type: 'image/png; charset=binary', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
    const tile = await call(fx.app, {
      url: `/gis/service-layers/${id}/tiles/1/0/0`,
      as: fx.users.member,
    })
    expect(tile.statusCode, tile.body).toBe(200)
    expect(tile.headers['content-type']).toBe('image/png')
  })

  it('SVG вместо тайла не отдаётся: исполняемый документ с нашего домена', async () => {
    const id = await createXyz(`Тайлы SVG ${run}`)
    respond = {
      type: 'image/svg+xml',
      body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    }
    const tile = await call(fx.app, {
      url: `/gis/service-layers/${id}/tiles/1/0/0`,
      as: fx.users.member,
    })
    expect(tile.statusCode).toBe(424)
    expect(tile.body).not.toContain('<svg')
  })

  it('HTML-страница ошибки службы тайлом не притворится', async () => {
    const id = await createXyz(`Тайлы HTML ${run}`)
    respond = { type: 'text/html', body: Buffer.from('<h1>Ошибка</h1>') }
    const tile = await call(fx.app, {
      url: `/gis/service-layers/${id}/tiles/1/0/0`,
      as: fx.users.member,
    })
    expect(tile.statusCode).toBe(424)
  })
})
