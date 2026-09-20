import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WEBHOOK_HEADERS } from '@kchs/contracts'
import { desc, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Исходящие и входящие вебхуки (P5-E02, ADR-0097).
 *
 * Подписчик шины и доставщик работают в роли worker, поэтому здесь они
 * вызываются напрямую: так проверка не зависит от очереди и остаётся
 * воспроизводимой. Негативные проверки: чужое событие не уходит, адрес
 * внутренней сети запрещён, неверный секрет входящего вебхука не отличим от
 * несуществующей интеграции.
 */
registerLifecycle()

const { dispatchEvent, deliverOnce, verifySignature } = await import(
  '../src/modules/integrations/domain/webhook-delivery.js'
)
const { checkOutboundUrl } = await import('../src/modules/integrations/domain/checks.js')
const { buildEnvelope } = await import('../src/kernel/events/publisher.js')
const { systemCtx } = await import('../src/shared/context.js')
const { resetConfigCache } = await import('../src/shared/config/index.js')
const { outbox, webhookDeliveries, webhooks } = await import('../src/shared/db/schema/index.js')

interface Received {
  headers: Record<string, string | undefined>
  body: string
}

let fx: TestContext
let server: Server
let base = ''
let received: Received[] = []
let respondWith = 200

beforeAll(async () => {
  fx = await setupFixture()
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      received.push({ headers: request.headers as Record<string, string | undefined>, body })
      response.statusCode = respondWith
      response.end('ok')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function createWebhook(
  payload: Record<string, unknown>,
): Promise<{ id: string; secret: string }> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/webhooks',
    as: fx.admin,
    payload: { url: `${base}/hook`, eventTypes: ['object.*'], ...payload },
  })
  expect(response.statusCode, response.body).toBe(200)
  const body = response.json()
  return { id: body.webhook.id, secret: body.secret }
}

function envelope(type: string, options: { spaceId?: string | null; principals?: string[] } = {}) {
  return buildEnvelope(systemCtx('test'), {
    type,
    object: { id: fx.spaceId, type: 'space', spaceId: options.spaceId ?? fx.spaceId },
    payload: type === 'object.created' ? { type: 'space', title: 'Проверка' } : {},
    ...(options.principals ? { visibilityPrincipals: options.principals } : {}),
  })
}

async function deliveriesOf(webhookId: string) {
  return db()
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, webhookId))
    .orderBy(desc(webhookDeliveries.createdAt))
}

describe('исходящие вебхуки', () => {
  it('секрет подписи выдаётся один раз и наружу больше не отдаётся', async () => {
    const { id, secret } = await createWebhook({ name: 'Подписка' })
    expect(secret.length).toBeGreaterThan(20)

    const card = await call(fx.app, { url: `/webhooks/${id}`, as: fx.admin })
    expect(card.statusCode).toBe(200)
    expect(card.json().hasSecret).toBe(true)
    expect(card.body).not.toContain(secret)

    const list = await call(fx.app, { url: '/webhooks', as: fx.admin })
    expect(list.body).not.toContain(secret)
  })

  it('доставляет событие с подписью HMAC-SHA256 и помечает доставку', async () => {
    received = []
    respondWith = 200
    const { id, secret } = await createWebhook({ name: 'Доставка' })

    await dispatchEvent(envelope('object.created'))
    const [delivery] = await deliveriesOf(id)
    expect(delivery, 'доставка заведена').toBeDefined()

    const result = await deliverOnce(delivery?.id ?? '')
    expect(result.status).toBe('delivered')
    expect(received).toHaveLength(1)

    const got = received[0]
    expect(got?.headers[WEBHOOK_HEADERS.event]).toBe('object.created')
    expect(got?.headers[WEBHOOK_HEADERS.delivery]).toBe(delivery?.id)
    const signature = got?.headers[WEBHOOK_HEADERS.signature] ?? ''
    const timestamp = got?.headers[WEBHOOK_HEADERS.timestamp] ?? ''
    expect(verifySignature(secret, timestamp, got?.body ?? '', signature)).toBe(true)
    // Подпись чужим секретом не проходит
    expect(verifySignature('чужой-секрет', timestamp, got?.body ?? '', signature)).toBe(false)

    const [after] = await deliveriesOf(id)
    expect(after?.status).toBe('delivered')
    expect(after?.responseStatus).toBe(200)
  })

  it('не берёт событие чужого типа, чужого пространства и на паузе', async () => {
    const { id } = await createWebhook({ name: 'Фильтры', eventTypes: ['document.*'] })
    await dispatchEvent(envelope('object.created'))
    expect(await deliveriesOf(id)).toHaveLength(0)

    const other = await createWebhook({
      name: 'Чужое пространство',
      spaceIds: [fx.orgSpaceId],
    })
    await dispatchEvent(envelope('object.created', { spaceId: fx.spaceId }))
    expect(await deliveriesOf(other.id)).toHaveLength(0)

    const paused = await createWebhook({ name: 'На паузе', status: 'paused' })
    await dispatchEvent(envelope('object.created'))
    expect(await deliveriesOf(paused.id)).toHaveLength(0)
  })

  it('не отдаёт наружу событие, которого владелец подписки не видит', async () => {
    const { id } = await createWebhook({ name: 'Видимость' })
    // Факт виден только постороннему — администратор-владелец подписки в список не входит
    await dispatchEvent(
      envelope('object.created', { principals: [`user:${fx.users.stranger.id}`] }),
    )
    expect(await deliveriesOf(id)).toHaveLength(0)

    await dispatchEvent(envelope('object.created', { principals: [`user:${fx.admin.id}`] }))
    expect(await deliveriesOf(id)).toHaveLength(1)
  })

  it('одно событие не задваивается при повторной обработке подписчиком', async () => {
    const { id } = await createWebhook({ name: 'Идемпотентность' })
    const event = envelope('object.created')
    await dispatchEvent(event)
    await dispatchEvent(event)
    expect(await deliveriesOf(id)).toHaveLength(1)
  })

  it('отказ назначает повтор, а серия отказов отключает вебхук', async () => {
    received = []
    respondWith = 500
    const { id } = await createWebhook({ name: 'Отказы', disableAfterFailures: 1 })

    await dispatchEvent(envelope('object.created'))
    const [delivery] = await deliveriesOf(id)
    const result = await deliverOnce(delivery?.id ?? '')
    expect(result.status).toBe('retry')

    const [after] = await deliveriesOf(id)
    expect(after?.status).toBe('pending')
    expect(after?.attempts).toBe(1)
    expect(after?.responseStatus).toBe(500)
    expect(after?.nextAttemptAt).not.toBeNull()

    const [row] = await db().select().from(webhooks).where(eq(webhooks.id, id))
    expect(row?.status).toBe('disabled')
    expect(row?.failureStreak).toBe(1)

    const events = await db()
      .select({ type: outbox.type })
      .from(outbox)
      .where(inArray(outbox.type, ['webhook.disabled']))
    expect(events.length).toBeGreaterThan(0)
    respondWith = 200
  })

  it('ручной повтор возвращает доставку в очередь', async () => {
    received = []
    respondWith = 500
    const { id } = await createWebhook({ name: 'Ручной повтор', disableAfterFailures: 50 })
    await dispatchEvent(envelope('object.created'))
    const [delivery] = await deliveriesOf(id)
    await deliverOnce(delivery?.id ?? '')

    respondWith = 200
    const retry = await call(fx.app, {
      method: 'POST',
      url: `/webhooks/${id}/deliveries/${delivery?.id}/retry`,
      as: fx.admin,
    })
    expect(retry.statusCode, retry.body).toBe(200)
    const second = await deliverOnce(delivery?.id ?? '')
    expect(second.status).toBe('delivered')

    const log = await call(fx.app, { url: `/webhooks/${id}/deliveries`, as: fx.admin })
    expect(log.statusCode).toBe(200)
    expect(log.json().items[0].status).toBe('delivered')
  })

  it('адреса внутренней сети запрещены, когда защита включена', async () => {
    process.env.WEBHOOKS_ALLOW_PRIVATE_ADDRESSES = 'false'
    resetConfigCache()
    try {
      for (const url of [
        'http://127.0.0.1/hook',
        'http://10.1.2.3/hook',
        'http://192.168.0.5/hook',
        'http://169.254.169.254/latest/meta-data',
        'http://[::1]/hook',
      ]) {
        const check = await checkOutboundUrl(url)
        expect(check.ok, url).toBe(false)
      }
      expect((await checkOutboundUrl('ftp://example.org')).ok).toBe(false)
    } finally {
      process.env.WEBHOOKS_ALLOW_PRIVATE_ADDRESSES = 'true'
      resetConfigCache()
    }
  })

  it('сотрудник без способности не видит вебхуки', async () => {
    const response = await call(fx.app, { url: '/webhooks', as: fx.users.member })
    expect(response.statusCode).toBe(403)
  })
})

describe('входящие вебхуки', () => {
  async function createIntegration(key: string): Promise<{ id: string; secret: string }> {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/integrations',
      as: fx.admin,
      payload: { key, kind: 'custom', name: `Интеграция ${key}` },
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string
    const secret = await call(fx.app, {
      method: 'POST',
      url: `/integrations/${id}/inbound-secret`,
      as: fx.admin,
    })
    expect(secret.statusCode, secret.body).toBe(200)
    return { id, secret: secret.json().secret }
  }

  it('верный секрет публикует событие `webhook.received` и ничего не меняет', async () => {
    const { id, secret } = await createIntegration(`inbound-${Date.now().toString(36)}`)
    const response = await call(fx.app, {
      method: 'POST',
      url: `/hooks/${id}/${secret}`,
      payload: { ticket: 42, status: 'new' },
    })
    expect(response.statusCode, response.body).toBe(202)

    const rows = await db()
      .select({ type: outbox.type, event: outbox.event })
      .from(outbox)
      .where(inArray(outbox.type, ['webhook.received']))
    const event = rows.at(-1)?.event as { payload?: Record<string, unknown> } | undefined
    expect(event?.payload?.integrationId).toBe(id)
    expect((event?.payload?.body as { ticket?: number } | undefined)?.ticket).toBe(42)
    // Секрет в событие не попадает
    expect(JSON.stringify(rows)).not.toContain(secret)
  })

  it('неверный секрет и неизвестная интеграция отвечают одинаково', async () => {
    const { id } = await createIntegration(`inbound-bad-${Date.now().toString(36)}`)
    const wrong = await call(fx.app, {
      method: 'POST',
      url: `/hooks/${id}/${'x'.repeat(32)}`,
      payload: {},
    })
    expect(wrong.statusCode).toBe(404)

    const unknown = await call(fx.app, {
      method: 'POST',
      url: `/hooks/${crypto.randomUUID()}/${'x'.repeat(32)}`,
      payload: {},
    })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().code).toBe(wrong.json().code)
  })

  it('выключенный вход перестаёт принимать запросы', async () => {
    const { id, secret } = await createIntegration(`inbound-off-${Date.now().toString(36)}`)
    const off = await call(fx.app, {
      method: 'PATCH',
      url: `/integrations/${id}`,
      as: fx.admin,
      payload: { inboundEnabled: false },
    })
    expect(off.statusCode, off.body).toBe(200)

    const response = await call(fx.app, {
      method: 'POST',
      url: `/hooks/${id}/${secret}`,
      payload: {},
    })
    expect(response.statusCode).toBe(404)
  })

  it('вход не даёт доступа к данным: сессии не появляется', async () => {
    const { id, secret } = await createIntegration(`inbound-noauth-${Date.now().toString(36)}`)
    const response = await call(fx.app, {
      method: 'POST',
      url: `/hooks/${id}/${secret}`,
      payload: {},
    })
    expect(response.statusCode).toBe(202)
    expect(response.headers['set-cookie']).toBeUndefined()

    // Тот же секрет не открывает обычные маршруты
    const objects = await call(fx.app, {
      url: `/objects/${fx.spaceId}`,
      headers: { authorization: `Bearer ${secret}` },
    })
    expect(objects.statusCode).toBe(401)
  })
})
