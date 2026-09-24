import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { Agent, setGlobalDispatcher } from 'undici'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadEnv, resetConfigCache } from '~/shared/config/index.js'
import {
  bypassesProxy,
  configureOutboundProxy,
  outboundAddressDenied,
  outboundGet,
  proxySettings,
} from './outbound.js'

/**
 * Общий исходящий клиент (ADR-0132): прямой запрос с проверкой адреса,
 * пределы времени и размера, перенаправления, прокси из `HTTP_PROXY` и
 * `NO_PROXY`. Цель и прокси — локальные серверы: loopback в тестовой среде открыт.
 */

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  return new Promise<{ server: Server; port: number }>((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port }),
    )
  })
}

let target: { server: Server; port: number }
let proxy: { server: Server; port: number }
const proxied: string[] = []

beforeAll(async () => {
  target = await listen((request, response) => {
    if (request.url === '/data.json') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    } else if (request.url === '/big') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('x'.repeat(4096))
    } else if (request.url === '/slow') {
      setTimeout(() => response.end('поздно'), 1500)
    } else if (request.url === '/moved') {
      response.writeHead(302, { location: '/data.json' })
      response.end()
    } else if (request.url === '/html') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html></html>')
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  // Прямой (не туннельный) прокси: видит абсолютный адрес и отвечает сам
  proxy = await listen((request, response) => {
    proxied.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ via: 'proxy', url: request.url }))
  })
  // Туннель CONNECT — тоже к себе: запрос внутри туннеля попадёт в обработчик выше
  proxy.server.on('connect', (request: IncomingMessage, socket: Duplex) => {
    proxied.push(`CONNECT ${request.url ?? ''}`)
    const upstream = connect(proxy.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
})

afterAll(async () => {
  await new Promise((resolve) => target.server.close(resolve))
  await new Promise((resolve) => proxy.server.close(resolve))
})

function configure(env: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetConfigCache()
}

afterEach(() => {
  configure({ HTTP_PROXY: undefined, HTTPS_PROXY: undefined, NO_PROXY: undefined })
  setGlobalDispatcher(new Agent())
})

const base = () => `http://127.0.0.1:${target.port}`

describe('прямой запрос', () => {
  it('отдаёт тело успешного ответа с типом', async () => {
    const response = await outboundGet(`${base()}/data.json`, {
      what: 'тестовая лента',
      maxBytes: 1024,
      expect: 'application/json',
    })
    expect(response.status).toBe(200)
    expect(response.contentType).toBe('application/json')
    expect(JSON.parse(response.body.toString())).toEqual({ ok: true })
  })

  it('неуспешный код — без тела, решает вызывающий', async () => {
    const response = await outboundGet(`${base()}/nothing`, { what: 'лента', maxBytes: 1024 })
    expect(response.status).toBe(404)
    expect(response.body.length).toBe(0)
  })

  it('размер, время и тип ответа ограничены', async () => {
    await expect(outboundGet(`${base()}/big`, { what: 'лента', maxBytes: 100 })).rejects.toThrow(
      'Ответ слишком большой: лента',
    )
    await expect(
      outboundGet(`${base()}/slow`, { what: 'лента', maxBytes: 100, timeoutMs: 300 }),
    ).rejects.toThrow('Нет ответа за 0 с: лента')
    await expect(
      outboundGet(`${base()}/html`, { what: 'лента', maxBytes: 100, expect: 'application/json' }),
    ).rejects.toThrow('Неожиданный ответ: лента')
  })

  it('перенаправление — по разрешению и с повторной проверкой адреса', async () => {
    const kept = await outboundGet(`${base()}/moved`, { what: 'лента', maxBytes: 1024 })
    expect(kept.status).toBe(302)
    const followed = await outboundGet(`${base()}/moved`, {
      what: 'лента',
      maxBytes: 1024,
      maxRedirects: 1,
    })
    expect(followed.status).toBe(200)
  })

  it('служебные адреса закрыты, частные — по политике вызова', async () => {
    await expect(
      outboundGet('http://169.254.169.254/latest/meta-data', { what: 'лента', maxBytes: 100 }),
    ).rejects.toThrow('Адрес закрыт для исходящих запросов: лента')
    await expect(
      outboundGet('http://10.1.2.3/feed', {
        what: 'лента',
        maxBytes: 100,
        denyPrivateNetworks: true,
      }),
    ).rejects.toThrow('Адрес закрыт для исходящих запросов: лента')
    expect(outboundAddressDenied('10.1.2.3')).toBe(false)
    expect(outboundAddressDenied('10.1.2.3', true)).toBe(true)
    expect(outboundAddressDenied('::ffff:192.168.1.1', true)).toBe(true)
    expect(outboundAddressDenied('8.8.8.8', true)).toBe(false)
    await expect(
      outboundGet('ftp://example.org/feed', { what: 'лента', maxBytes: 100 }),
    ).rejects.toThrow('Адрес должен быть http или https: лента')
  })
})

describe('исходящий прокси', () => {
  it('запрос идёт через HTTP_PROXY: имя разрешает прокси', async () => {
    configure({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` })
    const response = await outboundGet('http://feeds.example.test/usgs.json', {
      what: 'лента',
      maxBytes: 1024,
    })
    expect(JSON.parse(response.body.toString())).toMatchObject({ via: 'proxy' })
    expect(proxied.at(-1)).toBe('http://feeds.example.test/usgs.json')
  })

  it('узлы из NO_PROXY идут напрямую', async () => {
    configure({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, NO_PROXY: '.example.test' })
    const before = proxied.length
    // Напрямую имени .test не разрешить — и это доказывает, что прокси обойдён
    await expect(
      outboundGet('http://feeds.example.test/usgs.json', { what: 'лента', maxBytes: 1024 }),
    ).rejects.toThrow('Нет соединения: лента')
    expect(proxied.length).toBe(before)
    // Сама цель на loopback — тоже мимо прокси: службы узла в него не ходят
    const direct = await outboundGet(`${base()}/data.json`, { what: 'лента', maxBytes: 1024 })
    expect(JSON.parse(direct.body.toString())).toEqual({ ok: true })
    expect(proxied.length).toBe(before)
  })

  it('с прокси адреса-литералы служебных сетей закрыты сразу', async () => {
    configure({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` })
    await expect(
      outboundGet('http://169.254.169.254/latest/meta-data', { what: 'лента', maxBytes: 100 }),
    ).rejects.toThrow('Адрес закрыт для исходящих запросов: лента')
  })

  it('глобальный fetch ходит через прокси после настройки', async () => {
    configure({ HTTP_PROXY: `http://127.0.0.1:${proxy.port}` })
    expect(configureOutboundProxy()).toBe(true)
    const response = await fetch('http://api.example.test/hook')
    expect(await response.json()).toMatchObject({ via: 'proxy' })
  })

  it('правила NO_PROXY: точное имя, суффикс с точки, порт, IPv6, звезда', () => {
    const url = (value: string) => new URL(value)
    expect(bypassesProxy(url('http://a.corp/x'), 'a.corp')).toBe(true)
    expect(bypassesProxy(url('http://b.a.corp/x'), 'a.corp')).toBe(false)
    expect(bypassesProxy(url('http://b.a.corp/x'), '.a.corp')).toBe(true)
    expect(bypassesProxy(url('http://b.a.corp/x'), 'other, *.a.corp')).toBe(true)
    expect(bypassesProxy(url('http://a.corp:8080/x'), 'a.corp:9090')).toBe(false)
    expect(bypassesProxy(url('https://a.corp/x'), 'a.corp:443')).toBe(true)
    expect(bypassesProxy(url('http://[::1]:3000/x'), '::1')).toBe(true)
    expect(bypassesProxy(url('http://x.y/'), 'a, *')).toBe(true)
  })

  it('службы установки попадают в обход прокси сами', () => {
    const settings = proxySettings(
      loadEnv({
        ...process.env,
        HTTP_PROXY: 'http://proxy.corp:3128',
        NO_PROXY: 'intranet.corp',
        ENGINE_INTERNAL_URL: 'http://engine:8000',
        MEILI_HOST: 'http://meilisearch:7700',
      }),
    )
    expect(settings.https).toBe('http://proxy.corp:3128')
    expect(settings.noProxy.split(',')).toEqual(
      expect.arrayContaining(['intranet.corp', 'engine', 'meilisearch', 'localhost', '127.0.0.1']),
    )
    expect(proxySettings(loadEnv({ ...process.env, NO_PROXY: 'a, *' })).noProxy).toBe('*')
  })
})
