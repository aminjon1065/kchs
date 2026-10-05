import { type EventEnvelope, NOTIFICATION_CATEGORIES } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Ядро без словаря модулей (ADR-0182): действия аудита, категории уведомлений, виды
 * дел Входящих и события, после которых документ поиска устаревает, объявляют модули.
 * Поведение — прежнее, когда ядро знало их по именам; переиндексация по событию
 * модуля — новое: подписи полей датасета теперь доходят до поиска.
 */
registerLifecycle()

const bus = await import('../src/kernel/events/index.js')
const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
const { delegationCovers } = await import('../src/kernel/inbox/service.js')
const { inboxKind } = await import('../src/kernel/inbox/actions.js')
const { indexObject } = await import('../src/kernel/search/index-service.js')

let fx: TestContext
const run = Date.now().toString(36)
let previousSubscribers: ReturnType<typeof bus.listSubscribers>[number][] = []

beforeAll(async () => {
  fx = await setupFixture()
  previousSubscribers = [...bus.listSubscribers()]
  bus.clearSubscribers()
  registerKernelSubscribers()
})

afterAll(() => {
  bus.clearSubscribers()
  for (const subscriber of previousSubscribers) bus.registerSubscriber(subscriber)
})

async function searchIds(user: TestUser, q: string): Promise<string[]> {
  const response = await call(fx.app, { url: `/search?q=${encodeURIComponent(q)}`, as: user })
  expect(response.statusCode, response.body).toBe(200)
  return (response.json().hits as Array<{ objectId: string }>).map((hit) => hit.objectId)
}

describe('ядро без словаря модулей', () => {
  it('каталог действий аудита: свои у ядра, у модулей — объявленные ими', async () => {
    const response = await call(fx.app, { url: '/admin/audit/actions', as: fx.admin })
    expect(response.statusCode, response.body).toBe(200)
    const items = response.json().items as Array<{ action: string; owner: string }>
    const owner = new Map(items.map((item) => [item.action, item.owner]))
    expect(owner.size).toBe(items.length)
    expect(owner.get('user.login')).toBe('kernel')
    expect(owner.get('share_link.revoked')).toBe('kernel')
    expect(owner.get('document.registered')).toBe('documents')
    expect(owner.get('task.reassigned')).toBe('tasks')
    expect(owner.get('api_token.created')).toBe('integrations')
    expect(owner.get('file.downloaded')).toBe('files')
    expect(owner.get('help.pages_changed')).toBe('knowledge')
    expect(owner.get('user.mail_password_changed')).toBe('mail')

    const denied = await call(fx.app, { url: '/admin/audit/actions', as: fx.users.member })
    expect(denied.statusCode).toBe(403)
  })

  it('режимы уведомлений по умолчанию есть у каждой категории, у модульных — прежние', async () => {
    const response = await call(fx.app, { url: '/me/notification-preferences', as: fx.admin })
    expect(response.statusCode, response.body).toBe(200)
    const defaults = response.json().defaults as Array<{
      category: string
      channel: string
      mode: string
    }>
    const mode = (category: string, channel: string) =>
      defaults.find((item) => item.category === category && item.channel === channel)?.mode
    for (const category of NOTIFICATION_CATEGORIES) expect(mode(category, 'app')).toBe('immediate')
    expect(mode('tasks', 'telegram')).toBe('immediate')
    expect(mode('documents', 'email')).toBe('digest')
    expect(mode('chat.direct', 'push')).toBe('immediate')
    expect(mode('chat.channel', 'email')).toBe('off')
    expect(mode('meetings', 'email')).toBe('immediate')
    expect(mode('data', 'email')).toBe('digest')
  })

  it('виды дел Входящих: кнопки и области замещения объявляют их владельцы', () => {
    expect(inboxKind('accept_instruction')?.actions?.map((action) => action.key)).toEqual([
      'accept',
    ])
    expect(inboxKind('approve')?.actions?.map((action) => action.key)).toEqual([
      'approve',
      'remarks',
      'reject',
    ])
    expect(delegationCovers('approve', 'approvals')).toBe(true)
    expect(delegationCovers('resolve', 'documents')).toBe(true)
    expect(delegationCovers('resolve', 'instructions')).toBe(false)
    expect(delegationCovers('report_instruction', 'instructions')).toBe(true)
    expect(delegationCovers('respond_invite', 'meetings')).toBe(true)
    expect(delegationCovers('alert', 'documents')).toBe(false)
    expect(delegationCovers('alert', 'all')).toBe(true)
  })

  it('подпись поля датасета доходит до поиска: поиск ядра слушает событие модуля', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: `Словарь ${run}`,
        spaceId: fx.spaceId,
        fields: [{ key: 'flow', label: { ru: 'Расход' }, type: 'number' }],
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const datasetId = created.json().id as string
    await indexObject(datasetId)
    // Слово — только в подписи поля, не в названии датасета
    const word = `zq${Math.random().toString(36).slice(2, 9)}`
    expect(await searchIds(fx.admin, word)).not.toContain(datasetId)

    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/datasets/${datasetId}/fields/flow`,
      as: fx.admin,
      payload: { label: { ru: `Расход ${word}` } },
    })
    expect(patched.statusCode, patched.body).toBe(200)

    const rows = await db().execute<{ event: EventEnvelope }>(
      sql`SELECT event FROM ops.outbox
           WHERE type = 'dataset.schema_changed' AND event->'object'->>'id' = ${datasetId}
           ORDER BY id DESC LIMIT 1`,
    )
    const event = rows[0]?.event
    expect(event).toBeDefined()
    const search = bus.listSubscribers().find((subscriber) => subscriber.name === 'kernel-search')
    expect(search && bus.matchesType(search.types, 'dataset.schema_changed')).toBe(true)
    await search?.handle(event as EventEnvelope)

    const until = Date.now() + 10_000
    let hits = await searchIds(fx.admin, word)
    while (Date.now() < until && !hits.includes(datasetId)) {
      await new Promise((resolve) => setTimeout(resolve, 200))
      hits = await searchIds(fx.admin, word)
    }
    expect(hits).toContain(datasetId)
  })
})
