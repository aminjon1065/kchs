import type { EventEnvelope } from '@kchs/contracts'
import type { Redis } from 'ioredis'
import { config } from '~/shared/config/index.js'
import { rawSql } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { redis } from '~/shared/redis/index.js'
import { DLQ_STREAM, eventDomain, listSubscribers, streamKey, xaddEvent } from './bus.js'

/**
 * Обслуживание шины событий (ADR-0171): обрезка потоков по самой отстающей
 * группе, очистка отметок обработки, состояние групп для метрик и «Здоровья
 * системы», очередь сбоев (DLQ) с повтором.
 */

interface GroupInfo {
  name: string
  pending: number
  lastDeliveredId: string
  /** Сколько записей потока группа ещё не получила; `null` — Redis не может сказать. */
  lag: number | null
}

/** Потоки событий установки, кроме DLQ: все, что есть в Redis, а не только известные. */
export async function eventStreams(client: Redis = redis()): Promise<string[]> {
  const found = new Set<string>()
  let cursor = '0'
  do {
    const [next, keys] = await client.scan(
      cursor,
      'MATCH',
      'events:*',
      'COUNT',
      500,
      'TYPE',
      'stream',
    )
    for (const key of keys) if (key !== DLQ_STREAM) found.add(key)
    cursor = next
  } while (cursor !== '0')
  return [...found].sort()
}

/** Группы потока; поток без групп или отсутствующий — пустой список. */
async function groupsOf(client: Redis, stream: string): Promise<GroupInfo[]> {
  let reply: unknown[]
  try {
    reply = (await client.xinfo('GROUPS', stream)) as unknown[]
  } catch {
    return []
  }
  return reply.map((raw) => {
    const fields = raw as Array<string | number | null>
    const value = (name: string) => fields[fields.indexOf(name) + 1]
    const lag = value('lag')
    return {
      name: String(value('name')),
      pending: Number(value('pending') ?? 0),
      lastDeliveredId: String(value('last-delivered-id') ?? '0-0'),
      lag: lag === null || lag === undefined ? null : Number(lag),
    }
  })
}

/** Наименьший идентификатор неподтверждённой записи группы. */
async function oldestPendingId(
  client: Redis,
  stream: string,
  group: string,
): Promise<string | null> {
  const summary = (await client.xpending(stream, group)) as [number, string | null, ...unknown[]]
  return summary[0] > 0 ? (summary[1] ?? null) : null
}

/** Идентификаторы записей потока `мс-номер`: сравнение и следующий за данным. */
function parseId(id: string): [number, number] {
  const [ms, seq] = id.split('-')
  return [Number(ms ?? 0), Number(seq ?? 0)]
}

function compareIds(a: string, b: string): number {
  const [aMs, aSeq] = parseId(a)
  const [bMs, bSeq] = parseId(b)
  return aMs === bMs ? aSeq - bSeq : aMs - bMs
}

function nextId(id: string): string {
  const [ms, seq] = parseId(id)
  return `${ms}-${seq + 1}`
}

/** Время записи по её идентификатору (первая часть — миллисекунды). */
const idTime = (id: string) => parseId(id)[0]

/**
 * Граница, ниже которой записи потока не нужны ни одной группе подписчиков:
 * неподтверждённые хранятся (их заберут повторно), непрочитанные — тоже.
 * Группы без зарегистрированного подписчика (переименованные, тестовые) не
 * держат поток: читать их некому.
 */
async function groupsFloor(client: Redis, stream: string): Promise<string | null> {
  const registered = new Set(listSubscribers().map((subscriber) => subscriber.name))
  let floor: string | null = null
  for (const group of await groupsOf(client, stream)) {
    if (!registered.has(group.name)) continue
    const pending = group.pending > 0 ? await oldestPendingId(client, stream, group.name) : null
    const keep = pending ?? nextId(group.lastDeliveredId)
    if (floor === null || compareIds(keep, floor) < 0) floor = keep
  }
  return floor
}

/**
 * Граница обрезки потока (`MINID`): записи ниже неё старше срока хранения и уже
 * получены всеми группами подписчиков. Отставшая группа держит поток, пока не
 * прочитает своё, — до жёсткого предела `STREAM_HARD_CAP`.
 */
export async function trimThreshold(
  stream: string,
  now = Date.now(),
  client: Redis = redis(),
): Promise<string> {
  const retentionMs = config().EVENT_STREAM_RETENTION_HOURS * 3600_000
  const byTime = `${Math.max(0, now - retentionMs)}-0`
  const floor = await groupsFloor(client, stream)
  return floor !== null && compareIds(floor, byTime) < 0 ? floor : byTime
}

/**
 * Обрезка потоков (задание `events.trim`). Приблизительная (`~`): Redis снимает
 * только целые узлы потока, поэтому записей остаётся не меньше, чем по границе.
 */
export async function trimStreams(now = Date.now()): Promise<{ streams: number; trimmed: number }> {
  const client = redis()
  let trimmed = 0
  const streams = await eventStreams(client)
  for (const stream of streams) {
    const threshold = await trimThreshold(stream, now, client)
    trimmed += Number(await client.xtrim(stream, 'MINID', '~', threshold))
  }
  return { streams: streams.length, trimmed }
}

/**
 * Очистка отметок обработки (задание `events.prune-consumptions`): пачками по
 * индексу времени, чтобы не держать долгую блокировку на горячей таблице.
 */
export async function pruneEventConsumptions(
  retentionDays = config().EVENT_CONSUMPTIONS_RETENTION_DAYS,
  batch = 10_000,
): Promise<number> {
  let deleted = 0
  for (;;) {
    const result = await rawSql()`
      DELETE FROM ops.event_consumptions
       WHERE ctid IN (
         SELECT ctid FROM ops.event_consumptions
          WHERE created_at < now() - make_interval(days => ${retentionDays})
          LIMIT ${batch})`
    deleted += result.count
    if (result.count < batch) return deleted
  }
}

export interface SubscriberLag {
  subscriber: string
  /** Не полученные группой записи по всем её потокам; `null` — неизвестно. */
  lag: number | null
  /** Полученные, но не подтверждённые записи. */
  pending: number
  /** Возраст самой старой неподтверждённой записи, с. */
  oldestPendingSeconds: number | null
}

export interface EventBusStats {
  subscribers: SubscriberLag[]
  streams: Array<{ stream: string; length: number }>
  dlq: number
}

/** Состояние шины: отставание подписчиков, длины потоков, размер DLQ. */
export async function eventBusStats(now = Date.now()): Promise<EventBusStats> {
  const client = redis()
  const registered = new Set(listSubscribers().map((subscriber) => subscriber.name))
  const lags = new Map<string, SubscriberLag>()
  const streams: EventBusStats['streams'] = []

  for (const stream of await eventStreams(client)) {
    streams.push({ stream, length: Number(await client.xlen(stream)) })
    for (const group of await groupsOf(client, stream)) {
      if (!registered.has(group.name)) continue
      const entry = lags.get(group.name) ?? {
        subscriber: group.name,
        lag: 0,
        pending: 0,
        oldestPendingSeconds: null,
      }
      entry.lag = entry.lag === null || group.lag === null ? null : entry.lag + group.lag
      entry.pending += group.pending
      if (group.pending > 0) {
        const oldest = await oldestPendingId(client, stream, group.name)
        if (oldest) {
          const age = Math.max(0, Math.floor((now - idTime(oldest)) / 1000))
          entry.oldestPendingSeconds = Math.max(entry.oldestPendingSeconds ?? 0, age)
        }
      }
      lags.set(group.name, entry)
    }
  }

  return {
    subscribers: [...lags.values()].sort((a, b) => a.subscriber.localeCompare(b.subscriber)),
    streams,
    dlq: Number(await client.xlen(DLQ_STREAM)),
  }
}

// ─── Очередь сбоев ───────────────────────────────────────────────────────────

export interface DlqEntry {
  /** Идентификатор записи DLQ (`мс-номер`). */
  id: string
  failedAt: string
  subscriber: string
  error: string
  attempts: number | null
  event: EventEnvelope
}

function parseDlqEntry(id: string, fields: string[]): DlqEntry | null {
  const value = (name: string) => {
    for (let index = 0; index < fields.length - 1; index += 2) {
      if (fields[index] === name) return fields[index + 1]
    }
    return undefined
  }
  const raw = value('event')
  const subscriber = value('consumer')
  if (!raw || !subscriber) return null
  try {
    const attempts = value('attempts')
    return {
      id,
      failedAt: new Date(idTime(id)).toISOString(),
      subscriber,
      error: value('error') ?? '',
      attempts: attempts === undefined ? null : Number(attempts),
      event: JSON.parse(raw) as EventEnvelope,
    }
  } catch {
    return null
  }
}

/** События, не обработанные подписчиком после всех попыток, — новые первыми. */
export async function listDlq(limit = 100): Promise<{ items: DlqEntry[]; total: number }> {
  const client = redis()
  const rows = (await client.xrevrange(DLQ_STREAM, '+', '-', 'COUNT', limit)) as Array<
    [string, string[]]
  >
  return {
    items: rows
      .map(([id, fields]) => parseDlqEntry(id, fields))
      .filter((entry): entry is DlqEntry => entry !== null),
    total: Number(await client.xlen(DLQ_STREAM)),
  }
}

export type DlqRetryOutcome = 'retried' | 'not_found' | 'unknown_subscriber'

/**
 * Повтор события из DLQ: оно возвращается в поток своего домена с адресом
 * подписчика, у которого упало, — другие группы его пропустят. Запись DLQ
 * удаляется: при новом сбое событие вернётся туда само.
 */
export async function retryDlqEntry(
  id: string,
): Promise<{ outcome: DlqRetryOutcome; entry: DlqEntry | null }> {
  const client = redis()
  const [row] = (await client.xrange(DLQ_STREAM, id, id)) as Array<[string, string[]]>
  const entry = row ? parseDlqEntry(row[0], row[1]) : null
  if (!entry) {
    // Нечитаемую запись повторить нельзя — убираем, чтобы она не висела вечно
    if (row) await client.xdel(DLQ_STREAM, id)
    return { outcome: 'not_found', entry: null }
  }
  if (!listSubscribers().some((subscriber) => subscriber.name === entry.subscriber)) {
    return { outcome: 'unknown_subscriber', entry }
  }
  await xaddEvent(client, entry.event, { only: entry.subscriber })
  await client.xdel(DLQ_STREAM, id)
  logger().info(
    {
      eventId: entry.event.id,
      subscriber: entry.subscriber,
      stream: streamKey(eventDomain(entry.event)),
    },
    'событие из DLQ возвращено в поток',
  )
  return { outcome: 'retried', entry }
}

/** Повтор всей очереди сбоев (до 1000 записей за вызов). */
export async function retryAllDlq(): Promise<{ retried: number; skipped: number }> {
  const rows = (await redis().xrange(DLQ_STREAM, '-', '+', 'COUNT', 1000)) as Array<
    [string, string[]]
  >
  let retried = 0
  let skipped = 0
  for (const [id] of rows) {
    if ((await retryDlqEntry(id)).outcome === 'retried') retried += 1
    else skipped += 1
  }
  return { retried, skipped }
}

/** Сводка шины для «Здоровья системы»: DLQ и до 20 самых отстающих подписчиков. */
export async function healthEvents(): Promise<{ dlq: number; lagging: SubscriberLag[] }> {
  const stats = await eventBusStats()
  const lagging = stats.subscribers
    .filter((entry) => (entry.lag ?? 0) > 0 || entry.pending > 0)
    .sort((a, b) => (b.lag ?? 0) + b.pending - ((a.lag ?? 0) + a.pending))
    .slice(0, 20)
  return { dlq: stats.dlq, lagging }
}
