import type { EventEnvelope } from '@kchs/contracts'
import type { Redis } from 'ioredis'
import { logger } from '~/shared/logger/index.js'
import { redis } from '~/shared/redis/index.js'
import type { Subscriber } from './types.js'

/** Потоки Redis: `events:<domain>`; DLQ — `events:dlq`. */
export const streamKey = (domain: string) => `events:${domain}`
export const DLQ_STREAM = 'events:dlq'
/**
 * Жёсткий предел длины потока — страховка памяти Redis, а не обрезка: поток
 * обрезает задание `events.trim` по самой отстающей группе (ADR-0171). Сюда
 * поток упирается, только если подписчик стоит долго, — это видно метрикой
 * `kchs_events_stream_length` и оповещением задолго до предела.
 */
export const STREAM_HARD_CAP = 1_000_000
/** Записи DLQ хранятся до повтора администратором; предел — та же страховка. */
const DLQ_HARD_CAP = 100_000
/**
 * Поле записи потока: событие только для этого подписчика. Им повтор из DLQ
 * доставляет событие тому, у кого оно упало, — остальные группы его
 * подтверждают не глядя, даже если их отметки обработки уже очищены.
 */
export const ONLY_FIELD = 'only'

const subscribers: Subscriber[] = []

export function registerSubscriber(subscriber: Subscriber): void {
  if (subscribers.some((s) => s.name === subscriber.name)) {
    throw new Error(`Подписчик ${subscriber.name} уже зарегистрирован`)
  }
  subscribers.push(subscriber)
}

export function listSubscribers(): readonly Subscriber[] {
  return subscribers
}

export function clearSubscribers(): void {
  subscribers.length = 0
}

export function matchesType(patterns: string[], type: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === '*') return true
    if (pattern.endsWith('*')) return type.startsWith(pattern.slice(0, -1))
    return pattern === type
  })
}

/** Домены, на которые подписан хотя бы один подписчик. */
export function subscribedDomains(): string[] {
  const domains = new Set<string>()
  for (const sub of subscribers) {
    for (const pattern of sub.types) {
      if (pattern === '*') return ['*']
      const domain = pattern.split('.')[0] ?? ''
      if (domain.endsWith('*')) return ['*']
      domains.add(domain)
    }
  }
  return [...domains]
}

/** Домен события — поток, в который оно публикуется. */
export const eventDomain = (event: Pick<EventEnvelope, 'type'>) =>
  event.type.split('.')[0] ?? 'unknown'

export async function xaddEvent(
  client: Redis,
  event: EventEnvelope,
  options: { only?: string } = {},
): Promise<void> {
  await client.xadd(
    streamKey(eventDomain(event)),
    'MAXLEN',
    '~',
    String(STREAM_HARD_CAP),
    '*',
    'event',
    JSON.stringify(event),
    ...(options.only ? [ONLY_FIELD, options.only] : []),
  )
}

export async function sendToDlq(
  event: EventEnvelope,
  consumer: string,
  error: unknown,
  attempts: number,
): Promise<void> {
  await redis().xadd(
    DLQ_STREAM,
    'MAXLEN',
    '~',
    String(DLQ_HARD_CAP),
    '*',
    'event',
    JSON.stringify(event),
    'consumer',
    consumer,
    'error',
    error instanceof Error ? error.message : String(error),
    'attempts',
    String(attempts),
  )
  logger().error({ eventId: event.id, consumer, err: error }, 'событие отправлено в DLQ')
}
