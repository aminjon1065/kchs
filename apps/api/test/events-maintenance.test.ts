import type { EventEnvelope } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Subscriber } from '../src/kernel/events/types.js'
import { call, db, redis, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Обслуживание шины событий (ADR-0171): откуда новая группа начинает читать,
 * обрезка потока не трогает непрочитанное, повтор из очереди сбоев получает только
 * упавший подписчик, отметки обработки чистятся по сроку.
 */
registerLifecycle()

const bus = await import('../src/kernel/events/index.js')
const { pruneEventConsumptions, trimStreams, trimThreshold } = await import(
  '../src/kernel/events/streams.js'
)

let fx: TestContext
let kernelSubscribers: Subscriber[] = []
const run = Date.now().toString(36)
const FAST = { blockMs: 100, retryIdleMs: 300, claimIntervalMs: 100 }

beforeAll(async () => {
  fx = await setupFixture()
  kernelSubscribers = [...bus.listSubscribers()]
})

afterEach(async () => {
  await bus.stopConsumers()
  bus.clearSubscribers()
  for (const subscriber of kernelSubscribers) bus.registerSubscriber(subscriber)
})

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('условие не выполнилось за отведённое время')
}

async function dispatchAll(): Promise<void> {
  while ((await bus.dispatchOnce()) > 0) {
    // публикуем всё накопленное в outbox
  }
}

async function createFolder(name: string): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/folders',
    as: fx.admin,
    payload: { name, spaceId: fx.spaceId },
  })
  expect(response.statusCode).toBe(200)
  return response.json().id as string
}

/** Подписчик, собирающий названия созданных объектов этого прогона. */
function collector(name: string, seen: string[], extra: Partial<Subscriber> = {}): Subscriber {
  return {
    name,
    types: ['object.created'],
    handle: async (event) => {
      const title = event.object?.title ?? ''
      if (title.includes(run)) seen.push(title)
    },
    ...extra,
  }
}

/** Названия объектов событий потока, которые в нём ещё лежат. */
async function titlesInStream(stream: string): Promise<string[]> {
  const entries = (await redis().xrange(stream, '-', '+')) as Array<[string, string[]]>
  return entries.map(([, fields]) => {
    const event = JSON.parse(fields[fields.indexOf('event') + 1] ?? '{}') as EventEnvelope
    return event.object?.title ?? ''
  })
}

describe('шина событий: обслуживание', () => {
  it('подписчик из обновления начинает с новых событий, проекция с replay — с начала', async () => {
    // Установка уже работала: группы созданы, в потоке лежит прежнее событие
    bus.clearSubscribers()
    bus.registerSubscriber(collector(`test-existing-${run}`, []))
    await bus.startConsumers(FAST)
    await bus.stopConsumers()
    const before = `Прежнее ${run}`
    await createFolder(before)
    await dispatchAll()

    const fresh: string[] = []
    const replayed: string[] = []
    bus.clearSubscribers()
    bus.registerSubscriber(collector(`test-fresh-${run}`, fresh))
    bus.registerSubscriber(collector(`test-replay-${run}`, replayed, { replay: true }))
    await bus.startConsumers(FAST)

    const after = `Новое ${run}`
    await createFolder(after)
    await dispatchAll()

    await waitFor(() => fresh.includes(after) && replayed.includes(after))
    expect(fresh).toEqual([after])
    expect(replayed).toContain(before)
  })

  it('обрезка потока не трогает то, что группа ещё не прочитала или не подтвердила', async () => {
    const name = `test-trim-${run}`
    bus.clearSubscribers()
    bus.registerSubscriber(collector(name, []))
    await redis().xgroup('CREATE', 'events:object', name, '$', 'MKSTREAM')

    const title = `Непрочитанное ${run}`
    await createFolder(title)
    await dispatchAll()
    const entries = (await redis().xrange('events:object', '-', '+')) as Array<[string, string[]]>
    const last = entries[entries.length - 1]?.[0] ?? ''
    // «Сейчас» — через сутки и час: по сроку хранения обрезать можно всё
    const later = Date.now() + 25 * 3600_000

    // Не прочитано: граница не выше записи
    expect(compare(await trimThreshold('events:object', later), last)).toBeLessThanOrEqual(0)
    await trimStreams(later)
    expect(await titlesInStream('events:object')).toContain(title)

    // Прочитано, но не подтверждено: запись держит неподтверждённая доставка
    const read = (await redis().xreadgroup(
      'GROUP',
      name,
      'reader',
      'COUNT',
      10_000,
      'STREAMS',
      'events:object',
      '>',
    )) as Array<[string, Array<[string, string[]]>]>
    const ids = read[0]?.[1].map(([id]) => id) ?? []
    expect(ids).toContain(last)
    expect(await trimThreshold('events:object', later)).toBe(ids[0])
    await trimStreams(later)
    expect(await titlesInStream('events:object')).toContain(title)

    // Подтверждено: граница уходит за запись — следующая обрезка её снимет
    await redis().xack('events:object', name, ...ids)
    expect(compare(await trimThreshold('events:object', later), last)).toBeGreaterThan(0)
  })

  it('без срока хранения подтверждённое не снимается: история нужна проекциям', async () => {
    bus.clearSubscribers()
    const threshold = await trimThreshold('events:object')
    // Граница по сроку хранения — сутки назад, все события прогона моложе
    const entries = (await redis().xrange('events:object', '-', '+')) as Array<[string, string[]]>
    const newest = entries[entries.length - 1]?.[0] ?? '0-0'
    expect(compare(threshold, newest)).toBeLessThan(0)
  })

  it('повтор из очереди сбоев получает только упавший подписчик', async () => {
    const failing = `test-dlq-fail-${run}`
    const other = `test-dlq-other-${run}`
    const title = `Сбой подписчика ${run}`
    let broken = true
    const failed: string[] = []
    const handled: string[] = []
    bus.clearSubscribers()
    bus.registerSubscriber({
      name: failing,
      types: ['object.created'],
      maxAttempts: 1,
      handle: async (event) => {
        if (event.object?.title !== title) return
        failed.push(event.id)
        if (broken) throw new Error('сбой для очереди сбоев')
      },
    })
    bus.registerSubscriber({
      name: other,
      types: ['object.created'],
      handle: async (event) => {
        if (event.object?.title === title) handled.push(event.id)
      },
    })
    await bus.startConsumers(FAST)

    const folderId = await createFolder(title)
    await dispatchAll()

    const entryOf = async () => {
      const response = await call(fx.app, { url: '/admin/events/dlq', as: fx.admin })
      expect(response.statusCode, response.body).toBe(200)
      return (
        response.json().items as Array<{
          id: string
          subscriber: string
          attempts: number | null
          error: string
          event: { object: { id: string } | null }
        }>
      ).find((item) => item.event.object?.id === folderId)
    }
    await waitFor(async () => Boolean(await entryOf()))
    await waitFor(() => handled.length === 1)
    const entry = await entryOf()
    expect(entry).toMatchObject({
      subscriber: failing,
      attempts: 1,
      error: 'сбой для очереди сбоев',
    })

    // Очередь сбоев видна в «Здоровье системы»; посторонним — нет
    const health = await call(fx.app, { url: '/admin/health', as: fx.admin })
    expect(health.json().events.dlq).toBeGreaterThanOrEqual(1)
    const denied = await call(fx.app, { url: '/admin/events/dlq', as: fx.users.member })
    expect(denied.statusCode).toBe(403)

    // Отметки другого подписчика очищены по сроку — повтор всё равно не для него
    await db().execute(sql`DELETE FROM ops.event_consumptions WHERE consumer = ${other}`)
    broken = false
    const retried = await call(fx.app, {
      method: 'POST',
      url: `/admin/events/dlq/${entry?.id}/retry`,
      as: fx.admin,
    })
    expect(retried.statusCode, retried.body).toBe(200)
    await waitFor(() => failed.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(handled).toHaveLength(1)
    expect(await entryOf()).toBeUndefined()

    const audit = await db().execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM audit_log
           WHERE action = 'events.dlq_retried' AND details->>'entry' = ${entry?.id ?? ''}`,
    )
    expect(audit[0]?.count).toBe(1)

    // Запись повторена и удалена — второй повтор её не найдёт
    const again = await call(fx.app, {
      method: 'POST',
      url: `/admin/events/dlq/${entry?.id}/retry`,
      as: fx.admin,
    })
    expect(again.statusCode).toBe(404)
  })

  it('отметки обработки старше срока удаляются, свежие остаются', async () => {
    await db().execute(sql`
      INSERT INTO ops.event_consumptions (consumer, event_id, created_at)
      VALUES ('test-prune', ${`old-${run}`}, now() - interval '30 days'),
             ('test-prune', ${`new-${run}`}, now())`)
    expect(await pruneEventConsumptions(14, 1)).toBeGreaterThanOrEqual(1)
    const rows = await db().execute<{ event_id: string }>(
      sql`SELECT event_id FROM ops.event_consumptions WHERE consumer = 'test-prune'`,
    )
    expect(rows.map((row) => row.event_id)).toEqual([`new-${run}`])
  })
})

/** Сравнение идентификаторов записей потока `мс-номер`. */
function compare(a: string, b: string): number {
  const [aMs, aSeq] = a.split('-').map(Number)
  const [bMs, bSeq] = b.split('-').map(Number)
  return (aMs ?? 0) === (bMs ?? 0) ? (aSeq ?? 0) - (bSeq ?? 0) : (aMs ?? 0) - (bMs ?? 0)
}
