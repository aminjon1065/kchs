import { randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Subscriber } from '../src/kernel/events/types.js'
import { db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Надёжность поисковой проекции (ADR-0228): события подписчика поиска, ушедшие в
 * DLQ, возвращаются в поток сами, а ночная сверка приводит индекс к реестру —
 * читатели по текущим правам, документов без объекта в индексе не остаётся.
 */
registerLifecycle()

const bus = await import('../src/kernel/events/index.js')
const { sendToDlq, DLQ_STREAM, streamKey, eventDomain } = await import(
  '../src/kernel/events/bus.js'
)
const { redriveProjections } = await import('../src/kernel/events/streams.js')
const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
const { ObjectService } = await import('../src/kernel/objects/service.js')
const { readPrincipalsFor } = await import('../src/kernel/access/acl-service.js')
const { ensureSearchIndex, indexObjects, objectsIndex, reconcileSearchIndex } = await import(
  '../src/kernel/search/index-service.js'
)
const { systemCtx } = await import('../src/shared/context.js')
const { redis } = await import('../src/shared/redis/index.js')

let fx: TestContext
let previousSubscribers: Subscriber[] = []

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function createFolder(title: string): Promise<string> {
  const ctx = systemCtx('test', { initiatorId: fx.admin.id })
  const created = await db().transaction((tx) =>
    ObjectService.create(tx, ctx, { type: 'folder', spaceId: fx.spaceId, title }),
  )
  return created.id
}

async function eventOf(objectId: string): Promise<EventEnvelope> {
  const [row] = await db().execute<{ event: EventEnvelope }>(
    sql`SELECT event FROM ops.outbox WHERE event->'object'->>'id' = ${objectId} ORDER BY id LIMIT 1`,
  )
  if (!row) throw new Error('события нет')
  return row.event
}

async function dlqFor(eventId: string): Promise<string[]> {
  const rows = (await redis().xrange(DLQ_STREAM, '-', '+')) as Array<[string, string[]]>
  return rows
    .filter(([, fields]) => fields.some((field) => field.includes(eventId)))
    .map(([, fields]) => fields[fields.indexOf('consumer') + 1] ?? '')
}

async function documentOf(id: string): Promise<{ aclPrincipals: string[] } | null> {
  return objectsIndex()
    .getDocument(id)
    .then((doc) => doc as unknown as { aclPrincipals: string[] })
    .catch(() => null)
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 15_000) {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('условие не выполнено вовремя')
    await sleep(100)
  }
}

beforeAll(async () => {
  fx = await setupFixture()
  previousSubscribers = [...bus.listSubscribers()]
  bus.clearSubscribers()
  registerKernelSubscribers()
  await ensureSearchIndex()
})

afterAll(() => {
  bus.clearSubscribers()
  for (const subscriber of previousSubscribers) bus.registerSubscriber(subscriber)
})

describe('события поиска из DLQ (ADR-0228)', () => {
  it('возвращаются в поток сами — только у проекций и только отлежавшиеся', async () => {
    const event = await eventOf(await createFolder(`Из DLQ ${randomUUID()}`))
    await sendToDlq(event, 'kernel-search', new Error('поиск недоступен'), 5)
    await sendToDlq(event, 'kernel-realtime', new Error('сбой'), 5)

    // Свежая запись ещё ждёт: служба, может быть, не поднялась
    expect(await redriveProjections({ minAgeMs: 60_000 })).toBe(0)
    expect((await dlqFor(event.id)).sort()).toEqual(['kernel-realtime', 'kernel-search'])

    expect(await redriveProjections({ minAgeMs: 0 })).toBeGreaterThanOrEqual(1)
    // Событие поиска вернулось в поток своего домена адресно, активность — у администратора
    expect(await dlqFor(event.id)).toEqual(['kernel-realtime'])
    const stream = (await redis().xrevrange(
      streamKey(eventDomain(event)),
      '+',
      '-',
      'COUNT',
      50,
    )) as Array<[string, string[]]>
    const redelivered = stream.find(([, fields]) => fields.some((f) => f.includes(event.id)))
    expect(redelivered?.[1]).toContain('kernel-search')

    // Оставшаяся запись не мешает другим тестам слота, которые считают DLQ
    const rows = (await redis().xrange(DLQ_STREAM, '-', '+')) as Array<[string, string[]]>
    for (const [id, fields] of rows) {
      if (fields.some((field) => field.includes(event.id))) await redis().xdel(DLQ_STREAM, id)
    }
  })
})

describe('ночная сверка индекса (ADR-0228)', () => {
  it('читатели — по текущим правам, документы без объекта удаляются', async () => {
    const real = await createFolder(`Сверка ${randomUUID()}`)
    await indexObjects([real])
    // Потерянное событие отзыва доступа: в индексе устаревшие читатели
    await objectsIndex()
      .updateDocuments([{ id: real, aclPrincipals: ['user:посторонний'] }])
      .waitTask()
    // Объект удалён окончательно, а событие удаления до поиска не дошло
    const orphan = randomUUID()
    await objectsIndex()
      .addDocuments([
        {
          id: orphan,
          objectId: orphan,
          type: 'folder',
          title: 'Сирота',
          body: '',
          aclPrincipals: ['role:employee'],
          updatedAt: 0,
          tags: [],
        },
      ])
      .waitTask()

    const result = await reconcileSearchIndex()
    expect(result.removed).toBeGreaterThanOrEqual(1)
    const expected = (await readPrincipalsFor(real)).sort()
    await waitUntil(async () => (await documentOf(orphan)) === null)
    await waitUntil(
      async () =>
        JSON.stringify((await documentOf(real))?.aclPrincipals.sort()) === JSON.stringify(expected),
    )
  })
})
