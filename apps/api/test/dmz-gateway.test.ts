import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { HttpMethod } from '@kchs/contracts'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Шлюз DMZ (ADR-0200). Белый список шлюза генерируется из реестра маршрутов, и тест
 * проверяет его по каждому маршруту: снаружи открыт маршрут, только если он объявлен
 * `exposure: 'public'` или доступен токену API по области (ADR-0097). Сопоставление —
 * по сгенерированному файлу, так же, как это делает Caddy: сначала закрытые
 * заслонённые пути, потом без входа, потом по токену. Второй рубеж — в api: запрос с
 * пометкой шлюза `X-Kchs-Zone: dmz` проходит только к открытым снаружи маршрутам и
 * только с токеном.
 */
registerLifecycle()

const { registeredRoutes } = await import('../src/shared/http/route.js')
const gateway = await import('../src/modules/integrations/domain/gateway.js')

const FILE = fileURLToPath(
  new URL('../../../infra/compose/caddy/dmz-routes.caddy', import.meta.url),
)
const DMZ = { 'x-kchs-zone': 'dmz' }

let fx: TestContext
let committed = ''

beforeAll(async () => {
  fx = await setupFixture()
  committed = await readFile(FILE, 'utf8')
})

async function issueToken(scopes: string[]): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/me/api-tokens',
    as: fx.admin,
    payload: { name: `Шлюз ${scopes.join(' ')}`, scopes },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().secret as string
}

describe('белый список шлюза DMZ', () => {
  it('файл в git совпадает с таблицей маршрутов (иначе — pnpm --filter @kchs/api dmz:gen)', () => {
    expect(gateway.renderGatewayRoutes(registeredRoutes())).toBe(committed)
  })

  it('каждый маршрут снаружи открыт, только если он разрешён', () => {
    const parsed = gateway.parseGatewayRoutes(committed)
    const wrong: string[] = []
    let open = 0
    for (const route of registeredRoutes()) {
      const expected = gateway.externalAccess(route)
      const verdict = gateway.gatewayVerdict(parsed, route.method, gateway.samplePath(route.url))
      const passes = verdict === 'public' || verdict === 'token'
      if (expected) open += 1
      if (expected ? verdict !== expected : passes) {
        wrong.push(
          `${route.method} ${route.url}: ожидалось ${expected ?? 'закрыт'}, шлюз — ${verdict}`,
        )
      }
    }
    expect(wrong).toEqual([])
    expect(open).toBeGreaterThan(100)
  })

  it('вход, личный кабинет, администрирование, служебные маршруты и гостевые ссылки закрыты всегда', () => {
    const parsed = gateway.parseGatewayRoutes(committed)
    const never = ['/auth', '/me', '/admin', '/internal', '/share', '/office', '/print']
    const leaks = registeredRoutes()
      .filter((route) =>
        never.some((prefix) => route.url === prefix || route.url.startsWith(`${prefix}/`)),
      )
      .filter((route) => {
        const verdict = gateway.gatewayVerdict(parsed, route.method, gateway.samplePath(route.url))
        return verdict === 'public' || verdict === 'token'
      })
      .map((route) => `${route.method} ${route.url}`)
    expect(leaks).toEqual([])
    // Пути вне реестра маршрутов API — realtime, совместное редактирование, редактор,
    // документация и здоровье — шлюз не знает и не пропускает
    const outside: Array<[HttpMethod, string]> = [
      ['GET', '/ws/socket.io/'],
      ['GET', '/collab/x1'],
      ['GET', '/api/v1/office/editor/x1'],
      ['GET', '/api/docs'],
      ['GET', '/api/openapi.json'],
      ['GET', '/health'],
    ]
    for (const [method, path] of outside) {
      expect(gateway.gatewayVerdict(parsed, method, path), path).toBe('none')
    }
  })

  it('известные маршруты: вебхуки — без входа, данные — по токену, вход и консоль — закрыты', () => {
    const find = (method: HttpMethod, url: string) => {
      const route = registeredRoutes().find((item) => item.method === method && item.url === url)
      if (!route) throw new Error(`нет маршрута ${method} ${url}`)
      return gateway.externalAccess(route)
    }
    expect(find('POST', '/hooks/:integrationId/:secret')).toBe('public')
    expect(find('POST', '/hooks/rules/:id/:token')).toBe('public')
    expect(find('GET', '/datasets/:id')).toBe('token')
    expect(find('POST', '/auth/login')).toBeNull()
    expect(find('GET', '/me')).toBeNull()
    expect(find('GET', '/admin/security-policy')).toBeNull()
    expect(find('GET', '/meetings/guest/:token')).toBeNull()
  })

  it('объявить снаружи маршрут входа или служебный нельзя — это ошибка конфигурации', () => {
    expect(() =>
      gateway.externalAccess({
        method: 'POST',
        url: '/auth/login',
        auth: 'public',
        exposure: 'public',
      }),
    ).toThrow(/exposure/)
    expect(() =>
      gateway.externalAccess({
        method: 'GET',
        url: '/datasets/:id',
        auth: { action: 'view' },
        exposure: 'public',
      }),
    ).toThrow(/exposure/)
  })
})

describe('второй рубеж: запрос через шлюз в самом api', () => {
  it('закрытый снаружи маршрут — 404, даже если сессия есть', async () => {
    const login = await call(fx.app, {
      method: 'POST',
      url: '/auth/login',
      headers: DMZ,
      payload: { login: 'admin_test', password: 'нет' },
    })
    expect(login.statusCode).toBe(404)
    // Отказ второго рубежа узнаётся по тексту: обработчик входа сюда не дошёл
    expect(login.json().detail).toBe('Маршрут не найден')
    const me = await call(fx.app, { url: '/me', as: fx.admin, headers: DMZ })
    expect(me.statusCode).toBe(404)
    const guest = await call(fx.app, { url: '/meetings/guest/abcdefabcdefabcdef', headers: DMZ })
    expect(guest.statusCode).toBe(404)
    // Без пометки шлюза — как раньше
    expect((await call(fx.app, { url: '/me', as: fx.admin })).statusCode).toBe(200)
  })

  it('маршрут API снаружи — только с токеном: сессия не принимается', async () => {
    const bySession = await call(fx.app, { url: '/spaces', as: fx.admin, headers: DMZ })
    expect(bySession.statusCode).toBe(401)
    expect(bySession.json().detail).toContain('токен')

    const secret = await issueToken(['read:spaces'])
    const byToken = await call(fx.app, {
      url: '/spaces',
      headers: { ...DMZ, authorization: `Bearer ${secret}` },
    })
    expect(byToken.statusCode, byToken.body).toBe(200)

    // Токен не открывает снаружи то, что закрыто для токенов
    const admin = await call(fx.app, {
      url: '/admin/security-policy',
      headers: { ...DMZ, authorization: `Bearer ${secret}` },
    })
    expect(admin.statusCode).toBe(404)
  })

  it('маршрут без входа, объявленный открытым, доходит до обработчика', async () => {
    const hook = await call(fx.app, {
      method: 'POST',
      url: '/hooks/00000000-0000-4000-8000-000000000000/secret-value',
      headers: DMZ,
      payload: { ping: true },
    })
    // Отвечает обработчик вебхука (нет такой интеграции — 404 по ADR-0097), а не
    // второй рубеж шлюза
    expect(hook.statusCode).toBe(404)
    expect(hook.json().detail).not.toBe('Маршрут не найден')
  })
})
