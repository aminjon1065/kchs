import { performance } from 'node:perf_hooks'
import type { EventEnvelope } from '@kchs/contracts'
import { type Histogram, SpanKind, trace } from '@opentelemetry/api'
import { and, eq } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { db } from '~/shared/db/client.js'
import { eventConsumptions } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { createRedisConnection } from '~/shared/redis/index.js'
import { meter } from '~/shared/telemetry/metrics.js'
import { recordError, withSpan } from '~/shared/telemetry/tracing.js'
import { listSubscribers, matchesType, sendToDlq, streamKey, subscribedDomains } from './bus.js'
import type { Subscriber } from './types.js'

const READ_COUNT = 50
const DEFAULT_MAX_ATTEMPTS = 5

export interface ConsumerOptions {
  /** Сколько ждать новых событий в одном чтении. */
  blockMs: number
  /**
   * Через сколько простоя неподтверждённое событие считается брошенным
   * (подписчик упал или процесс умер) и доставляется повторно.
   */
  retryIdleMs: number
  /** Как часто искать брошенные события. */
  claimIntervalMs: number
}

const DEFAULT_OPTIONS: ConsumerOptions = {
  blockMs: 2000,
  retryIdleMs: 15_000,
  claimIntervalMs: 5000,
}

/** Имя потребителя уникально для процесса: чужие брошенные записи забираются XAUTOCLAIM. */
const CONSUMER_NAME = `c-${process.pid}-${Math.random().toString(36).slice(2, 7)}`

let stopped = false
const running = new Set<Promise<void>>()
/** Длительность и исход обработки события подписчиком (создаётся при запуске). */
let eventDuration: Histogram | null = null

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

/** Сколько раз запись уже доставлялась этой группе (включая текущую доставку). */
async function deliveryCount(
  client: Redis,
  stream: string,
  group: string,
  entryId: string,
): Promise<number> {
  const rows = (await client.xpending(stream, group, entryId, entryId, 1)) as Array<
    [string, string, number, number]
  >
  const row = rows[0]
  return row ? Number(row[3]) : 1
}

async function handleEntry(
  subscriber: Subscriber,
  client: Redis,
  stream: string,
  entryId: string,
  fields: string[],
): Promise<void> {
  const idx = fields.indexOf('event')
  const raw = idx >= 0 ? fields[idx + 1] : undefined
  if (!raw) {
    await client.xack(stream, subscriber.name, entryId)
    return
  }

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

  // Контекст трассы через outbox не передаётся (конверт — контракт): обработка
  // события — своя трасса, а с запросом её связывает correlationId = requestId
  await withSpan(
    `event ${event.type} ${subscriber.name}`,
    {
      kind: SpanKind.CONSUMER,
      attributes: {
        'messaging.system': 'redis',
        'messaging.operation.type': 'process',
        'messaging.destination.name': stream,
        'messaging.consumer.group.name': subscriber.name,
        'messaging.message.id': event.id,
        'kchs.event.type': event.type,
        'kchs.correlation_id': event.correlationId ?? '',
      },
    },
    async (span) => {
      const started = performance.now()
      const outcome = await processEntry(subscriber, client, stream, entryId, event)
      span?.setAttribute('kchs.event.outcome', outcome)
      eventDuration?.record((performance.now() - started) / 1000, {
        subscriber: subscriber.name,
        outcome,
      })
    },
  )
}

async function processEntry(
  subscriber: Subscriber,
  client: Redis,
  stream: string,
  entryId: string,
  event: EventEnvelope,
): Promise<'duplicate' | 'processed' | 'retry' | 'dlq'> {
  if (await alreadyProcessed(subscriber.name, event.id)) {
    await client.xack(stream, subscriber.name, entryId)
    return 'duplicate'
  }

  try {
    // Сначала обработка, затем отметка: падение между ними приводит к повтору,
    // а не к потере события. Подписчики идемпотентны (02-platform-kernel.md §4).
    await subscriber.handle(event)
    await markProcessed(subscriber.name, event.id)
    await client.xack(stream, subscriber.name, entryId)
    return 'processed'
  } catch (error) {
    recordError(trace.getActiveSpan(), error)
    const deliveries = await deliveryCount(client, stream, subscriber.name, entryId)
    const max = subscriber.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    if (deliveries >= max) {
      await sendToDlq(event, subscriber.name, error)
      await client.xack(stream, subscriber.name, entryId)
      return 'dlq'
    }
    // Запись остаётся неподтверждённой и будет забрана повторно после простоя
    logger().warn(
      { err: error, consumer: subscriber.name, eventId: event.id, deliveries },
      'подписчик вернул ошибку, будет повтор',
    )
    return 'retry'
  }
}

/**
 * Повторная доставка: записи, которые дольше `retryIdleMs` висят неподтверждёнными
 * (сбой подписчика, падение процесса), переходят этому потребителю.
 * XAUTOCLAIM увеличивает счётчик доставок — после `maxAttempts` событие уходит в DLQ.
 */
async function reclaimStale(
  subscriber: Subscriber,
  client: Redis,
  stream: string,
  options: ConsumerOptions,
): Promise<number> {
  let cursor = '0-0'
  let handled = 0
  do {
    const reply = (await client.xautoclaim(
      stream,
      subscriber.name,
      CONSUMER_NAME,
      options.retryIdleMs,
      cursor,
      'COUNT',
      READ_COUNT,
    )) as [string, Array<[string, string[]] | null>, string[]?]
    const [next, entries] = reply
    for (const entry of entries) {
      if (!entry) continue
      const [entryId, fields] = entry
      await handleEntry(subscriber, client, stream, entryId, fields)
      handled += 1
    }
    cursor = next
  } while (cursor !== '0-0' && !stopped)
  return handled
}

/** Запускает потребление событий всеми зарегистрированными подписчиками. */
export function startConsumers(overrides: Partial<ConsumerOptions> = {}): void {
  const subscribers = listSubscribers()
  if (subscribers.length === 0) {
    logger().warn('подписчики событий не зарегистрированы')
    return
  }

  const options = { ...DEFAULT_OPTIONS, ...overrides }
  stopped = false
  eventDuration = meter().createHistogram('kchs.event.duration', {
    unit: 's',
    description: 'Обработка события подписчиком',
  })
  const log = logger().child({ module: 'events' })
  const domains = resolveDomains()

  for (const subscriber of subscribers) {
    const task = runSubscriber(subscriber, domains, options, log)
    running.add(task)
    void task.finally(() => running.delete(task))
  }
  log.info({ subscribers: subscribers.map((s) => s.name), domains }, 'потребители событий запущены')
}

/** Домены, на потоки которых подписываются подписчики со звёздочкой. */
export const KNOWN_DOMAINS = [
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
  'dataset',
  'chart',
  'dashboard',
  'metric',
] as const

function resolveDomains(): string[] {
  const domains = subscribedDomains()
  return domains.includes('*') ? [...KNOWN_DOMAINS] : domains
}

async function runSubscriber(
  subscriber: Subscriber,
  domains: string[],
  options: ConsumerOptions,
  log: ReturnType<typeof logger>,
): Promise<void> {
  const client = createRedisConnection(`sub-${subscriber.name}`)
  const streams = domains.map(streamKey)
  let groupsReady = false
  let lastClaim = 0

  while (!stopped) {
    try {
      if (!groupsReady) {
        await ensureGroups(client, subscriber, domains)
        groupsReady = true
      }

      if (Date.now() - lastClaim >= options.claimIntervalMs) {
        lastClaim = Date.now()
        for (const stream of streams) await reclaimStale(subscriber, client, stream, options)
      }

      const response = (await client.xreadgroup(
        'GROUP',
        subscriber.name,
        CONSUMER_NAME,
        'COUNT',
        READ_COUNT,
        'BLOCK',
        options.blockMs,
        'STREAMS',
        ...streams,
        ...streams.map(() => '>'),
      )) as Array<[string, Array<[string, string[]]>]> | null

      if (!response) continue

      for (const [stream, entries] of response) {
        for (const [entryId, fields] of entries) {
          await handleEntry(subscriber, client, stream, entryId, fields)
        }
      }
    } catch (error) {
      if (stopped) break
      log.error({ err: error, consumer: subscriber.name }, 'сбой потребителя событий')
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  client.disconnect()
}

/** Останавливает потребителей и дожидается завершения текущих обработчиков. */
export async function stopConsumers(): Promise<void> {
  stopped = true
  await Promise.allSettled([...running])
}
