import type { EventEnvelope } from '@kchs/contracts'
import { and, eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { db } from '~/shared/db/client.js'
import { eventConsumptions } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { createRedisConnection } from '~/shared/redis/index.js'
import { listSubscribers, matchesType, sendToDlq, streamKey, subscribedDomains } from './bus.js'
import type { Subscriber } from './types.js'

const READ_COUNT = 50
const BLOCK_MS = 2000
const DEFAULT_MAX_ATTEMPTS = 5
const CONSUMER_NAME = `c-${process.pid}-${Math.random().toString(36).slice(2, 7)}`

let connection: Redis | null = null
let stopped = false

/** Создаёт consumer group для каждого домена (идемпотентно). */
async function ensureGroups(
  client: Redis,
  subscriber: Subscriber,
  domains: string[],
): Promise<void> {
  for (const domain of domains) {
    try {
      await client.xgroup('CREATE', streamKey(domain), subscriber.name, '0', 'MKSTREAM')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('BUSYGROUP')) throw error
    }
  }
}

/** Идемпотентность: событие обрабатывается подписчиком ровно один раз. */
async function alreadyProcessed(consumer: string, eventId: string): Promise<boolean> {
  const rows = await db()
    .select({ eventId: eventConsumptions.eventId })
    .from(eventConsumptions)
    .where(and(eq(eventConsumptions.consumer, consumer), eq(eventConsumptions.eventId, eventId)))
    .limit(1)
  return rows.length > 0
}

async function markProcessed(consumer: string, eventId: string): Promise<void> {
  await db().insert(eventConsumptions).values({ consumer, eventId }).onConflictDoNothing()
}

async function handleEntry(
  subscriber: Subscriber,
  client: Redis,
  stream: string,
  entryId: string,
  raw: string,
): Promise<void> {
  let event: EventEnvelope
  try {
    event = JSON.parse(raw) as EventEnvelope
  } catch (error) {
    logger().error({ err: error, stream, entryId }, 'нечитаемое событие в потоке')
    await client.xack(stream, subscriber.name, entryId)
    return
  }

  if (!matchesType(subscriber.types, event.type)) {
    await client.xack(stream, subscriber.name, entryId)
    return
  }

  if (await alreadyProcessed(subscriber.name, event.id)) {
    await client.xack(stream, subscriber.name, entryId)
    return
  }

  try {
    // Сначала обработка, затем отметка: падение между ними приводит к повтору,
    // а не к потере события. Подписчики идемпотентны (02-platform-kernel.md §4).
    await subscriber.handle(event)
    await markProcessed(subscriber.name, event.id)
    await client.xack(stream, subscriber.name, entryId)
  } catch (error) {
    const attempts = await client.xpending(stream, subscriber.name, '-', '+', 1, CONSUMER_NAME)
    const deliveries =
      Array.isArray(attempts) && attempts.length > 0 ? Number((attempts[0] as unknown[])[3]) : 1
    const max = subscriber.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    if (deliveries >= max) {
      await sendToDlq(event, subscriber.name, error)
      await client.xack(stream, subscriber.name, entryId)
    } else {
      logger().warn(
        { err: error, consumer: subscriber.name, eventId: event.id, deliveries },
        'подписчик вернул ошибку, будет повтор',
      )
    }
  }
}

/** Запускает потребление событий всеми зарегистрированными подписчиками. */
export function startConsumers(): void {
  const subscribers = listSubscribers()
  if (subscribers.length === 0) {
    logger().warn('подписчики событий не зарегистрированы')
    return
  }

  stopped = false
  connection = createRedisConnection('events')
  const log = logger().child({ module: 'events' })
  const domains = resolveDomains()

  for (const subscriber of subscribers) {
    void runSubscriber(subscriber, domains, log)
  }
  log.info({ subscribers: subscribers.map((s) => s.name), domains }, 'потребители событий запущены')
}

function resolveDomains(): string[] {
  const domains = subscribedDomains()
  if (domains.includes('*')) {
    return [
      'object',
      'user',
      'org',
      'delegation',
      'session',
      'space',
      'message',
      'mention',
      'file',
      'notification',
      'inbox',
      'job',
      'settings',
      'acl',
      'role',
      'announcement',
    ]
  }
  return domains
}

async function runSubscriber(
  subscriber: Subscriber,
  domains: string[],
  log: ReturnType<typeof logger>,
): Promise<void> {
  const client = createRedisConnection(`sub-${subscriber.name}`)
  await ensureGroups(client, subscriber, domains)

  const streams = domains.map(streamKey)
  while (!stopped) {
    try {
      const response = (await client.xreadgroup(
        'GROUP',
        subscriber.name,
        CONSUMER_NAME,
        'COUNT',
        READ_COUNT,
        'BLOCK',
        BLOCK_MS,
        'STREAMS',
        ...streams,
        ...streams.map(() => '>'),
      )) as Array<[string, Array<[string, string[]]>]> | null

      if (!response) continue

      for (const [stream, entries] of response) {
        for (const [entryId, fields] of entries) {
          const idx = fields.indexOf('event')
          const raw = idx >= 0 ? fields[idx + 1] : undefined
          if (!raw) {
            await client.xack(stream, subscriber.name, entryId)
            continue
          }
          await handleEntry(subscriber, client, stream, entryId, raw)
        }
      }
    } catch (error) {
      if (stopped) break
      log.error({ err: error, consumer: subscriber.name }, 'сбой потребителя событий')
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  await client.quit().catch(() => undefined)
}

export function stopConsumers(): void {
  stopped = true
  void connection?.quit().catch(() => undefined)
  connection = null
}
