import { eq } from 'drizzle-orm'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { systemCtx } from '~/shared/context.js'
import { hashToken, safeEqual } from '~/shared/crypto/secrets.js'
import { db } from '~/shared/db/client.js'
import { integrations } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'

/** Предел тела входящего вебхука: он попадает в событие целиком. */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Входящий вебхук интеграции (14-automation-integrations.md §4).
 *
 * Единственное, что делает маршрут, — публикует факт `webhook.received`.
 * Ничего в системе он не меняет и ничьих прав не получает: дальше работают
 * правила автоматизации от имени своего `run_as`. Поэтому знание секрета не
 * даёт доступа к данным — это обход авторизации был бы, если бы вебхук сам
 * выполнял действия (17-security.md §3).
 */
export async function receiveInbound(input: {
  integrationId: string
  secret: string
  body: unknown
  signature: string | null
  ip: string | null
}): Promise<{ accepted: true }> {
  const [row] = await db()
    .select()
    .from(integrations)
    .where(eq(integrations.id, input.integrationId))
    .limit(1)

  // Существование интеграции не раскрывается: нет строки, выключен входящий
  // вебхук или не сошёлся секрет — ответ одинаковый
  const hash = row?.inboundSecretHash ?? null
  const ok =
    row?.enabled === true &&
    row.inboundEnabled &&
    hash !== null &&
    safeEqual(hash, hashToken(input.secret))
  if (!ok || !row) {
    await audit(systemCtx('webhook-inbound'), {
      action: AUDIT_ACTIONS.webhookReceived,
      severity: 'warning',
      objectType: 'integration',
      objectId: null,
      ip: input.ip,
      details: { integrationId: input.integrationId, accepted: false },
    })
    throw errors.notFound('Вебхук')
  }

  const body = normalizeBody(input.body)
  await db().transaction(async (tx) => {
    await publishEvent(tx, systemCtx('webhook-inbound'), {
      type: 'webhook.received',
      object: { id: row.id, type: 'integration' },
      source: 'webhook',
      payload: {
        integrationId: row.id,
        integrationKey: row.key,
        kind: row.kind,
        body,
        signature: input.signature,
      },
    })
  })

  await audit(systemCtx('webhook-inbound'), {
    action: AUDIT_ACTIONS.webhookReceived,
    objectId: row.id,
    objectType: 'integration',
    ip: input.ip,
    details: { key: row.key, accepted: true },
  })
  return { accepted: true }
}

/** Тело всегда становится объектом: массив и строка кладутся в поле. */
function normalizeBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') return { raw: clip(body) }
  if (Array.isArray(body)) return { items: body }
  if (body !== null && typeof body === 'object') {
    const json = JSON.stringify(body)
    if (json.length > MAX_BODY_BYTES) throw errors.payloadTooLarge('Тело вебхука слишком большое')
    return body as Record<string, unknown>
  }
  return {}
}

function clip(value: string): string {
  return value.length > MAX_BODY_BYTES ? value.slice(0, MAX_BODY_BYTES) : value
}
