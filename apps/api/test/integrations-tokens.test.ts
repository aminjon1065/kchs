import { eq, inArray, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
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
 * Токены публичного API (P5-E02, ADR-0097). Главное здесь — негативные
 * проверки: токен не расширяет права человека, область проверяется на каждом
 * маршруте, отозванный и просроченный токен не работают, личные маршруты и
 * администрирование токенам закрыты (17-security.md §2, §3).
 */
registerLifecycle()

const { apiTokens, auditLog, outbox } = await import('../src/shared/db/schema/index.js')

let fx: TestContext
let integrator: TestUser

beforeAll(async () => {
  fx = await setupFixture()
  // Служебная учётная запись интеграции: обычный сотрудник с правом выпуска
  integrator = await createUser(fx.app, 'integrator_test', ['employee'])
})

async function issue(
  as: TestUser,
  payload: Record<string, unknown>,
): Promise<{ secret: string; id: string }> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/me/api-tokens',
    as,
    payload,
  })
  expect(response.statusCode, response.body).toBe(200)
  const body = response.json()
  return { secret: body.secret, id: body.token.id }
}

function withToken(secret: string) {
  return { authorization: `Bearer ${secret}` }
}

describe('токены публичного API', () => {
  it('выпускается администратором, показывается один раз и попадает в список', async () => {
    const { secret, id } = await issue(fx.admin, {
      name: 'Тестовая интеграция',
      scopes: ['read:objects', 'read:spaces'],
    })
    expect(secret.startsWith('kchs_')).toBe(true)

    const list = await call(fx.app, { url: '/me/api-tokens', as: fx.admin })
    expect(list.statusCode).toBe(200)
    const token = list.json().items.find((item: { id: string }) => item.id === id)
    expect(token.status).toBe('active')
    // Ни самого токена, ни его хэша наружу
    expect(JSON.stringify(token)).not.toContain(secret)
    expect(token.prefix.length).toBeGreaterThan(0)
    expect(secret).toContain(token.prefix)
  })

  it('без способности `api_tokens.create` токен не выпускается', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/me/api-tokens',
      as: fx.users.member,
      payload: { name: 'нельзя', scopes: ['read:objects'] },
    })
    expect(response.statusCode).toBe(403)
  })

  it('аутентифицирует запрос наравне с cookie-сессией и без CSRF-токена', async () => {
    const { secret } = await issue(fx.admin, {
      name: 'Чтение объектов',
      scopes: ['read:objects'],
    })
    const response = await call(fx.app, {
      method: 'POST',
      url: '/objects/batch-get',
      headers: withToken(secret),
      payload: { ids: [fx.spaceId] },
    })
    // POST без x-csrf-token: Bearer не подвержен CSRF (17-security.md §5)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().items).toHaveLength(1)
  })

  it('без нужной области маршрут отвечает 403', async () => {
    const { secret } = await issue(fx.admin, { name: 'Только данные', scopes: ['read:datasets'] })
    const response = await call(fx.app, {
      url: `/objects/${fx.spaceId}`,
      headers: withToken(secret),
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().code).toBe('forbidden')
  })

  it('область чтения не даёт записи', async () => {
    const { secret } = await issue(fx.admin, { name: 'Чтение данных', scopes: ['read:datasets'] })
    const response = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      headers: withToken(secret),
      payload: { name: 'Не должен создаться', spaceId: fx.spaceId, fields: [] },
    })
    expect(response.statusCode).toBe(403)
  })

  it('область записи включает чтение того же ресурса', async () => {
    const { secret } = await issue(fx.admin, { name: 'Запись объектов', scopes: ['write:objects'] })
    const response = await call(fx.app, {
      url: `/objects/${fx.spaceId}`,
      headers: withToken(secret),
    })
    expect(response.statusCode, response.body).toBe(200)
  })

  it('не расширяет прав владельца: чужой объект остаётся невидимым', async () => {
    // Пространство `fx.spaceId` посторонний не видит; токен выпущен на него
    const stranger = fx.users.stranger
    const { secret } = await issue(fx.admin, {
      name: 'От имени постороннего',
      scopes: ['read:objects'],
      userId: stranger.id,
    })
    const response = await call(fx.app, {
      url: `/objects/${fx.spaceId}`,
      headers: withToken(secret),
    })
    // 404 вместо 403 — существование объекта не раскрывается (17-security.md §3)
    expect(response.statusCode).toBe(404)
  })

  it('токен на другого пользователя выпускает только администратор системы', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/me/api-tokens',
      as: fx.users.member,
      payload: { name: 'чужой', scopes: ['read:objects'], userId: fx.admin.id },
    })
    expect(response.statusCode).toBe(403)
  })

  it('личные маршруты и администрирование токенам закрыты', async () => {
    const { secret } = await issue(fx.admin, {
      name: 'Полный набор',
      scopes: ['read:objects', 'write:objects', 'read:integrations', 'write:integrations'],
    })
    for (const url of ['/me', '/me/api-tokens', '/admin/audit', '/admin/api-tokens']) {
      const response = await call(fx.app, { url, headers: withToken(secret) })
      expect([403, 404], `${url}: ${response.body}`).toContain(response.statusCode)
    }
    // Токен не выпускает другой токен
    const issued = await call(fx.app, {
      method: 'POST',
      url: '/me/api-tokens',
      headers: withToken(secret),
      payload: { name: 'второй', scopes: ['read:objects'] },
    })
    expect(issued.statusCode).toBe(403)
  })

  it('замещение по заголовку с токеном не принимается', async () => {
    const { secret } = await issue(fx.admin, { name: 'Замещение', scopes: ['read:objects'] })
    const response = await call(fx.app, {
      url: `/objects/${fx.spaceId}`,
      headers: { ...withToken(secret), 'x-kchs-on-behalf-of': fx.users.member.id },
    })
    expect(response.statusCode).toBe(403)
  })

  it('отозванный токен не работает', async () => {
    const { secret, id } = await issue(fx.admin, { name: 'На отзыв', scopes: ['read:objects'] })
    const ok = await call(fx.app, { url: `/objects/${fx.spaceId}`, headers: withToken(secret) })
    expect(ok.statusCode).toBe(200)

    const revoked = await call(fx.app, {
      method: 'DELETE',
      url: `/me/api-tokens/${id}`,
      as: fx.admin,
    })
    expect(revoked.statusCode).toBe(200)

    const after = await call(fx.app, { url: `/objects/${fx.spaceId}`, headers: withToken(secret) })
    expect(after.statusCode).toBe(401)
  })

  it('просроченный токен не работает', async () => {
    const { secret, id } = await issue(fx.admin, {
      name: 'Со сроком',
      scopes: ['read:objects'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await db()
      .update(apiTokens)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(apiTokens.id, id))
    const response = await call(fx.app, {
      url: `/objects/${fx.spaceId}`,
      headers: withToken(secret),
    })
    expect(response.statusCode).toBe(401)
  })

  it('подделанный и мусорный токен отклоняются', async () => {
    const { secret } = await issue(fx.admin, { name: 'Подделка', scopes: ['read:objects'] })
    const prefix = secret.slice(0, secret.indexOf('_', 5))
    const forged = `${prefix}_${'A'.repeat(43)}`
    for (const value of [forged, 'kchs_zzzz_zzzz', 'простоСтрока', '']) {
      const response = await call(fx.app, {
        url: `/objects/${fx.spaceId}`,
        headers: { authorization: `Bearer ${value}` },
      })
      expect([401, 400], `${value}: ${response.statusCode}`).toContain(response.statusCode)
    }
  })

  it('чужой токен сотрудник не отзывает', async () => {
    const { id } = await issue(fx.admin, { name: 'Чужой', scopes: ['read:objects'] })
    const response = await call(fx.app, {
      method: 'DELETE',
      url: `/me/api-tokens/${id}`,
      as: fx.users.member,
    })
    expect(response.statusCode).toBe(404)
  })

  it('выпуск и отзыв публикуют события и пишутся в аудит без самого токена', async () => {
    const { secret, id } = await issue(fx.admin, { name: 'Учёт', scopes: ['read:objects'] })
    await call(fx.app, { method: 'DELETE', url: `/me/api-tokens/${id}`, as: fx.admin })

    const rows = await db()
      .select({ type: outbox.type, event: outbox.event })
      .from(outbox)
      .where(inArray(outbox.type, ['token.created', 'token.revoked']))
      .limit(50)
    expect(rows.some((row) => row.type === 'token.created')).toBe(true)
    expect(rows.some((row) => row.type === 'token.revoked')).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(secret)

    const entries = await db()
      .select({ details: auditLog.details })
      .from(auditLog)
      .where(inArray(auditLog.action, ['api_token.created', 'api_token.revoked']))
      .limit(50)
    expect(entries.length).toBeGreaterThan(0)
    expect(JSON.stringify(entries)).not.toContain(secret)
  })
})

describe('служебная учётная запись', () => {
  it('токен на служебного пользователя действует его правами', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/me/api-tokens',
      as: fx.admin,
      payload: { name: 'Служебная', scopes: ['read:objects'], userId: integrator.id },
    })
    expect(response.statusCode, response.body).toBe(200)
    const secret = response.json().secret as string

    // Служебный пользователь не участник пространства — объект ему не виден
    const hidden = await call(fx.app, {
      url: `/objects/${fx.spaceId}`,
      headers: withToken(secret),
    })
    expect(hidden.statusCode).toBe(404)
  })

  it('блокировка владельца закрывает его токен: увольнение выключает и машину', async () => {
    // Токен живёт дольше сессии, и сотрудник уходит вместе с ним. Отдельно
    // отзывать токены уволенного никто не вспомнит (17-security.md §2)
    const leaving = await createUser(fx.app, `leaving_${Date.now().toString(36)}`, ['employee'])
    const issued = await call(fx.app, {
      method: 'POST',
      url: '/me/api-tokens',
      as: fx.admin,
      payload: { name: 'Служебная при увольнении', scopes: ['read:objects'], userId: leaving.id },
    })
    expect(issued.statusCode, issued.body).toBe(200)
    const secret = issued.json().secret as string
    const before = await call(fx.app, { url: '/objects/batch-get', headers: withToken(secret) })
    expect(before.statusCode).not.toBe(401)

    const blocked = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${leaving.id}`,
      as: fx.admin,
      payload: { status: 'blocked' },
    })
    expect(blocked.statusCode, blocked.body).toBe(200)

    const after = await call(fx.app, { url: '/objects/batch-get', headers: withToken(secret) })
    expect(after.statusCode).toBe(401)
  })
})
