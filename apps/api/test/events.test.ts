import type { EventEnvelope } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Subscriber } from '../src/kernel/events/types.js'
import { call, db, redis, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Шина событий на настоящем Redis (P0-E07 S01): событие не теряется при сбое
 * подписчика и при гибели процесса, после исчерпания попыток уходит в DLQ.
 */
registerLifecycle()

const bus = await import('../src/kernel/events/index.js')

let fx: TestContext
let kernelSubscribers: Subscriber[] = []

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

async function processedBy(consumer: string, eventId: string): Promise<boolean> {
  const rows = await db().execute(
    sql`SELECT 1 FROM ops.event_consumptions WHERE consumer = ${consumer} AND event_id = ${eventId}`,
  )
  return rows.length > 0
}

describe('шина событий', () => {
  it('сбой подписчика не теряет событие: оно доставляется повторно и отмечается один раз', async () => {
    const name = `test-retry-${Date.now()}`
    const deliveries: string[] = []
    bus.clearSubscribers()
    bus.registerSubscriber({
      name,
      types: ['object.created'],
      handle: async (event) => {
        if (event.object?.title !== 'Повтор доставки') return
        deliveries.push(event.id)
        if (deliveries.length === 1) throw new Error('сбой подписчика')
      },
    })
    bus.startConsumers(FAST)

    await createFolder('Повтор доставки')
    await dispatchAll()

    await waitFor(() => deliveries.length >= 2)
    expect(new Set(deliveries).size).toBe(1)
    await waitFor(() => processedBy(name, deliveries[0] ?? ''))
  })

  it('событие, брошенное упавшим процессом, забирает живой потребитель', async () => {
    const name = `test-orphan-${Date.now()}`
    await createFolder('Брошенное событие')
    await dispatchAll()

    // «Процесс» прочитал записи и умер, не подтвердив их
    await redis().xgroup('CREATE', 'events:object', name, '0', 'MKSTREAM')
    const read = await redis().xreadgroup(
      'GROUP',
      name,
      'dead-consumer',
      'COUNT',
      10_000,
      'STREAMS',
      'events:object',
      '>',
    )
    expect(read).not.toBeNull()

    const handled: EventEnvelope[] = []
    bus.clearSubscribers()
    bus.registerSubscriber({
      name,
      types: ['object.created'],
      handle: async (event) => {
        if (event.object?.title === 'Брошенное событие') handled.push(event)
      },
    })
    bus.startConsumers(FAST)

    await waitFor(() => handled.length === 1)
    const pending = (await redis().xpending('events:object', name)) as [number, ...unknown[]]
    await waitFor(async () => {
      const summary = (await redis().xpending('events:object', name)) as [number, ...unknown[]]
      return summary[0] === 0
    })
    expect(pending).toBeDefined()
  })

  it('после исчерпания попыток событие уходит в DLQ и больше не повторяется', async () => {
    const name = `test-dlq-${Date.now()}`
    let attempts = 0
    bus.clearSubscribers()
    bus.registerSubscriber({
      name,
      types: ['object.created'],
      maxAttempts: 2,
      handle: async (event) => {
        if (event.object?.title !== 'Всегда с ошибкой') return
        attempts += 1
        throw new Error('подписчик всегда падает')
      },
    })
    bus.startConsumers(FAST)

    const folderId = await createFolder('Всегда с ошибкой')
    await dispatchAll()

    const inDlq = async () => {
      const entries = await redis().xrange(bus.DLQ_STREAM, '-', '+')
      return entries.some(([, fields]) => {
        const event = JSON.parse(fields[fields.indexOf('event') + 1] ?? '{}') as EventEnvelope
        return event.object?.id === folderId && fields.includes(name)
      })
    }
    await waitFor(inDlq)
    expect(attempts).toBe(2)

    // Подтверждённое событие не возвращается
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(attempts).toBe(2)
  })

  it('событие вне каталога или с неверной полезной нагрузкой не публикуется', async () => {
    const { publishEvent } = await import('../src/kernel/events/publisher.js')
    const { systemCtx } = await import('../src/shared/context.js')
    const ctx = systemCtx('test')

    await expect(
      db().transaction((tx) => publishEvent(tx, ctx, { type: 'object.exploded', payload: {} })),
    ).rejects.toThrow('не описано в каталоге')

    await expect(
      db().transaction((tx) =>
        publishEvent(tx, ctx, { type: 'object.created', payload: { type: 42 } }),
      ),
    ).rejects.toThrow('не соответствует схеме')
  })
})
