import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Границы доступа из третьего разбора (ADR-0225): учётные записи и доступ не
 * управляются токеном API и снаружи через шлюз DMZ; гостю по ссылке открыт только
 * белый список маршрутов; «объяснить доступ» видит тот, кто управляет доступом;
 * предел открытий ссылки держится при параллельных открытиях.
 */
registerLifecycle()

const { registeredRoutes } = await import('../src/shared/http/route.js')
const { externalAccess } = await import('../src/modules/integrations/domain/gateway.js')

let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
})

async function folder(name: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name, spaceId: fx.spaceId },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

async function adminToken(scopes: string[]): Promise<Record<string, string>> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/me/api-tokens',
    as: fx.admin,
    payload: { name: `Границы ${Date.now()}`, scopes },
  })
  expect(response.statusCode, response.body).toBe(200)
  return { authorization: `Bearer ${response.json().secret as string}` }
}

describe('учётные записи и доступ — только из сессии', () => {
  it('токен администратора с областями записи не меняет пароль, роли, допуск и права', async () => {
    const headers = await adminToken([
      'write:org',
      'write:objects',
      'write:spaces',
      'write:documents',
    ])
    const target = fx.users.member.id
    const folderId = await folder(`Права по токену ${Date.now()}`)
    const attempts = [
      { method: 'POST' as const, url: `/users/${target}/reset-password` },
      { method: 'POST' as const, url: `/users/${target}/reset-mfa` },
      {
        method: 'PUT' as const,
        url: `/users/${target}/clearance`,
        payload: { clearance: 'secret' },
      },
      {
        method: 'PATCH' as const,
        url: `/users/${target}`,
        payload: { roleKeys: ['system_admin'] },
      },
      {
        method: 'POST' as const,
        url: '/users',
        payload: { login: `tok_${Date.now()}`, lastName: 'Т', firstName: 'Т' },
      },
      { method: 'POST' as const, url: '/roles', payload: { name: 'Своя', capabilities: [] } },
      { method: 'PUT' as const, url: `/groups/${fx.unitId}/members`, payload: { userIds: [] } },
      { method: 'GET' as const, url: `/users/${target}/facsimile` },
      { method: 'GET' as const, url: `/users/${target}/passkeys` },
      {
        method: 'POST' as const,
        url: `/objects/${folderId}/access`,
        payload: {
          grants: [{ principal: { type: 'user', id: fx.users.stranger.id }, level: 'edit' }],
        },
      },
      {
        method: 'POST' as const,
        url: `/objects/${folderId}/share-links`,
        payload: { level: 'view', includeAttachments: false },
      },
      {
        method: 'POST' as const,
        url: `/spaces/${fx.spaceId}/members`,
        payload: { userId: fx.users.stranger.id, role: 'editor' },
      },
    ]
    for (const attempt of attempts) {
      const response = await call(fx.app, { ...attempt, headers })
      expect(response.statusCode, `${attempt.method} ${attempt.url}: ${response.body}`).toBe(403)
      expect(response.json().detail).toBe('Этот маршрут недоступен токенам API')
    }

    // Чтение справочника и работа с объектами по токену остаются
    expect((await call(fx.app, { url: '/users?limit=5', headers })).statusCode).toBe(200)
    expect((await call(fx.app, { url: `/objects/${folderId}`, headers })).statusCode).toBe(200)
  })

  it('шлюз DMZ не открывает снаружи ни одного маршрута с признаком sessionOnly', () => {
    const sessionOnly = registeredRoutes().filter((route) => route.sessionOnly)
    expect(sessionOnly.length).toBeGreaterThanOrEqual(30)
    for (const route of sessionOnly) {
      expect(externalAccess(route), `${route.method} ${route.url}`).toBeNull()
    }
    const resetPassword = registeredRoutes().find(
      (route) => route.method === 'POST' && route.url === '/users/:id/reset-password',
    )
    expect(resetPassword?.sessionOnly).toBe(true)
  })
})

describe('гость по ссылке — только белый список', () => {
  it('видит объект, но не обсуждение, состав доступа, активность и объяснение', async () => {
    const folderId = await folder(`Для гостя ${Date.now()}`)
    const link = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/share-links`,
      as: fx.admin,
      payload: { level: 'view', includeAttachments: false },
    })
    expect(link.statusCode, link.body).toBe(200)
    const opened = await call(fx.app, {
      method: 'POST',
      url: `/share/${link.json().token}/open`,
      payload: {},
    })
    const guest = { 'x-kchs-share-token': opened.json().accessToken as string }

    expect((await call(fx.app, { url: `/objects/${folderId}`, headers: guest })).statusCode).toBe(
      200,
    )
    for (const url of [
      `/objects/${folderId}/discussion`,
      `/objects/${folderId}/access`,
      `/objects/${folderId}/activity`,
      `/objects/${folderId}/share-links`,
    ]) {
      const response = await call(fx.app, { url, headers: guest })
      expect(response.statusCode, url).toBe(404)
    }
    const explain = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/access/explain`,
      headers: guest,
      payload: { userId: fx.admin.id },
    })
    expect(explain.statusCode).toBe(404)
  })

  it('признак guest стоит только у GET с проверкой права', () => {
    const guestRoutes = registeredRoutes().filter((route) => route.guest)
    expect(guestRoutes.map((route) => `${route.method} ${route.url}`).sort()).toEqual([
      'GET /files/:id',
      'GET /files/:id/download',
      'GET /files/:id/previews',
      'GET /files/:id/text',
      'GET /objects/:id',
    ])
  })
})

describe('объяснение доступа', () => {
  it('читатель объекта не видит, кто и почему имеет доступ', async () => {
    const folderId = await folder(`Объяснение ${Date.now()}`)
    const asViewer = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/access/explain`,
      as: fx.users.viewer,
      payload: { userId: fx.users.member.id },
    })
    expect(asViewer.statusCode).toBe(403)

    const asAdmin = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/access/explain`,
      as: fx.admin,
      payload: { userId: fx.users.member.id },
    })
    expect(asAdmin.statusCode, asAdmin.body).toBe(200)
  })
})

describe('предел открытий гостевой ссылки', () => {
  it('параллельные открытия не проходят сверх maxUses', async () => {
    const folderId = await folder(`Одно открытие ${Date.now()}`)
    const link = await call(fx.app, {
      method: 'POST',
      url: `/objects/${folderId}/share-links`,
      as: fx.admin,
      payload: { level: 'view', maxUses: 1, includeAttachments: false },
    })
    expect(link.statusCode, link.body).toBe(200)
    const token = link.json().token as string
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        call(fx.app, { method: 'POST', url: `/share/${token}/open`, payload: {} }),
      ),
    )
    const granted = results.filter((result) => result.statusCode === 200)
    expect(granted).toHaveLength(1)
    expect(granted[0]?.json().accessToken).toBeTruthy()
  })
})
