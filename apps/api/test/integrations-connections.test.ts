import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
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
 * Учёт подключений шлюза (ADR-0206): суточные счётчики запросов токенов через Redis
 * и сброс в базу, передачи из событий (лента, форма, входящий и исходящий вебхук,
 * строки по токену), системный датасет «Подключения» с правами смотрящего и
 * идемпотентный дашборд «Интеграции».
 */
registerLifecycle()

const { apiTokens, integrationConnections, integrationUsageDaily, objects, spaces } = await import(
  '../src/db-schema.js'
)
const usage = await import('../src/modules/integrations/domain/usage.js')
const { ensureIntegrationsDashboard } = await import('../src/seed/integrations-dashboard.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
let integrator: TestUser

beforeAll(async () => {
  fx = await setupFixture()
  integrator = await createUser(fx.app, 'connections_integrator', ['employee'])
})

async function issue(as: TestUser, name: string): Promise<{ secret: string; id: string }> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/me/api-tokens',
    as,
    payload: { name, scopes: ['read:objects', 'read:spaces', 'read:datasets'] },
  })
  expect(response.statusCode, response.body).toBe(200)
  return { secret: response.json().secret, id: response.json().token.id }
}

/** Счётчик токена пишется без ожидания — ждём, пока Redis его примет. */
async function pendingFor(tokenId: string, expected: number): Promise<number> {
  const day = usage.usageDay(new Date())
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const pending = await usage.pendingTokenUsage()
    const value = Number(pending[`${day}|${tokenId}`] ?? 0)
    if (value >= expected) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return Number((await usage.pendingTokenUsage())[`${day}|${tokenId}`] ?? 0)
}

async function dailyOf(subjectId: string, channel: string) {
  const [row] = await db()
    .select()
    .from(integrationUsageDaily)
    .where(
      and(
        eq(integrationUsageDaily.subjectId, subjectId),
        eq(integrationUsageDaily.channel, channel),
        eq(integrationUsageDaily.day, usage.usageDay(new Date())),
      ),
    )
  return row
}

function connectionsQuery(as: TestUser, steps: unknown[] = []) {
  return call(fx.app, {
    method: 'POST',
    url: '/queries/run',
    as,
    payload: {
      spec: {
        version: 1,
        source: { kind: 'system', name: 'connections' },
        steps: [
          { type: 'filter', where: { field: 'is_today', op: 'is_true' } },
          ...steps,
          {
            type: 'select',
            fields: ['connection_id', 'channel', 'requests', 'rows', 'errors', 'stale', 'status'],
          },
        ],
      },
    },
  })
}

type Row = [string, string, number, number, number, boolean, string]

function envelope(type: string, input: Record<string, unknown>) {
  return {
    id: randomUUID(),
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    actor: { kind: 'user', userId: fx.admin.id, onBehalfOf: null, sessionId: null },
    object: null,
    target: null,
    payload: {},
    changedFields: null,
    correlationId: null,
    causationId: null,
    source: 'api',
    visibility: null,
    ...input,
  } as never
}

describe('учёт подключений (ADR-0206)', () => {
  it('запросы по токену копятся в Redis и сбрасываются в суточный счётчик', async () => {
    const { secret, id } = await issue(fx.admin, 'Партнёр: гидромет')
    for (let i = 0; i < 3; i += 1) {
      const response = await call(fx.app, {
        url: `/objects/${fx.spaceId}`,
        headers: { authorization: `Bearer ${secret}` },
      })
      expect(response.statusCode, response.body).toBe(200)
    }
    expect(await pendingFor(id, 3)).toBe(3)
    // Горячий путь не пишет в базу
    expect(await dailyOf(id, 'api')).toBeUndefined()

    expect(await usage.flushTokenUsage()).toBeGreaterThanOrEqual(1)
    expect(await pendingFor(id, 1)).toBe(0)
    const daily = await dailyOf(id, 'api')
    expect(daily?.requests).toBe(3)

    // Второй сброс прибавляет, а не заменяет
    await call(fx.app, {
      url: `/objects/${fx.spaceId}`,
      headers: { authorization: `Bearer ${secret}` },
    })
    await pendingFor(id, 1)
    await usage.flushTokenUsage()
    expect((await dailyOf(id, 'api'))?.requests).toBe(4)

    const [connection] = await db()
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.subjectId, id))
    expect(connection).toMatchObject({
      channel: 'api',
      kind: 'token',
      title: 'Партнёр: гидромет',
      ownerId: fx.admin.id,
    })
    expect(connection?.lastAt).not.toBeNull()
  })

  it('недействительный токен счётчик не трогает', async () => {
    const before = await usage.pendingTokenUsage()
    const response = await call(fx.app, {
      url: `/objects/${fx.spaceId}`,
      headers: { authorization: 'Bearer kchs_nope_000000000000000000000000' },
    })
    expect(response.statusCode).toBe(401)
    expect(await usage.pendingTokenUsage()).toEqual(before)
  })

  it('передачи из событий: строки по токену, лента, форма, вебхуки, почта', async () => {
    const { id: tokenId } = await issue(fx.admin, 'Партнёр: запись строк')
    const feedId = randomUUID()
    const formId = randomUUID()
    const integrationId = randomUUID()
    const webhookId = randomUUID()

    const events = [
      envelope('dataset.rows_changed', {
        actor: {
          kind: 'user',
          userId: fx.admin.id,
          onBehalfOf: null,
          sessionId: `token:${tokenId}`,
        },
        payload: { op: 'insert', ids: [], count: 7 },
      }),
      // Правка человеком в браузере — не подключение
      envelope('dataset.rows_changed', {
        actor: { kind: 'user', userId: fx.admin.id, onBehalfOf: null, sessionId: 'sess-1' },
        payload: { op: 'insert', ids: [], count: 100 },
      }),
      envelope('source.synced', {
        object: { id: feedId, type: 'source', spaceId: null, title: 'GDACS' },
        payload: { rows: 20, inserted: 5, updated: 2, kind: 'feed' },
      }),
      envelope('source.failed', {
        object: { id: feedId, type: 'source', spaceId: null, title: 'GDACS' },
        payload: { error: 'таймаут', kind: 'feed' },
      }),
      envelope('form.submitted', {
        object: { id: formId, type: 'form', spaceId: null, title: 'Суточная сводка' },
        payload: { rowCount: 4 },
      }),
      envelope('webhook.received', {
        object: { id: integrationId, type: 'integration', spaceId: null, title: null },
        payload: { source: 'integration', integrationId, hookKey: 'hydromet' },
      }),
      envelope('mail.received', { payload: { integrationId, messageId: randomUUID() } }),
      envelope('webhook.delivered', { payload: { webhookId, deliveryId: randomUUID() } }),
      envelope('webhook.failed', { payload: { webhookId, error: '502' } }),
    ]
    for (const event of events) await usage.recordUsageEvent(event)

    expect((await dailyOf(tokenId, 'api'))?.rows).toBe(7)
    expect(await dailyOf(feedId, 'feed')).toMatchObject({ requests: 1, rows: 7, errors: 1 })
    expect(await dailyOf(formId, 'form')).toMatchObject({ requests: 1, rows: 4 })
    expect(await dailyOf(integrationId, 'webhook_in')).toMatchObject({ requests: 1 })
    expect(await dailyOf(integrationId, 'mail_in')).toMatchObject({ requests: 1 })
    expect(await dailyOf(webhookId, 'webhook_out')).toMatchObject({ requests: 1, errors: 1 })

    const [feed] = await db()
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.subjectId, feedId))
    expect(feed).toMatchObject({ title: 'GDACS', kind: 'source', lastError: 'таймаут' })
  })

  it('датасет «Подключения»: управляющий видит всё, сотрудник — свои токены', async () => {
    // Токен сотрудника выпускает администратор: способность выпуска — у роли администратора
    const own = { id: randomUUID() }
    await db()
      .insert(apiTokens)
      .values({
        id: own.id,
        userId: integrator.id,
        name: 'Мой токен',
        prefix: `kchs_t${own.id.slice(0, 8)}`,
        tokenHash: `hash-${own.id}`,
        scopes: ['read:objects'],
        createdById: fx.admin.id,
      })
    const admin = await connectionsQuery(fx.admin)
    expect(admin.statusCode, admin.body).toBe(200)
    const rows = admin.json().rows as Row[]
    // Неиспользованный токен — подключение без передач, «молчит»
    const silent = rows.find((row) => row[0] === own.id)
    expect(silent).toBeTruthy()
    expect(silent?.[2]).toBe(0)
    expect(silent?.[5]).toBe(true)
    expect(rows.some((row) => row[1] === 'feed')).toBe(true)

    const mine = await connectionsQuery(integrator)
    expect(mine.statusCode, mine.body).toBe(200)
    const ids = (mine.json().rows as Row[]).map((row) => row[0])
    expect(ids).toContain(own.id)
    expect(ids.every((id) => id === own.id)).toBe(true)

    const outsider = await connectionsQuery(fx.users.member)
    expect(outsider.statusCode, outsider.body).toBe(200)
    expect(outsider.json().rows).toHaveLength(0)
  })

  it('пропуски видны нулями: строки за прошлые дни с даты подключения', async () => {
    const subjectId = randomUUID()
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000)
    await db().transaction((tx) =>
      usage.recordUsage(tx, [
        {
          subjectId,
          channel: 'feed',
          kind: 'source',
          title: 'USGS',
          requests: 1,
          rows: 3,
          errors: 0,
          at: threeDaysAgo,
        },
      ]),
    )
    const response = await call(fx.app, {
      method: 'POST',
      url: '/queries/run',
      as: fx.admin,
      payload: {
        spec: {
          version: 1,
          source: { kind: 'system', name: 'connections' },
          steps: [
            { type: 'filter', where: { field: 'connection_id', op: 'eq', value: subjectId } },
            { type: 'select', fields: ['day', 'requests', 'active', 'completeness', 'stale'] },
            { type: 'sort', by: [{ field: 'day', dir: 'asc' }] },
          ],
        },
      },
    })
    expect(response.statusCode, response.body).toBe(200)
    const rows = response.json().rows as [string, number, boolean, number, boolean][]
    expect(rows).toHaveLength(4)
    expect(rows.map((row) => row[2])).toEqual([true, false, false, false])
    // Один день с передачами из четырёх
    expect(rows[3]?.[3]).toBe(25)
    expect(rows[3]?.[4]).toBe(true)
  })

  it('дашборд «Интеграции» заводится один раз, показатели считаются', async () => {
    const [org] = await db().select({ id: spaces.id }).from(spaces).limit(1)
    const ctx = systemCtx('test', { initiatorId: fx.admin.id })
    const first = await db().transaction((tx) =>
      ensureIntegrationsDashboard(tx, ctx, org?.id ?? fx.spaceId),
    )
    expect(first.created).toContain('integrations.connections')
    const second = await db().transaction((tx) =>
      ensureIntegrationsDashboard(tx, ctx, org?.id ?? fx.spaceId),
    )
    expect(second).toEqual({ dashboardId: first.dashboardId, created: [] })

    const [active] = await db()
      .select({ id: objects.id })
      .from(objects)
      .where(sql`${objects.meta}->>'systemKey' = 'integrations.active_connections'`)
    expect(active).toBeTruthy()
    const value = await call(fx.app, {
      method: 'POST',
      url: `/metrics/${active?.id}/value`,
      as: fx.admin,
      payload: {},
    })
    expect(value.statusCode, value.body).toBe(200)
    expect(value.json().value).toBeGreaterThanOrEqual(3)
  })
})
