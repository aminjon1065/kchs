import type { EventEnvelope } from '@kchs/contracts'
import type { Redis } from 'ioredis'
import { logger } from '~/shared/logger/index.js'
import { redis } from '~/shared/redis/index.js'
import type { Subscriber } from './types.js'

/** Потоки Redis: `events:<domain>`; DLQ — `events:dlq`. */
export const streamKey = (domain: string) => `events:${domain}`
export const DLQ_STREAM = 'events:dlq'
export const MAX_STREAM_LEN = 100_000

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

export async function xaddEvent(client: Redis, event: EventEnvelope): Promise<void> {
  const domain = event.type.split('.')[0] ?? 'unknown'
  await client.xadd(
    streamKey(domain),
    'MAXLEN',
    '~',
    String(MAX_STREAM_LEN),
    '*',
    'event',
    JSON.stringify(event),
  )
}

export async function sendToDlq(
  event: EventEnvelope,
  consumer: string,
  error: unknown,
): Promise<void> {
  await redis().xadd(
    DLQ_STREAM,
    'MAXLEN',
    '~',
    '10000',
    '*',
    'event',
    JSON.stringify(event),
    'consumer',
    consumer,
    'error',
    error instanceof Error ? error.message : String(error),
  )
  logger().error({ eventId: event.id, consumer, err: error }, 'событие отправлено в DLQ')
}
