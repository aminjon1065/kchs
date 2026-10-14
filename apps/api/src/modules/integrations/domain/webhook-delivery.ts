import { createHmac, timingSafeEqual } from 'node:crypto'
import { type EventEnvelope, WEBHOOK_HEADERS } from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { request } from 'undici'
import { getPrincipalSet } from '~/kernel/access/principal-set.js'
import { matchesType } from '~/kernel/events/bus.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { queue } from '~/kernel/jobs/service.js'
import { config } from '~/shared/config/index.js'
import { systemCtx } from '~/shared/context.js'
import { decryptSecret } from '~/shared/crypto/secrets.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { outboundBlocked, outboundDispatcher } from '~/shared/net/outbound.js'
import { type WebhookDeliveryRow, type WebhookRow, webhookDeliveries, webhooks } from '../schema.js'
import { checkOutboundUrl, OUTBOUND_TIMEOUT_MS } from './checks.js'
import { Webhooks } from './webhook-service.js'

export const WEBHOOK_DELIVER_JOB = { queue: 'automation', name: 'webhook.deliver' } as const

/**
 * Служебные домены, которые наружу не уходят никогда.
 * `job.*` порождается самой доставкой — подписка на него зациклила бы очередь;
 * `webhook.*` и `token.*` описывают устройство доставки и выпуск ключей.
 */
const INTERNAL_DOMAINS = new Set(['job', 'webhook', 'token'])

/** Задержки повторов: 30 с, 1, 5, 15, 30 мин, 1, 2, 6 ч (далее — 6 ч до конца окна). */
const RETRY_DELAYS_MS = [
  30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000,
]

export function signBody(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
}

/** Проверка подписи — для тестов и примеров в документации API. */
export function verifySignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  const expected = Buffer.from(`sha256=${signBody(secret, timestamp, body)}`)
  const actual = Buffer.from(signature)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Событие подходит вебхуку: тип, пространство и видимость владельца подписки. */
async function matches(row: WebhookRow, event: EventEnvelope): Promise<boolean> {
  if (!matchesType(row.eventTypes, event.type)) return false
  if (row.spaceIds.length > 0) {
    const spaceId = event.object?.spaceId ?? event.target?.spaceId ?? null
    if (!spaceId || !row.spaceIds.includes(spaceId)) return false
  }
  // Видимость факта: наружу уходит только то, что видит владелец подписки
  if (event.visibility?.principals && event.visibility.principals.length > 0) {
    const principals = await getPrincipalSet(row.runAsUserId)
    const keys = new Set(principals.keys)
    if (!event.visibility.principals.some((key) => keys.has(key))) return false
  }
  return true
}

/**
 * Подписчик шины: заводит доставки для подходящих вебхуков и ставит их в
 * очередь. Запись доставки уникальна по паре (вебхук, событие) — повторная
 * обработка события подписчиком не задваивает отправку.
 */
export async function dispatchEvent(event: EventEnvelope): Promise<void> {
  const domain = event.type.split('.')[0] ?? ''
  // Подписки изменились, возможно в другом процессе, — список перечитывается (ADR-0222)
  if (domain === 'webhook' || event.object?.type === 'webhook') Webhooks.invalidateActive()
  if (INTERNAL_DOMAINS.has(domain)) return

  const active = await Webhooks.active()
  if (active.length === 0) return

  for (const row of active) {
    if (!(await matches(row, event))) continue
    const id = newId()
    const inserted = await db()
      .insert(webhookDeliveries)
      .values({
        id,
        webhookId: row.id,
        eventId: event.id,
        eventType: event.type,
        payload: event as unknown as Record<string, unknown>,
        status: 'pending',
        nextAttemptAt: sql`now()` as never,
      })
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.id })
      // Подписку удалили, а кэш процесса её ещё помнит — доставлять некуда
      .catch((error: unknown) => {
        if (foreignKeyViolation(error)) {
          Webhooks.invalidateActive()
          return []
        }
        throw error
      })
    if (inserted.length === 0) continue
    await enqueueDelivery(id, 0)
  }
}

function foreignKeyViolation(error: unknown): boolean {
  for (let cause = error, depth = 0; cause && depth < 3; depth += 1) {
    if ((cause as { code?: unknown }).code === '23503') return true
    cause = (cause as { cause?: unknown }).cause
  }
  return false
}

async function enqueueDelivery(deliveryId: string, delayMs: number): Promise<void> {
  await queue(WEBHOOK_DELIVER_JOB.queue).add(
    WEBHOOK_DELIVER_JOB.name,
    { deliveryId },
    { delay: delayMs, attempts: 1, removeOnComplete: { age: 600, count: 100 } },
  )
}

interface Attempt {
  ok: boolean
  status: number | null
  error: string | null
  durationMs: number
}

/**
 * Политика адресов доставки — та же, что у `checkOutboundUrl`: с защитой закрыты частные
 * сети и loopback, без неё (стенд, закрытый контур) — открыты; служебные адреса
 * (метаданные облака, «этот узел», multicast) закрыты всегда.
 */
function webhookDispatcher() {
  const open = config().WEBHOOKS_ALLOW_PRIVATE_ADDRESSES
  return outboundDispatcher({ denyPrivateNetworks: !open, allowLoopback: open })
}

async function send(row: WebhookRow, delivery: WebhookDeliveryRow): Promise<Attempt> {
  const body = JSON.stringify(delivery.payload)
  const timestamp = new Date().toISOString()
  const secret = decryptSecret(row.secret)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS)
  const started = Date.now()
  try {
    // Адрес проверяется не только при подписке, но и перед каждой отправкой:
    // имя, которое при создании смотрело наружу, к моменту доставки может
    // указывать внутрь сети (DNS rebinding), а подписка живёт сутками
    const allowed = await checkOutboundUrl(row.url)
    if (!allowed.ok) {
      return {
        ok: false,
        status: null,
        error: allowed.reason ?? 'Адрес запрещён',
        durationMs: Date.now() - started,
      }
    }
    // Соединение — только с адресом, прошедшим проверку в момент соединения (ADR-0222):
    // проверка выше разрешает имя сама, и подмена записи DNS между ней и запросом
    // (DNS rebinding) иначе увела бы запрос внутрь сети
    const response = await request(row.url, {
      method: 'POST',
      // Перенаправления не выполняются: иначе получатель уводит запрос внутрь сети
      maxRedirections: 0,
      dispatcher: webhookDispatcher(),
      signal: controller.signal,
      headersTimeout: OUTBOUND_TIMEOUT_MS,
      bodyTimeout: OUTBOUND_TIMEOUT_MS,
      headers: {
        'content-type': 'application/json',
        [WEBHOOK_HEADERS.event]: delivery.eventType,
        [WEBHOOK_HEADERS.delivery]: delivery.id,
        [WEBHOOK_HEADERS.timestamp]: timestamp,
        [WEBHOOK_HEADERS.signature]: `sha256=${signBody(secret, timestamp, body)}`,
      },
      body,
    })
    await response.body.dump().catch(() => undefined)
    const status = response.statusCode
    return {
      ok: status >= 200 && status < 300,
      status,
      error: status >= 200 && status < 300 ? null : `Ответ ${status}`,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: outboundBlocked(error)
        ? 'Имя указывает во внутреннюю сеть'
        : error instanceof Error
          ? error.message
          : 'Нет соединения',
      durationMs: Date.now() - started,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Одна попытка доставки: обработчик задания `automation:webhook.deliver`. */
export async function deliverOnce(deliveryId: string): Promise<{ status: string }> {
  const [delivery] = await db()
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1)
  if (!delivery || delivery.status === 'delivered' || delivery.status === 'dropped') {
    return { status: delivery?.status ?? 'missing' }
  }
  const [row] = await db()
    .select()
    .from(webhooks)
    .where(eq(webhooks.id, delivery.webhookId))
    .limit(1)
  if (!row) return { status: 'missing' }
  if (row.status === 'disabled') {
    await db()
      .update(webhookDeliveries)
      .set({ status: 'dropped', error: 'Вебхук отключён', nextAttemptAt: null })
      .where(eq(webhookDeliveries.id, deliveryId))
    return { status: 'dropped' }
  }

  const attempt = await send(row, delivery)
  const attempts = delivery.attempts + 1
  const ctx = systemCtx('webhook-delivery')

  if (attempt.ok) {
    await db().transaction(async (tx) => {
      await tx
        .update(webhookDeliveries)
        .set({
          status: 'delivered',
          attempts,
          responseStatus: attempt.status,
          error: null,
          nextAttemptAt: null,
          durationMs: attempt.durationMs,
          deliveredAt: sql`now()`,
        })
        .where(eq(webhookDeliveries.id, deliveryId))
      await tx
        .update(webhooks)
        .set({
          failureStreak: 0,
          lastDeliveryAt: sql`now()`,
          lastStatus: attempt.status,
          lastError: null,
        })
        .where(eq(webhooks.id, row.id))
      await publishEvent(tx, ctx, {
        type: 'webhook.delivered',
        object: { id: row.id, type: 'webhook' },
        payload: {
          webhookId: row.id,
          deliveryId,
          eventType: delivery.eventType,
          responseStatus: attempt.status,
          attempts,
        },
      })
    })
    return { status: 'delivered' }
  }

  const windowMs = config().WEBHOOK_RETRY_WINDOW_HOURS * 3_600_000
  const elapsed = Date.now() - Date.parse(delivery.createdAt)
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)] ?? 0
  const retry = elapsed + delay < windowMs

  const failures = row.failureStreak + 1
  await db().transaction(async (tx) => {
    await tx
      .update(webhookDeliveries)
      .set({
        status: retry ? 'pending' : 'failed',
        attempts,
        responseStatus: attempt.status,
        error: attempt.error,
        durationMs: attempt.durationMs,
        nextAttemptAt: retry ? (sql`now() + ${`${delay} milliseconds`}::interval` as never) : null,
      })
      .where(eq(webhookDeliveries.id, deliveryId))
    await tx
      .update(webhooks)
      .set({
        failureStreak: failures,
        lastDeliveryAt: sql`now()`,
        lastStatus: attempt.status,
        lastError: attempt.error,
      })
      .where(eq(webhooks.id, row.id))
    if (!retry) {
      await publishEvent(tx, ctx, {
        type: 'webhook.failed',
        object: { id: row.id, type: 'webhook' },
        payload: {
          webhookId: row.id,
          deliveryId,
          eventType: delivery.eventType,
          attempts,
          error: attempt.error ?? 'ошибка',
        },
      })
    }
    if (failures >= row.disableAfterFailures) {
      await Webhooks.disable(tx, ctx, row, 'failures', failures)
    }
  })

  if (retry) {
    await enqueueDelivery(deliveryId, delay)
    logger().warn(
      { webhookId: row.id, deliveryId, attempts, delay },
      'доставка вебхука не удалась, назначен повтор',
    )
  }
  return { status: retry ? 'retry' : 'failed' }
}

/** Ручной повтор доставки из журнала. */
export async function retryDelivery(webhookId: string, deliveryId: string): Promise<void> {
  const [delivery] = await db()
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, webhookId)))
    .limit(1)
  if (!delivery) throw errors.notFound('Доставка')
  await db()
    .update(webhookDeliveries)
    .set({ status: 'pending', error: null, nextAttemptAt: sql`now()` })
    .where(eq(webhookDeliveries.id, deliveryId))
  await enqueueDelivery(deliveryId, 0)
}

/** Удаляет доставки старше указанного срока — обслуживание журнала. */
export async function pruneDeliveries(olderThanDays = 30): Promise<number> {
  const deleted = await db()
    .delete(webhookDeliveries)
    .where(
      and(
        sql`${webhookDeliveries.createdAt} < now() - ${`${olderThanDays} days`}::interval`,
        inArray(webhookDeliveries.status, ['delivered', 'failed', 'dropped']),
      ),
    )
    .returning({ id: webhookDeliveries.id })
  return deleted.length
}
