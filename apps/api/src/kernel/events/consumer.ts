import { performance } from 'node:perf_hooks'
import { EVENT_DOMAINS, type EventEnvelope } from '@kchs/contracts'
import { type Histogram, SpanKind, trace } from '@opentelemetry/api'
import { and, eq, inArray } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import { db } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { createRedisConnection } from '~/shared/redis/index.js'
import { meter } from '~/shared/telemetry/metrics.js'
import { recordError, withSpan } from '~/shared/telemetry/tracing.js'
import {
  listSubscribers,
  matchesType,
  ONLY_FIELD,
  sendToDlq,
  streamKey,
  subscriberStreams,
} from './bus.js'
import { withEventDelivery } from './delivery.js'
import { eventConsumptions } from './schema.js'
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
/** Группы всех подписчиков созданы: потребители начинают читать после этого. */
let prepared: Promise<void> | null = null

/**
 * Ключ Redis: группы потребителей этой установки уже создавались (ADR-0171).
 * Живёт рядом с потоками: потеря данных Redis сбрасывает его вместе с ними.
 */
export const GROUPS_INITIALIZED_KEY = 'events:groups:initialized'

/**
 * Создаёт consumer group каждого подписчика на потоках его доменов (идемпотентно).
 * Откуда новая группа начинает читать (ADR-0171):
 * - первый запуск установки — с начала потока: события сида и всего, что
 *   опубликовано до старта потребителей, не теряются;
 * - подписчик (или новый домен подписчика), появившийся в обновлении работающей
 *   установки, — с новых событий, иначе он прошёл бы всю сохранённую историю;
 * - проекции с `replay` — всегда с начала.
 * Группы подписчика на остальных потоках (до ADR-0220 группа была на каждом потоке)
 * удаляются: их события подписчик подтверждал не глядя, а такая группа держала бы
 * обрезку потока и копила отставание.
 */
async function prepareGroups(client: Redis, subscribers: readonly Subscriber[]): Promise<void> {
  const initialized = (await client.exists(GROUPS_INITIALIZED_KEY)) === 1
  for (const subscriber of subscribers) {
    const start = !initialized || subscriber.replay ? '0' : '$'
    const streams = new Set(subscriberStreams(subscriber))
    const pipeline = client.pipeline()
    for (const stream of streams) {
      pipeline.xgroup('CREATE', stream, subscriber.name, start, 'MKSTREAM')
    }
    for (const [error] of (await pipeline.exec()) ?? []) {
      if (error && !error.message.includes('BUSYGROUP')) throw error
    }
    const stale = client.pipeline()
    for (const domain of EVENT_DOMAINS) {
      if (!streams.has(streamKey(domain)))
        stale.xgroup('DESTROY', streamKey(domain), subscriber.name)
    }
    // Потока может не быть — удалять нечего, ошибка не важна
    await stale.exec()
  }
  await client.set(GROUPS_INITIALIZED_KEY, new Date().toISOString())
}

/** Группы готовы: один проход на процесс, после сбоя — заново со следующей попытки. */
function ensurePrepared(subscribers: readonly Subscriber[]): Promise<void> {
  if (!prepared) {
    const client = createRedisConnection('events-groups')
    prepared = prepareGroups(client, subscribers)
      .catch((error: unknown) => {
        prepared = null
        throw error
      })
      .finally(() => client.disconnect())
  }
  return prepared
}

/**
 * Идемпотентность: доставка — «как минимум один раз», повтор после сбоя
 * отсекает отметка обработки (ADR-0027). Отметки пачки читаются одним запросом
 * (ADR-0220); отметка ставится после обработки — падение между ними даёт повтор,
 * а не потерю события.
 */
async function processedAmong(consumer: string, eventIds: string[]): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set()
  const rows = await db()
    .select({ eventId: eventConsumptions.eventId })
    .from(eventConsumptions)
    .where(
      and(eq(eventConsumptions.consumer, consumer), inArray(eventConsumptions.eventId, eventIds)),
    )
  return new Set(rows.map((row) => row.eventId))
}

async function markProcessed(consumer: string, eventId: string): Promise<void> {
  await db().insert(eventConsumptions).values({ consumer, eventId }).onConflictDoNothing()
}

/**
 * Отметки, прочитанные дольше этого назад, перечитываются перед следующим событием пачки:
 * долгую пачку могла частично забрать (XAUTOCLAIM) и обработать другая реплика.
 */
const PROCESSED_RECHECK_MS = 2000

/** Обработанные события пачки: отметки из базы и всё, что прошло в этой пачке. */
class ProcessedSet {
  private readonly done = new Set<string>()
  private checkedAt = 0

  constructor(
    private readonly consumer: string,
    private readonly eventIds: string[],
  ) {}

  async has(eventId: string): Promise<boolean> {
    if (Date.now() - this.checkedAt > PROCESSED_RECHECK_MS) {
      const rest = this.eventIds.filter((id) => !this.done.has(id))
      for (const id of await processedAmong(this.consumer, rest)) this.done.add(id)
      this.checkedAt = Date.now()
    }
    return this.done.has(eventId)
  }

  add(eventId: string): void {
    this.done.add(eventId)
  }
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

/**
 * Пачка записей одного потока: служебные и чужие записи подтверждаются одной командой,
 * отметки обработки событий пачки читаются одним запросом (ADR-0220).
 */
async function handleEntries(
  subscriber: Subscriber,
  client: Redis,
  stream: string,
  entries: Array<[string, string[]]>,
): Promise<void> {
  const skipped: string[] = []
  const events: Array<[string, EventEnvelope]> = []
  for (const [entryId, fields] of entries) {
    const event = readEntry(subscriber, stream, entryId, fields)
    if (event) events.push([entryId, event])
    else skipped.push(entryId)
  }
  if (skipped.length > 0) await client.xack(stream, subscriber.name, ...skipped)
  const processed = new ProcessedSet(
    subscriber.name,
    events.map(([, event]) => event.id),
  )
  for (const [entryId, event] of events) {
    await handleEvent(subscriber, client, stream, entryId, event, processed)
  }
}

/** Событие записи для подписчика; `null` — запись подтверждается без обработки. */
function readEntry(
  subscriber: Subscriber,
  stream: string,
  entryId: string,
  fields: string[],
): EventEnvelope | null {
  const raw = fieldValue(fields, 'event')
  if (!raw) return null
  // Повтор из DLQ адресован одному подписчику: остальные его не обрабатывают
  const only = fieldValue(fields, ONLY_FIELD)
  if (only && only !== subscriber.name) return null

  let event: EventEnvelope
  try {
    event = JSON.parse(raw) as EventEnvelope
  } catch (error) {
    logger().error({ err: error, stream, entryId }, 'нечитаемое событие в потоке')
    return null
  }
  return matchesType(subscriber.types, event.type) ? event : null
}

async function handleEvent(
  subscriber: Subscriber,
  client: Redis,
  stream: string,
  entryId: string,
  event: EventEnvelope,
  processed: ProcessedSet,
): Promise<void> {
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
      const outcome = await processEntry(subscriber, client, stream, entryId, event, processed)
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
  processed: ProcessedSet,
): Promise<'duplicate' | 'processed' | 'retry' | 'dlq'> {
  if (await processed.has(event.id)) {
    await client.xack(stream, subscriber.name, entryId)
    return 'duplicate'
  }

  try {
    // Сначала обработка, затем отметка: падение между ними приводит к повтору,
    // а не к потере события. Подписчики идемпотентны (02-platform-kernel.md §4);
    // неповторяемые побочные эффекты узнают повтор по контексту доставки
    await withEventDelivery({ subscriber: subscriber.name, eventId: event.id }, () =>
      subscriber.handle(event),
    )
    await markProcessed(subscriber.name, event.id)
    processed.add(event.id)
    await client.xack(stream, subscriber.name, entryId)
    return 'processed'
  } catch (error) {
    recordError(trace.getActiveSpan(), error)
    const deliveries = await deliveryCount(client, stream, subscriber.name, entryId)
    const max = subscriber.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    if (deliveries >= max) {
      await sendToDlq(event, subscriber.name, error, deliveries)
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
    const claimed = entries.filter((entry): entry is [string, string[]] => entry !== null)
    await handleEntries(subscriber, client, stream, claimed)
    handled += claimed.length
    cursor = next
  } while (cursor !== '0-0' && !stopped)
  return handled
}

/**
 * Запускает потребление событий всеми зарегистрированными подписчиками.
 * Промис — группы созданы (тест, опубликовавший событие сразу после запуска,
 * ждёт его, иначе новая группа с `$` его не увидела бы); сбой создания групп
 * повторяют сами потребители.
 */
export function startConsumers(overrides: Partial<ConsumerOptions> = {}): Promise<void> {
  const subscribers = listSubscribers()
  if (subscribers.length === 0) {
    logger().warn('подписчики событий не зарегистрированы')
    return Promise.resolve()
  }

  const options = { ...DEFAULT_OPTIONS, ...overrides }
  stopped = false
  prepared = null
  eventDuration = meter().createHistogram('kchs.event.duration', {
    unit: 's',
    description: 'Обработка события подписчиком',
  })
  const log = logger().child({ module: 'events' })
  const ready = ensurePrepared(subscribers)

  for (const subscriber of subscribers) {
    const task = runSubscriber(subscriber, subscribers, options, log)
    running.add(task)
    void task.finally(() => running.delete(task))
  }
  log.info({ subscribers: subscribers.map((s) => s.name) }, 'потребители событий запущены')
  return ready.catch((error: unknown) => {
    log.error({ err: error }, 'группы потребителей не созданы — повтор при чтении')
  })
}

async function runSubscriber(
  subscriber: Subscriber,
  subscribers: readonly Subscriber[],
  options: ConsumerOptions,
  log: ReturnType<typeof logger>,
): Promise<void> {
  const client = createRedisConnection(`sub-${subscriber.name}`)
  const streams = subscriberStreams(subscriber)
  let groupsReady = false
  let lastClaim = 0

  while (!stopped) {
    try {
      if (!groupsReady) {
        await ensurePrepared(subscribers)
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
        await handleEntries(subscriber, client, stream, entries)
      }
    } catch (error) {
      if (stopped) break
      // Группы нет (поток удалён, группу сняла другая версия) — создать заново
      if (error instanceof Error && error.message.startsWith('NOGROUP')) {
        groupsReady = false
        prepared = null
      }
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
  prepared = null
}

/** Значение поля записи потока (`[имя, значение, …]`). */
function fieldValue(fields: string[], name: string): string | undefined {
  for (let index = 0; index < fields.length - 1; index += 2) {
    if (fields[index] === name) return fields[index + 1]
  }
  return undefined
}
