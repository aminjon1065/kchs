import type { EventEnvelope } from '@kchs/contracts'
import { inArray, sql } from 'drizzle-orm'
import { objects } from '~/kernel/objects/schema.js'
import { config } from '~/shared/config/index.js'
import { db, type Executor } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { redis } from '~/shared/redis/index.js'
import { apiTokens, integrationConnections, integrationUsageDaily } from '../schema.js'

/**
 * Учёт подключений шлюза (ADR-0206): суточные счётчики запросов, записанных строк и
 * ошибок по каждому подключению — токену, входящему вебхуку, почтовому ящику,
 * ленте, источнику из внешней БД, форме, исходящему вебхуку, адаптеру ЭДО.
 *
 * Два пути записи:
 *  - запрос по токену — горячий путь API: на нём только `HINCRBY` в Redis без
 *    ожидания ответа, в базу счётчики сбрасывает задание раз в минуту одной
 *    транзакцией (`flushTokenUsage`);
 *  - остальное — факты из событий (`recordUsageEvent`): синхронизация ленты, сдача
 *    формы, входящий вызов, доставка вебхука. Их на порядки меньше, чем запросов,
 *    и подписчик работает вне запроса — пишет в базу сразу.
 */
export const CONNECTION_CHANNELS = [
  'api',
  'webhook_in',
  'mail_in',
  'feed',
  'database',
  'form',
  'webhook_out',
  'edms',
] as const
export type ConnectionChannel = (typeof CONNECTION_CHANNELS)[number]

export type ConnectionKind = 'token' | 'integration' | 'source' | 'form' | 'webhook' | 'rule'

export interface UsageEntry {
  subjectId: string
  channel: ConnectionChannel
  kind: ConnectionKind
  /** Название подключения; `null` — взять из реестра объектов или токена. */
  title: string | null
  ownerId?: string | null
  requests: number
  rows: number
  errors: number
  at: Date
  /** Текст ошибки — у неудачной передачи. */
  error?: string | null
}

/** Запросы токенов, ещё не сброшенные в базу: поле `<день>|<id токена>`. */
const PENDING_KEY = 'kchs:usage:pending'
/** Снимок, который сбрасывается сейчас; остаётся, если сброс упал, — досчитается следующим. */
const FLUSHING_KEY = 'kchs:usage:flushing'
const FLUSH_LOCK_KEY = 'kchs:usage:flush-lock'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** День по часовому поясу установки: `2026-10-12`. */
export function usageDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config().TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
}

/**
 * Запрос по токену — на горячем пути аутентификации. Ответа Redis не ждёт: потеря
 * счётчика при сбое Redis — допустимая цена телеметрии, задержка запроса — нет.
 */
export function hitTokenUsage(tokenId: string, at = new Date()): void {
  redis()
    .hincrby(PENDING_KEY, `${usageDay(at)}|${tokenId}`, 1)
    .catch((error: unknown) => {
      logger().child({ module: 'integrations' }).warn({ err: error }, 'счётчик токена не записан')
    })
}

/** Названия и владельцы подключений, для которых их не передали. */
async function resolveTitles(executor: Executor, entries: UsageEntry[]): Promise<void> {
  const missing = entries.filter((entry) => entry.title === null)
  if (missing.length === 0) return
  const tokenIds = [...new Set(missing.filter((e) => e.kind === 'token').map((e) => e.subjectId))]
  const objectIds = [...new Set(missing.filter((e) => e.kind !== 'token').map((e) => e.subjectId))]
  const titles = new Map<string, { title: string; ownerId: string | null }>()
  if (tokenIds.length > 0) {
    const rows = await executor
      .select({ id: apiTokens.id, name: apiTokens.name, userId: apiTokens.userId })
      .from(apiTokens)
      .where(inArray(apiTokens.id, tokenIds))
    for (const row of rows) titles.set(row.id, { title: row.name, ownerId: row.userId })
  }
  if (objectIds.length > 0) {
    const rows = await executor
      .select({ id: objects.id, title: objects.title })
      .from(objects)
      .where(inArray(objects.id, objectIds))
    for (const row of rows) titles.set(row.id, { title: row.title, ownerId: null })
  }
  for (const entry of missing) {
    const found = titles.get(entry.subjectId)
    entry.title = found?.title ?? entry.subjectId
    if (entry.ownerId === undefined && found?.ownerId) entry.ownerId = found.ownerId
  }
}

/**
 * Записывает передачи: подключение (с какого времени, последняя передача и ошибка)
 * и суточные счётчики — накоплением, повторный вызов прибавляет, а не заменяет.
 * Телеметрия, а не изменение предметного состояния: событий не публикует (как
 * `ApiTokens.touch`, ADR-0206).
 */
export async function recordUsage(executor: Executor, entries: UsageEntry[]): Promise<void> {
  const valid = entries.filter((entry) => UUID_RE.test(entry.subjectId))
  if (valid.length === 0) return
  await resolveTitles(executor, valid)
  for (const entry of valid) {
    const ok = entry.requests + entry.rows > 0
    const failed = entry.errors > 0
    await executor
      .insert(integrationConnections)
      .values({
        subjectId: entry.subjectId,
        channel: entry.channel,
        kind: entry.kind,
        title: (entry.title ?? entry.subjectId).slice(0, 500),
        ownerId: entry.ownerId ?? null,
        firstAt: entry.at.toISOString(),
        lastAt: ok ? entry.at.toISOString() : null,
        lastErrorAt: failed ? entry.at.toISOString() : null,
        lastError: failed ? (entry.error ?? null)?.slice(0, 1000) : null,
      })
      .onConflictDoUpdate({
        target: [integrationConnections.subjectId, integrationConnections.channel],
        set: {
          title: sql`excluded.title`,
          ownerId: sql`coalesce(excluded.owner_id, ${integrationConnections.ownerId})`,
          firstAt: sql`least(${integrationConnections.firstAt}, excluded.first_at)`,
          lastAt: sql`greatest(${integrationConnections.lastAt}, excluded.last_at)`,
          lastErrorAt: sql`greatest(${integrationConnections.lastErrorAt}, excluded.last_error_at)`,
          lastError: sql`CASE WHEN excluded.last_error_at IS NOT NULL
            AND excluded.last_error_at >= coalesce(${integrationConnections.lastErrorAt}, excluded.last_error_at)
            THEN excluded.last_error ELSE ${integrationConnections.lastError} END`,
        },
      })
    await executor
      .insert(integrationUsageDaily)
      .values({
        subjectId: entry.subjectId,
        channel: entry.channel,
        day: usageDay(entry.at),
        requests: entry.requests,
        rows: entry.rows,
        errors: entry.errors,
        lastAt: ok ? entry.at.toISOString() : null,
      })
      .onConflictDoUpdate({
        target: [
          integrationUsageDaily.subjectId,
          integrationUsageDaily.channel,
          integrationUsageDaily.day,
        ],
        set: {
          requests: sql`${integrationUsageDaily.requests} + excluded.requests`,
          rows: sql`${integrationUsageDaily.rows} + excluded.rows`,
          errors: sql`${integrationUsageDaily.errors} + excluded.errors`,
          lastAt: sql`greatest(${integrationUsageDaily.lastAt}, excluded.last_at)`,
        },
      })
  }
}

/**
 * Сброс счётчиков токенов из Redis в базу (задание раз в минуту). Хэш
 * переименовывается в снимок атомарно — запросы, пришедшие во время сброса, копятся
 * в новом хэше. Снимок удаляется после фиксации транзакции; если сброс упал,
 * снимок досчитывается следующим запуском. Возвращает, сколько пар «день, токен»
 * записано.
 */
export async function flushTokenUsage(now = new Date()): Promise<number> {
  const client = redis()
  const locked = await client.set(FLUSH_LOCK_KEY, '1', 'EX', 50, 'NX')
  if (locked !== 'OK') return 0
  try {
    if (!(await client.exists(FLUSHING_KEY))) {
      if (!(await client.exists(PENDING_KEY))) return 0
      await client.rename(PENDING_KEY, FLUSHING_KEY)
    }
    const raw = await client.hgetall(FLUSHING_KEY)
    const entries: UsageEntry[] = []
    for (const [field, value] of Object.entries(raw)) {
      const [day, tokenId] = field.split('|')
      const requests = Number(value)
      if (!day || !tokenId || !Number.isFinite(requests) || requests <= 0) continue
      // Передача относится к своему дню, даже если сброс случился после полуночи
      const at = usageDay(now) === day ? now : new Date(`${day}T12:00:00Z`)
      entries.push({
        subjectId: tokenId,
        channel: 'api',
        kind: 'token',
        title: null,
        requests,
        rows: 0,
        errors: 0,
        at,
      })
    }
    // Токен могли удалить вместе с владельцем — его счётчики не нужны
    const known = entries.length
      ? new Set(
          (
            await db()
              .select({ id: apiTokens.id })
              .from(apiTokens)
              .where(
                inArray(
                  apiTokens.id,
                  entries.map((e) => e.subjectId).filter((id) => UUID_RE.test(id)),
                ),
              )
          ).map((row) => row.id),
        )
      : new Set<string>()
    const live = entries.filter((entry) => known.has(entry.subjectId))
    if (live.length > 0) await db().transaction((tx) => recordUsage(tx, live))
    await client.del(FLUSHING_KEY)
    return live.length
  } finally {
    await client.del(FLUSH_LOCK_KEY)
  }
}

function tokenOf(event: EventEnvelope): string | null {
  const session = event.actor.sessionId
  if (!session?.startsWith('token:')) return null
  return session.slice('token:'.length)
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

/** Передача из события; `null` — событие не про обмен с внешней стороной. */
export function usageFromEvent(event: EventEnvelope): UsageEntry | null {
  const at = new Date(event.occurredAt)
  const payload = event.payload
  const object = event.object
  const base = { at, requests: 0, rows: 0, errors: 0 }
  switch (event.type) {
    case 'dataset.rows_changed':
    case 'dataset.imported': {
      // Строки, записанные по токену: правка и импорт через API
      const tokenId = tokenOf(event)
      if (!tokenId) return null
      const rows = event.type === 'dataset.imported' ? num(payload.rows) : num(payload.count)
      return { ...base, subjectId: tokenId, channel: 'api', kind: 'token', title: null, rows }
    }
    case 'form.submitted':
      if (!object) return null
      return {
        ...base,
        subjectId: object.id,
        channel: 'form',
        kind: 'form',
        title: object.title,
        requests: 1,
        rows: num(payload.rowCount),
      }
    case 'source.synced':
    case 'source.failed': {
      if (!object) return null
      const channel: ConnectionChannel = payload.kind === 'database' ? 'database' : 'feed'
      if (event.type === 'source.failed') {
        return {
          ...base,
          subjectId: object.id,
          channel,
          kind: 'source',
          title: object.title,
          errors: 1,
          error: str(payload.error),
        }
      }
      return {
        ...base,
        subjectId: object.id,
        channel,
        kind: 'source',
        title: object.title,
        requests: 1,
        rows: num(payload.inserted) + num(payload.updated),
      }
    }
    case 'webhook.received': {
      const integrationId = str(payload.integrationId)
      if (payload.source !== 'rule' && integrationId) {
        return {
          ...base,
          subjectId: integrationId,
          channel: 'webhook_in',
          kind: 'integration',
          title: null,
          requests: 1,
        }
      }
      // Адрес правила автоматизации — подключение самого правила
      if (!object) return null
      return {
        ...base,
        subjectId: object.id,
        channel: 'webhook_in',
        kind: 'rule',
        title: object.title ?? str(payload.hookKey),
        requests: 1,
      }
    }
    case 'mail.received': {
      const integrationId = str(payload.integrationId)
      if (!integrationId) return null
      return {
        ...base,
        subjectId: integrationId,
        channel: 'mail_in',
        kind: 'integration',
        title: null,
        requests: 1,
      }
    }
    case 'webhook.delivered':
    case 'webhook.failed': {
      const webhookId = str(payload.webhookId)
      if (!webhookId) return null
      const failed = event.type === 'webhook.failed'
      return {
        ...base,
        subjectId: webhookId,
        channel: 'webhook_out',
        kind: 'webhook',
        title: null,
        requests: failed ? 0 : 1,
        errors: failed ? 1 : 0,
        error: failed ? str(payload.error) : null,
      }
    }
    default:
      return null
  }
}

/** Типы событий подписчика учёта. */
export const USAGE_EVENT_TYPES = [
  'dataset.rows_changed',
  'dataset.imported',
  'form.submitted',
  'source.synced',
  'source.failed',
  'webhook.received',
  'webhook.delivered',
  'webhook.failed',
  'mail.received',
]

/** Подписчик шины: передача из события — в суточные счётчики. */
export async function recordUsageEvent(event: EventEnvelope): Promise<void> {
  const entry = usageFromEvent(event)
  if (!entry) return
  await db().transaction((tx) => recordUsage(tx, [entry]))
}

/** Суточные счётчики старше `days` дней удаляются; подключения остаются. */
export async function pruneUsage(days = 400): Promise<number> {
  const deleted = await db()
    .delete(integrationUsageDaily)
    .where(sql`${integrationUsageDaily.day} < current_date - ${days}::int`)
    .returning({ day: integrationUsageDaily.day })
  return deleted.length
}

/** Для тестов: сколько запросов токенов ждут сброса. */
export async function pendingTokenUsage(): Promise<Record<string, string>> {
  return redis().hgetall(PENDING_KEY)
}
