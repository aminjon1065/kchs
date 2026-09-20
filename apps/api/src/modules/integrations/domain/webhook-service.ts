import { randomBytes } from 'node:crypto'
import type {
  Webhook,
  WebhookCreateInput,
  WebhookDelivery,
  WebhookUpdateInput,
} from '@kchs/contracts'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { encryptSecret } from '~/shared/crypto/secrets.js'
import type { Executor } from '~/shared/db/client.js'
import { db } from '~/shared/db/client.js'
import type { WebhookRow } from '~/shared/db/schema/index.js'
import { objects, webhookDeliveries, webhooks } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { checkOutboundUrl } from './checks.js'

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base.length > 0 ? base : 'webhook'
}

async function present(rows: Array<{ row: WebhookRow; title: string }>): Promise<Webhook[]> {
  const refs = await directory().refs(rows.map((r) => r.row.runAsUserId))
  return rows.map(({ row, title }) => ({
    id: row.id,
    key: row.key,
    name: title,
    url: row.url,
    status: row.status as Webhook['status'],
    eventTypes: row.eventTypes,
    spaceIds: row.spaceIds,
    runAsUserId: row.runAsUserId,
    runAsName: refs.get(row.runAsUserId)?.displayName ?? null,
    hasSecret: row.secret.length > 0,
    failureStreak: row.failureStreak,
    disableAfterFailures: row.disableAfterFailures,
    lastDeliveryAt: row.lastDeliveryAt,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    disabledAt: row.disabledAt,
    disabledReason: row.disabledReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))
}

async function loadRow(id: string): Promise<{ row: WebhookRow; title: string }> {
  const [found] = await db()
    .select({ row: webhooks, title: objects.title })
    .from(webhooks)
    .innerJoin(objects, eq(objects.id, webhooks.id))
    .where(eq(webhooks.id, id))
    .limit(1)
  if (!found) throw errors.notFound('Вебхук')
  return found
}

async function uniqueKey(name: string): Promise<string> {
  const base = slugify(name)
  for (let suffix = 0; suffix < 100; suffix++) {
    const key = suffix === 0 ? base : `${base}-${suffix}`
    const [taken] = await db()
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(eq(webhooks.key, key))
      .limit(1)
    if (!taken) return key
  }
  return `${base}-${randomBytes(3).toString('hex')}`
}

export const Webhooks = {
  async list(): Promise<Webhook[]> {
    const rows = await db()
      .select({ row: webhooks, title: objects.title })
      .from(webhooks)
      .innerJoin(objects, eq(objects.id, webhooks.id))
      .where(sql`${objects.deletedAt} is null`)
      .orderBy(desc(webhooks.createdAt))
    return present(rows)
  },

  async get(id: string): Promise<Webhook> {
    const found = await loadRow(id)
    const [item] = await present([found])
    if (!item) throw errors.notFound('Вебхук')
    return item
  },

  async byKey(key: string): Promise<{ row: WebhookRow; title: string } | null> {
    const [found] = await db()
      .select({ row: webhooks, title: objects.title })
      .from(webhooks)
      .innerJoin(objects, eq(objects.id, webhooks.id))
      .where(eq(webhooks.key, key))
      .limit(1)
    return found ?? null
  },

  /**
   * Вебхук доставляет события правами создателя (`runAsUserId`): подписка не
   * может показать наружу больше, чем видит человек, который её завёл.
   */
  async create(
    ctx: UserCtx,
    input: WebhookCreateInput,
    key?: string,
  ): Promise<{ webhook: Webhook; secret: string }> {
    const allowed = await checkOutboundUrl(input.url)
    if (!allowed.ok) throw errors.validation(allowed.reason ?? 'Адрес недопустим')

    const id = newId()
    const secret = input.secret ?? randomBytes(32).toString('base64url')
    const webhookKey = key ?? (await uniqueKey(input.name))

    await db().transaction(async (tx) => {
      await ObjectService.create(tx, ctx, {
        id,
        type: 'webhook',
        spaceId: null,
        title: input.name,
        meta: { key: webhookKey, status: input.status },
      })
      await tx.insert(webhooks).values({
        id,
        key: webhookKey,
        url: input.url,
        status: input.status,
        eventTypes: [...input.eventTypes],
        spaceIds: [...input.spaceIds],
        runAsUserId: ctx.userId,
        secret: encryptSecret(secret),
        disableAfterFailures: input.disableAfterFailures,
      })
      await publishEvent(tx, ctx, {
        type: 'webhook.created',
        object: { id, type: 'webhook', title: input.name },
        payload: { key: webhookKey, url: input.url },
      })
    })

    await audit(ctx, {
      action: AUDIT_ACTIONS.webhookCreated,
      objectId: id,
      objectType: 'webhook',
      severity: 'notice',
      details: { key: webhookKey, url: input.url, eventTypes: input.eventTypes },
    })
    return { webhook: await Webhooks.get(id), secret }
  },

  async update(ctx: UserCtx, id: string, input: WebhookUpdateInput): Promise<Webhook> {
    const found = await loadRow(id)
    if (input.url !== undefined) {
      const allowed = await checkOutboundUrl(input.url)
      if (!allowed.ok) throw errors.validation(allowed.reason ?? 'Адрес недопустим')
    }

    const changed: string[] = []
    const patch: Record<string, unknown> = { updatedAt: sql`now()` }
    if (input.url !== undefined) {
      patch.url = input.url
      changed.push('url')
    }
    if (input.eventTypes !== undefined) {
      patch.eventTypes = [...input.eventTypes]
      changed.push('eventTypes')
    }
    if (input.spaceIds !== undefined) {
      patch.spaceIds = [...input.spaceIds]
      changed.push('spaceIds')
    }
    if (input.disableAfterFailures !== undefined) {
      patch.disableAfterFailures = input.disableAfterFailures
      changed.push('disableAfterFailures')
    }
    if (input.secret !== undefined) {
      patch.secret = encryptSecret(input.secret)
      changed.push('secret')
    }
    if (input.status !== undefined) {
      patch.status = input.status
      changed.push('status')
      // Включили заново — счётчик отказов и причина отключения сбрасываются
      if (input.status === 'active') {
        patch.failureStreak = 0
        patch.disabledAt = null
        patch.disabledReason = null
      }
    }

    await db().transaction(async (tx) => {
      if (input.name !== undefined && input.name !== found.title) {
        await ObjectService.update(tx, ctx, id, { title: input.name })
        changed.push('name')
      }
      await tx.update(webhooks).set(patch).where(eq(webhooks.id, id))
      await publishEvent(tx, ctx, {
        type: 'webhook.updated',
        object: { id, type: 'webhook', title: input.name ?? found.title },
        payload: { key: found.row.key, changed },
      })
    })

    await audit(ctx, {
      action:
        input.secret !== undefined
          ? AUDIT_ACTIONS.webhookSecretRotated
          : AUDIT_ACTIONS.webhookUpdated,
      objectId: id,
      objectType: 'webhook',
      severity: 'notice',
      details: { key: found.row.key, changed },
    })
    return Webhooks.get(id)
  },

  /** Перевыпуск секрета подписи: значение показывается один раз. */
  async rotateSecret(ctx: UserCtx, id: string): Promise<string> {
    const found = await loadRow(id)
    const secret = randomBytes(32).toString('base64url')
    await db()
      .update(webhooks)
      .set({ secret: encryptSecret(secret), updatedAt: sql`now()` })
      .where(eq(webhooks.id, id))
    await audit(ctx, {
      action: AUDIT_ACTIONS.webhookSecretRotated,
      objectId: id,
      objectType: 'webhook',
      severity: 'notice',
      details: { key: found.row.key },
    })
    return secret
  },

  async remove(ctx: UserCtx, id: string): Promise<void> {
    const found = await loadRow(id)
    await db().transaction(async (tx) => {
      await ObjectService.purge(tx, ctx, id)
    })
    await audit(ctx, {
      action: AUDIT_ACTIONS.webhookDeleted,
      objectId: id,
      objectType: 'webhook',
      severity: 'notice',
      details: { key: found.row.key },
    })
  },

  /** Журнал доставок вебхука, новые сверху. */
  async deliveries(
    id: string,
    options: { limit: number; cursor?: string },
  ): Promise<{ items: WebhookDelivery[]; nextCursor: string | null }> {
    const conditions = [eq(webhookDeliveries.webhookId, id)]
    if (options.cursor) conditions.push(lt(webhookDeliveries.createdAt, options.cursor))
    const rows = await db()
      .select()
      .from(webhookDeliveries)
      .where(and(...conditions))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(options.limit + 1)
    const page = rows.slice(0, options.limit)
    return {
      items: page.map((row) => ({
        id: row.id,
        webhookId: row.webhookId,
        eventId: row.eventId,
        eventType: row.eventType,
        status: row.status as WebhookDelivery['status'],
        attempts: row.attempts,
        responseStatus: row.responseStatus,
        error: row.error,
        nextAttemptAt: row.nextAttemptAt,
        durationMs: row.durationMs,
        createdAt: row.createdAt,
        deliveredAt: row.deliveredAt,
      })),
      nextCursor: rows.length > options.limit ? (page[page.length - 1]?.createdAt ?? null) : null,
    }
  },

  /** Отключение после серии отказов — в отдельной транзакции доставщика. */
  async disable(
    tx: Executor,
    ctx: Ctx,
    row: WebhookRow,
    reason: string,
    failures: number,
  ): Promise<void> {
    await tx
      .update(webhooks)
      .set({ status: 'disabled', disabledAt: sql`now()`, disabledReason: reason })
      .where(eq(webhooks.id, row.id))
    await publishEvent(tx, ctx, {
      type: 'webhook.disabled',
      object: { id: row.id, type: 'webhook' },
      payload: { key: row.key, reason, failures },
    })
  },
}
