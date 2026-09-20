import type {
  AlertCreateInput,
  AlertDefinition,
  AlertEvent,
  AlertEventList,
  AlertEventsQuery,
  AlertList,
  AlertListQuery,
  AlertRecord,
  AlertUpdateInput,
} from '@kchs/contracts'
import { AlertDefinition as AlertDefinitionSchema } from '@kchs/contracts'
import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { nextRunAt } from '~/kernel/schedules/index.js'
import { Metrics } from '~/modules/data/public.js'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { alertEvents, alerts, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'

/**
 * Алерты (06-analytics-engine.md §14, ADR-0104): правило на показатель —
 * объект реестра типа `alert`. Расписание проверки ведёт единый планировщик
 * ядра (ADR-0096): у алерта хранится `next_run_at`, задание-тик выбирает
 * подошедшие.
 */

export interface AlertRow {
  id: string
  metricId: string
  definition: Record<string, unknown>
  enabled: boolean
  cron: string
  timezone: string
  conditionKind: string
  lastCheckedAt: string | null
  lastFiredAt: string | null
  nextRunAt: string | null
  spaceId: string
  parentId: string | null
  ownerId: string | null
  title: string
  createdAt: string
  updatedAt: string
}

const selection = {
  id: alerts.id,
  metricId: alerts.metricId,
  definition: alerts.definition,
  enabled: alerts.enabled,
  cron: alerts.cron,
  timezone: alerts.timezone,
  conditionKind: alerts.conditionKind,
  lastCheckedAt: alerts.lastCheckedAt,
  lastFiredAt: alerts.lastFiredAt,
  nextRunAt: alerts.nextRunAt,
  spaceId: objects.spaceId,
  parentId: objects.parentId,
  ownerId: objects.ownerId,
  title: objects.title,
  createdAt: objects.createdAt,
  updatedAt: objects.updatedAt,
}

const toRow = (row: Record<string, unknown>): AlertRow => ({
  ...(row as unknown as AlertRow),
  spaceId: (row.spaceId as string | null) ?? '',
})

/** Ближайшая проверка по выражению cron алерта; null — расписание неверное. */
export function computeNextRun(definition: AlertDefinition): string | null {
  return nextRunAt(definition.schedule.cron, definition.schedule.timezone)
}

async function metricName(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await db()
    .select({ id: objects.id, title: objects.title })
    .from(objects)
    .where(inArray(objects.id, unique))
  return new Map(rows.map((row) => [row.id, row.title]))
}

export const AlertService = {
  definitionOf(row: AlertRow): AlertDefinition {
    return AlertDefinitionSchema.parse(row.definition)
  },

  async load(executor: Executor, id: string): Promise<AlertRow | null> {
    const [row] = await executor
      .select(selection)
      .from(alerts)
      .innerJoin(objects, eq(objects.id, alerts.id))
      .where(and(eq(alerts.id, id), isNull(objects.deletedAt)))
      .limit(1)
    return row ? toRow(row) : null
  },

  async require(executor: Executor, id: string): Promise<AlertRow> {
    const row = await AlertService.load(executor, id)
    if (!row) throw errors.notFound('Алерт')
    return row
  },

  async create(tx: Executor, ctx: UserCtx, input: AlertCreateInput): Promise<string> {
    const definition = input.definition
    if (!computeNextRun(definition)) throw errors.validation('Неверное выражение расписания')
    // Показатель должен быть виден заводящему: алерт не открывает чужие данные
    await authorize(ctx, 'view', definition.metricId)
    const object = await ObjectService.create(tx, ctx, {
      type: 'alert',
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      title: input.name,
      subtitle: definition.description,
      meta: { enabled: input.enabled, condition: definition.condition.kind },
    })
    await tx.insert(alerts).values({
      id: object.id,
      metricId: definition.metricId,
      definition,
      enabled: input.enabled,
      cron: definition.schedule.cron,
      timezone: definition.schedule.timezone,
      conditionKind: definition.condition.kind,
      nextRunAt: input.enabled ? computeNextRun(definition) : null,
    })
    await LinkService.setDependencies(tx, object.id, [definition.metricId])
    await publishEvent(tx, ctx, {
      type: 'alert.created',
      object: { ...object, type: 'alert' },
      payload: { metricId: definition.metricId, condition: definition.condition.kind },
    })
    return object.id
  },

  async update(tx: Executor, ctx: UserCtx, id: string, input: AlertUpdateInput): Promise<void> {
    const current = await AlertService.require(tx, id)
    const definition = input.definition
    if (!computeNextRun(definition)) throw errors.validation('Неверное выражение расписания')
    await authorize(ctx, 'view', definition.metricId)
    const changed: string[] = ['definition']
    if (input.name !== undefined && input.name !== current.title) {
      await ObjectService.update(tx, ctx, id, { title: input.name })
      changed.push('name')
    }
    await ObjectService.update(
      tx,
      ctx,
      id,
      {
        subtitle: definition.description,
        meta: { condition: definition.condition.kind },
        mergeMeta: true,
      },
      { silent: true },
    )
    await tx
      .update(alerts)
      .set({
        metricId: definition.metricId,
        definition,
        cron: definition.schedule.cron,
        timezone: definition.schedule.timezone,
        conditionKind: definition.condition.kind,
        nextRunAt: current.enabled ? computeNextRun(definition) : null,
        updatedAt: sql`now()`,
      })
      .where(eq(alerts.id, id))
    await LinkService.setDependencies(tx, id, [definition.metricId])
    await publishEvent(tx, ctx, {
      type: 'alert.updated',
      object: await objectRef(tx, id),
      payload: { changed },
    })
  },

  async setEnabled(tx: Executor, ctx: UserCtx, id: string, enabled: boolean): Promise<void> {
    const current = await AlertService.require(tx, id)
    if (current.enabled === enabled) return
    const definition = AlertService.definitionOf(current)
    await tx
      .update(alerts)
      .set({
        enabled,
        nextRunAt: enabled ? computeNextRun(definition) : null,
        updatedAt: sql`now()`,
      })
      .where(eq(alerts.id, id))
    await ObjectService.update(tx, ctx, id, { meta: { enabled }, mergeMeta: true }, { silent: true })
    await publishEvent(tx, ctx, {
      type: enabled ? 'alert.enabled' : 'alert.disabled',
      object: await objectRef(tx, id),
      payload: enabled ? { cron: definition.schedule.cron } : {},
    })
  },

  async get(ctx: UserCtx, id: string): Promise<AlertRecord> {
    await authorize(ctx, 'view', id)
    const row = await AlertService.require(db(), id)
    const definition = AlertService.definitionOf(row)
    const [manage, names] = await Promise.all([
      authorize(ctx, 'manage', id, { soft: true }),
      metricName([row.metricId]),
    ])
    return {
      id: row.id,
      name: row.title,
      spaceId: row.spaceId,
      parentId: row.parentId,
      metricId: row.metricId,
      metricName: names.get(row.metricId) ?? null,
      definition,
      enabled: row.enabled,
      lastCheckedAt: row.lastCheckedAt,
      lastFiredAt: row.lastFiredAt,
      nextRunAt: row.nextRunAt,
      canManage: manage.allowed,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  },

  async list(ctx: UserCtx, query: AlertListQuery): Promise<AlertList> {
    const conditions = [isNull(objects.deletedAt), eq(objects.type, 'alert')]
    if (query.spaceId) conditions.push(eq(objects.spaceId, query.spaceId))
    if (query.metricId) conditions.push(eq(alerts.metricId, query.metricId))
    if (query.enabled !== undefined) conditions.push(eq(alerts.enabled, query.enabled))
    const rows = await db()
      .select(selection)
      .from(alerts)
      .innerJoin(objects, eq(objects.id, alerts.id))
      .where(and(...conditions))
      .orderBy(desc(objects.updatedAt))
      .limit(query.limit)

    const visible: AlertRow[] = []
    for (const row of rows) {
      const decision = await authorize(ctx, 'view', row.id, { soft: true })
      if (decision.allowed) visible.push(toRow(row))
    }
    const [names, fired] = await Promise.all([
      metricName(visible.map((row) => row.metricId)),
      firedToday(visible.map((row) => row.id)),
    ])
    return {
      items: visible.map((row) => ({
        id: row.id,
        name: row.title,
        spaceId: row.spaceId,
        metricId: row.metricId,
        metricName: names.get(row.metricId) ?? null,
        conditionKind: row.conditionKind as AlertList['items'][number]['conditionKind'],
        enabled: row.enabled,
        lastFiredAt: row.lastFiredAt,
        nextRunAt: row.nextRunAt,
        firedToday: fired.get(row.id) ?? 0,
        updatedAt: row.updatedAt,
      })),
    }
  },

  /**
   * История срабатываний: карточка алерта и отметки на графике показателя.
   * Видно её тому, кто видит сам показатель.
   */
  async events(ctx: UserCtx, query: AlertEventsQuery): Promise<AlertEventList> {
    if (!query.alertId && !query.metricId) {
      throw errors.validation('Укажите алерт или показатель')
    }
    if (query.metricId) await authorize(ctx, 'view', query.metricId)
    if (query.alertId) await authorize(ctx, 'view', query.alertId)
    const conditions = [
      ...(query.alertId ? [eq(alertEvents.alertId, query.alertId)] : []),
      ...(query.metricId ? [eq(alertEvents.metricId, query.metricId)] : []),
      ...(query.from ? [gte(alertEvents.firedAt, query.from)] : []),
      ...(query.to ? [lte(alertEvents.firedAt, query.to)] : []),
    ]
    const rows = await db()
      .select({
        event: alertEvents,
        title: objects.title,
      })
      .from(alertEvents)
      .innerJoin(objects, eq(objects.id, alertEvents.alertId))
      .where(and(...conditions, isNull(objects.deletedAt)))
      .orderBy(desc(alertEvents.firedAt))
      .limit(query.limit)

    const items: AlertEvent[] = []
    for (const row of rows) {
      const decision = await authorize(ctx, 'view', row.event.alertId, { soft: true })
      if (!decision.allowed) continue
      items.push({
        id: row.event.id,
        alertId: row.event.alertId,
        alertName: row.title,
        metricId: row.event.metricId,
        firedAt: row.event.firedAt,
        group: {
          key: row.event.groupKey,
          label: row.event.groupLabel,
          values: row.event.groupValues,
        },
        value: row.event.value,
        base: row.event.base,
        score: row.event.score,
        message: row.event.message,
        channels: row.event.channels,
      })
    }
    return { items }
  },

  /** Показатель алерта — для конструктора: разрезы и единица. */
  async metric(ctx: UserCtx, metricId: string) {
    await authorize(ctx, 'view', metricId)
    return Metrics.get(metricId)
  },
}

async function firedToday(alertIds: string[]): Promise<Map<string, number>> {
  if (alertIds.length === 0) return new Map()
  const rows = await db()
    .select({ alertId: alertEvents.alertId, total: sql<number>`count(*)::int` })
    .from(alertEvents)
    .where(
      and(
        inArray(alertEvents.alertId, alertIds),
        sql`${alertEvents.firedAt} > now() - interval '1 day'`,
      ),
    )
    .groupBy(alertEvents.alertId)
  return new Map(rows.map((row) => [row.alertId, Number(row.total)]))
}

export async function objectRef(executor: Executor, id: string) {
  const [row] = await executor
    .select({ id: objects.id, type: objects.type, spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, id))
    .limit(1)
  if (!row) throw errors.notFound('Алерт')
  return row
}
