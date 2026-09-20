import { randomBytes } from 'node:crypto'
import type {
  Integration,
  IntegrationCheckResult,
  IntegrationCreateInput,
  IntegrationSync,
  IntegrationUpdateInput,
} from '@kchs/contracts'
import { desc, eq, sql } from 'drizzle-orm'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { config } from '~/shared/config/index.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { decryptSecret, encryptSecret, hashToken } from '~/shared/crypto/secrets.js'
import type { Executor } from '~/shared/db/client.js'
import { db } from '~/shared/db/client.js'
import type { IntegrationRow } from '~/shared/db/schema/index.js'
import { integrationSyncs, integrations, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { builtinIntegrations, checkBuiltin } from './builtins.js'
import { checkIntegration } from './checks.js'

/** Секреты лежат зашифрованным JSON; наружу отдаются только имена ключей. */
export function readSecrets(row: { secrets: Buffer | null }): Record<string, string> {
  if (!row.secrets || row.secrets.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(decryptSecret(row.secrets))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
  } catch {
    // Секрет зашифрован другим мастер-ключом: интеграция не работает, но список открывается
    return {}
  }
}

function writeSecrets(values: Record<string, string>): Buffer | null {
  const entries = Object.entries(values).filter(([, value]) => value.length > 0)
  if (entries.length === 0) return null
  return encryptSecret(JSON.stringify(Object.fromEntries(entries)))
}

function inboundUrl(id: string): string {
  return `${config().KCHS_API_URL}/api/v1/hooks/${id}/<секрет>`
}

function present(row: IntegrationRow, title: string): Integration {
  return {
    id: row.id,
    source: 'object',
    key: row.key,
    kind: row.kind as Integration['kind'],
    name: title,
    description: row.description,
    enabled: row.enabled,
    config: row.config,
    secretKeys: Object.keys(readSecrets(row)).sort(),
    status: row.status as Integration['status'],
    statusMessage: row.statusMessage,
    lastCheckAt: row.lastCheckAt,
    lastSyncAt: row.lastSyncAt,
    inboundEnabled: row.inboundEnabled,
    inboundUrl: row.inboundEnabled ? inboundUrl(row.id) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function rowWithTitle(id: string): Promise<{ row: IntegrationRow; title: string } | null> {
  const [found] = await db()
    .select({ row: integrations, title: objects.title })
    .from(integrations)
    .innerJoin(objects, eq(objects.id, integrations.id))
    .where(eq(integrations.id, id))
    .limit(1)
  return found ?? null
}

export const Integrations = {
  /**
   * Список интеграций установки: записи реестра и встроенные службы
   * (SMTP, Telegram-бот), настроенные окружением. Встроенные показываются
   * только для чтения — так они попадают в общий учёт, не меняя работу
   * (14-automation-integrations.md §5, ADR-0097).
   */
  async list(): Promise<Integration[]> {
    const rows = await db()
      .select({ row: integrations, title: objects.title })
      .from(integrations)
      .innerJoin(objects, eq(objects.id, integrations.id))
      .where(sql`${objects.deletedAt} is null`)
      .orderBy(integrations.key)
    return [...builtinIntegrations(), ...rows.map((r) => present(r.row, r.title))]
  },

  async get(id: string): Promise<Integration> {
    const found = await rowWithTitle(id)
    if (!found) throw errors.notFound('Интеграция')
    return present(found.row, found.title)
  },

  /**
   * Включённые интеграции одного вида с расшифрованными секретами — для
   * модуля, который их обслуживает (почта канцелярии, ADR-0113). Секреты
   * наружу через API по-прежнему не отдаются: это внутренний вызов.
   */
  async enabledOfKind(kind: string): Promise<
    Array<{
      id: string
      key: string
      kind: string
      name: string
      config: Record<string, unknown>
      secrets: Record<string, string>
      lastSyncAt: string | null
    }>
  > {
    const rows = await db()
      .select({ row: integrations, title: objects.title })
      .from(integrations)
      .innerJoin(objects, eq(objects.id, integrations.id))
      .where(
        sql`${objects.deletedAt} is null and ${integrations.kind} = ${kind} and ${integrations.enabled}`,
      )
      .orderBy(integrations.key)
    return rows.map(({ row, title }) => ({
      id: row.id,
      key: row.key,
      kind: row.kind,
      name: title,
      config: row.config,
      secrets: readSecrets(row),
      lastSyncAt: row.lastSyncAt,
    }))
  },

  /** Интеграция по стабильному ключу — для пакета конфигурации. */
  async byKey(key: string): Promise<{ row: IntegrationRow; title: string } | null> {
    const [found] = await db()
      .select({ row: integrations, title: objects.title })
      .from(integrations)
      .innerJoin(objects, eq(objects.id, integrations.id))
      .where(eq(integrations.key, key))
      .limit(1)
    return found ?? null
  },

  async create(ctx: UserCtx, input: IntegrationCreateInput): Promise<Integration> {
    const existing = await Integrations.byKey(input.key)
    if (existing) throw errors.conflict(`Интеграция с ключом «${input.key}» уже есть`)

    const id = newId()
    await db().transaction(async (tx) => {
      await ObjectService.create(tx, ctx, {
        id,
        type: 'integration',
        spaceId: null,
        title: input.name,
        meta: { kind: input.kind, key: input.key },
      })
      await tx.insert(integrations).values({
        id,
        key: input.key,
        kind: input.kind,
        enabled: input.enabled,
        description: input.description ?? null,
        config: input.config,
        secrets: writeSecrets(input.secrets),
        inboundEnabled: input.inboundEnabled,
      })
      await publishEvent(tx, ctx, {
        type: 'integration.created',
        object: { id, type: 'integration', title: input.name },
        payload: { key: input.key, kind: input.kind },
      })
    })

    await audit(ctx, {
      action: AUDIT_ACTIONS.integrationCreated,
      objectId: id,
      objectType: 'integration',
      severity: 'notice',
      details: { key: input.key, kind: input.kind, secretKeys: Object.keys(input.secrets) },
    })
    return Integrations.get(id)
  },

  async update(ctx: UserCtx, id: string, input: IntegrationUpdateInput): Promise<Integration> {
    const found = await rowWithTitle(id)
    if (!found) throw errors.notFound('Интеграция')

    const changed: string[] = []
    const patch: Partial<typeof integrations.$inferInsert> = { updatedAt: sql`now()` as never }
    if (input.description !== undefined) {
      patch.description = input.description
      changed.push('description')
    }
    if (input.enabled !== undefined) {
      patch.enabled = input.enabled
      patch.status = input.enabled ? 'unknown' : 'disabled'
      changed.push('enabled')
    }
    if (input.config !== undefined) {
      patch.config = input.config
      changed.push('config')
    }
    if (input.inboundEnabled !== undefined) {
      patch.inboundEnabled = input.inboundEnabled
      if (!input.inboundEnabled) patch.inboundSecretHash = null
      changed.push('inboundEnabled')
    }
    if (input.secrets !== undefined) {
      const current = readSecrets(found.row)
      for (const [key, value] of Object.entries(input.secrets)) {
        if (value === null) delete current[key]
        else current[key] = value
      }
      patch.secrets = writeSecrets(current)
      changed.push('secrets')
    }

    await db().transaction(async (tx) => {
      if (input.name !== undefined && input.name !== found.title) {
        await ObjectService.update(tx, ctx, id, { title: input.name })
        changed.push('name')
      }
      await tx.update(integrations).set(patch).where(eq(integrations.id, id))
      await publishEvent(tx, ctx, {
        type: 'integration.updated',
        object: { id, type: 'integration', title: input.name ?? found.title },
        payload: { key: found.row.key, changed },
      })
    })

    await audit(ctx, {
      action: AUDIT_ACTIONS.integrationUpdated,
      objectId: id,
      objectType: 'integration',
      severity: 'notice',
      // В аудит идут только имена изменённых полей: значения секретов не пишутся
      details: { key: found.row.key, changed },
    })
    return Integrations.get(id)
  },

  async remove(ctx: UserCtx, id: string): Promise<void> {
    const found = await rowWithTitle(id)
    if (!found) throw errors.notFound('Интеграция')
    await db().transaction(async (tx) => {
      await ObjectService.purge(tx, ctx, id)
    })
    await audit(ctx, {
      action: AUDIT_ACTIONS.integrationDeleted,
      objectId: id,
      objectType: 'integration',
      severity: 'notice',
      details: { key: found.row.key },
    })
  },

  /** Кнопка «Проверить соединение»: запись реестра или встроенная служба. */
  async check(ctx: UserCtx, id: string): Promise<IntegrationCheckResult> {
    const found = await rowWithTitle(id)
    if (!found) throw errors.notFound('Интеграция')
    const result = await checkIntegration(found.row, readSecrets(found.row))
    const checkedAt = new Date().toISOString()

    await db().transaction(async (tx) => {
      await tx
        .update(integrations)
        .set({
          status: result.ok ? 'ok' : 'error',
          statusMessage: result.message,
          lastCheckAt: sql`now()` as never,
        })
        .where(eq(integrations.id, id))
      if (!result.ok) {
        await publishEvent(tx, ctx, {
          type: 'integration.failed',
          object: { id, type: 'integration', title: found.title },
          payload: { key: found.row.key, kind: found.row.kind, error: result.message },
        })
      }
    })

    await audit(ctx, {
      action: AUDIT_ACTIONS.integrationChecked,
      objectId: id,
      objectType: 'integration',
      details: { key: found.row.key, ok: result.ok },
    })
    return { ...result, checkedAt }
  },

  /** Проверка встроенной службы установки (SMTP, Telegram). */
  async checkBuiltin(ctx: UserCtx, key: string): Promise<IntegrationCheckResult> {
    const result = await checkBuiltin(key)
    await audit(ctx, {
      action: AUDIT_ACTIONS.integrationChecked,
      objectType: 'integration',
      details: { key, builtin: true, ok: result.ok },
    })
    return { ...result, checkedAt: new Date().toISOString() }
  },

  /**
   * Выпускает секрет входящего вебхука. В базе — только хэш; полный адрес
   * показывается один раз, как токен API.
   */
  async rotateInboundSecret(ctx: UserCtx, id: string): Promise<{ url: string; secret: string }> {
    const found = await rowWithTitle(id)
    if (!found) throw errors.notFound('Интеграция')
    const secret = randomBytes(24).toString('base64url')
    await db()
      .update(integrations)
      .set({ inboundEnabled: true, inboundSecretHash: hashToken(secret) })
      .where(eq(integrations.id, id))
    await audit(ctx, {
      action: AUDIT_ACTIONS.integrationSecretRotated,
      objectId: id,
      objectType: 'integration',
      severity: 'notice',
      details: { key: found.row.key },
    })
    return { url: `${config().KCHS_API_URL}/api/v1/hooks/${id}/${secret}`, secret }
  },

  async syncs(id: string, limit = 50): Promise<IntegrationSync[]> {
    const rows = await db()
      .select()
      .from(integrationSyncs)
      .where(eq(integrationSyncs.integrationId, id))
      .orderBy(desc(integrationSyncs.startedAt))
      .limit(limit)
    return rows.map((row) => ({
      id: row.id,
      integrationId: row.integrationId,
      status: row.status as IntegrationSync['status'],
      message: row.message,
      stats: row.stats,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    }))
  },

  /**
   * Запись в журнал синхронизаций. Вызывается из обработчиков интеграций
   * в их транзакции: событие `integration.synced` уходит через outbox.
   */
  async recordSync(
    tx: Executor,
    ctx: Ctx,
    input: {
      integrationId: string
      key: string
      kind: string
      status: 'ok' | 'error'
      message?: string | null
      stats?: Record<string, unknown>
    },
  ): Promise<void> {
    await tx.insert(integrationSyncs).values({
      id: newId(),
      integrationId: input.integrationId,
      status: input.status,
      message: input.message ?? null,
      stats: input.stats ?? {},
      finishedAt: sql`now()` as never,
    })
    await tx
      .update(integrations)
      .set({
        lastSyncAt: sql`now()` as never,
        status: input.status === 'ok' ? 'ok' : 'error',
        statusMessage: input.message ?? null,
      })
      .where(eq(integrations.id, input.integrationId))
    await publishEvent(tx, ctx, {
      type: input.status === 'ok' ? 'integration.synced' : 'integration.failed',
      object: { id: input.integrationId, type: 'integration' },
      payload:
        input.status === 'ok'
          ? { key: input.key, kind: input.kind, stats: input.stats ?? {} }
          : { key: input.key, kind: input.kind, error: input.message ?? 'ошибка' },
    })
  },
}
