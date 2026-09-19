import type { InboxCounts, InboxItem, InboxKind, InboxState, Locale } from '@kchs/contracts'
import { createTranslator } from '@kchs/i18n'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { delegations, inboxItems, users } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { cacheKeys, redis } from '~/shared/redis/index.js'
import { directory } from '../directory/port.js'
import { publishEvent } from '../events/publisher.js'
import { ObjectService } from '../objects/service.js'
import { emitToUser } from '../realtime/gateway.js'
import { inboxActionHandler } from './actions.js'

export interface OpenInboxInput {
  userId: string
  kind: InboxKind
  objectId?: string | null
  processStepId?: string | null
  titleKey: string
  params?: Record<string, unknown>
  dueAt?: string | null
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  payload?: Record<string, unknown>
  /** Ключ дедупликации: повторное открытие того же дела не создаёт дубль. */
  dedupeKey?: string | null
  /** Доступные действия. */
  actions?: InboxItem['actions']
}

/**
 * Входящие — «от вас требуется действие» (12-calendar-notifications-home.md §3).
 * Закрываются автоматически по событию выполнения действия.
 */
export const InboxService = {
  async open(tx: Executor, ctx: Ctx, input: OpenInboxInput): Promise<string> {
    const dedupeKey = input.dedupeKey ?? `${input.kind}:${input.objectId ?? ''}`
    const id = newId()

    const inserted = await tx
      .insert(inboxItems)
      .values({
        id,
        userId: input.userId,
        kind: input.kind,
        objectId: input.objectId ?? null,
        processStepId: input.processStepId ?? null,
        titleKey: input.titleKey,
        params: input.params ?? {},
        actorId: actorId(ctx),
        dueAt: input.dueAt ?? null,
        priority: input.priority ?? 'normal',
        state: 'open',
        dedupeKey,
        payload: { ...(input.payload ?? {}), actions: input.actions ?? defaultActions(input.kind) },
      })
      .onConflictDoNothing()
      .returning({ id: inboxItems.id })

    if (inserted.length === 0) return id

    // Дублирование заместителям в пределах области замещения
    const deputies = await activeDeputies(tx, input.userId, input.kind)
    for (const deputy of deputies) {
      await tx
        .insert(inboxItems)
        .values({
          id: newId(),
          userId: deputy,
          kind: input.kind,
          objectId: input.objectId ?? null,
          processStepId: input.processStepId ?? null,
          titleKey: input.titleKey,
          params: input.params ?? {},
          actorId: actorId(ctx),
          onBehalfOf: input.userId,
          dueAt: input.dueAt ?? null,
          priority: input.priority ?? 'normal',
          state: 'open',
          dedupeKey: `${dedupeKey}:for:${input.userId}`,
          payload: {
            ...(input.payload ?? {}),
            actions: input.actions ?? defaultActions(input.kind),
          },
        })
        .onConflictDoNothing()
    }

    await publishEvent(tx, ctx, {
      type: 'inbox.opened',
      object: input.objectId ? { id: input.objectId, type: 'object' } : null,
      payload: { userId: input.userId, kind: input.kind, itemId: id },
    })

    await invalidateCounts([input.userId, ...deputies])
    return id
  },

  /**
   * Закрытие по факту действия — из любого места (UI/API/Telegram).
   * Закрывает и копии, выданные заместителям.
   */
  async resolve(
    tx: Executor,
    ctx: Ctx,
    selector: {
      objectId?: string
      kind?: InboxKind
      processStepId?: string
      userId?: string
      /** Одно дело из нескольких у объекта (правка слоя): его ключ и копии заместителей. */
      dedupeKey?: string
    },
    outcome: 'resolved' | 'dismissed' = 'resolved',
    resolution?: string,
  ): Promise<number> {
    const conditions = [inArray(inboxItems.state, ['open', 'snoozed'])]
    if (selector.objectId) conditions.push(eq(inboxItems.objectId, selector.objectId))
    if (selector.dedupeKey) {
      conditions.push(
        or(
          eq(inboxItems.dedupeKey, selector.dedupeKey),
          sql`starts_with(${inboxItems.dedupeKey}, ${`${selector.dedupeKey}:for:`})`,
        )!,
      )
    }
    if (selector.kind) conditions.push(eq(inboxItems.kind, selector.kind))
    if (selector.processStepId)
      conditions.push(eq(inboxItems.processStepId, selector.processStepId))
    if (selector.userId) {
      conditions.push(
        or(eq(inboxItems.userId, selector.userId), eq(inboxItems.onBehalfOf, selector.userId))!,
      )
    }

    const affected = await tx
      .update(inboxItems)
      .set({ state: outcome, resolvedAt: sql`now()`, resolution: resolution ?? null })
      .where(and(...conditions))
      .returning({ id: inboxItems.id, userId: inboxItems.userId })

    // Событие — каждому получателю: закрытие по объекту касается всех его дел
    for (const item of affected) {
      await publishEvent(tx, ctx, {
        type: 'inbox.resolved',
        object: selector.objectId ? { id: selector.objectId, type: 'object' } : null,
        payload: { userId: item.userId, itemId: item.id, outcome },
      })
    }
    if (affected.length > 0) await invalidateCounts(affected.map((a) => a.userId))
    return affected.length
  },

  /**
   * Действие над элементом: кнопка Входящих или ответ из Telegram. Исполняет
   * модуль, открывший элемент (`registerInboxActionHandler`); копия заместителя
   * действует от имени получателя, пока замещение активно.
   */
  async act(
    ctx: UserCtx,
    itemId: string,
    input: {
      action: string
      comment?: string | undefined
      payload?: Record<string, unknown> | undefined
    },
  ): Promise<void> {
    const [row] = await db()
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.id, itemId), eq(inboxItems.userId, ctx.userId)))
      .limit(1)
    if (!row) throw errors.notFound('Элемент Входящих')
    if (row.state !== 'open' && row.state !== 'snoozed') {
      throw errors.conflict('Элемент Входящих уже закрыт')
    }
    const kind = row.kind as InboxKind
    const actions =
      (row.payload as { actions?: InboxItem['actions'] }).actions ?? defaultActions(kind)
    const action = actions.find((item) => item.key === input.action)
    if (!action) throw errors.validation('Нет такого действия у элемента Входящих')
    const comment = input.comment?.trim()
    if (action.requiresComment && !comment) throw errors.validation('Нужен комментарий')
    const handler = inboxActionHandler(kind)
    if (!handler) throw errors.validation('Это действие выполняется в карточке объекта')

    let actor: UserCtx = ctx
    if (row.onBehalfOf) {
      const acting = ctx.principals.actingFor.some((item) => item.userId === row.onBehalfOf)
      if (!acting) throw errors.forbidden('Замещение закончилось — действие недоступно')
      actor = { ...ctx, onBehalfOf: row.onBehalfOf }
    }
    await handler(actor, {
      item: {
        id: row.id,
        kind,
        objectId: row.objectId,
        processStepId: row.processStepId,
        userId: row.userId,
        onBehalfOf: row.onBehalfOf,
        payload: row.payload,
      },
      action: action.key,
      ...(comment ? { comment } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
    })
  },

  async snooze(ctx: UserCtx, itemId: string, until: string): Promise<void> {
    const [item] = await db()
      .select()
      .from(inboxItems)
      .where(and(eq(inboxItems.id, itemId), eq(inboxItems.userId, ctx.userId)))
      .limit(1)
    if (!item) throw errors.notFound('Элемент Входящих')

    await db()
      .update(inboxItems)
      .set({ state: 'snoozed', snoozedUntil: until })
      .where(eq(inboxItems.id, itemId))
    await invalidateCounts([ctx.userId])
  },

  async list(
    ctx: UserCtx,
    query: {
      state?: InboxState
      kind?: InboxKind
      scope?: 'all' | 'mine' | 'delegated'
      due?: 'any' | 'overdue' | 'today' | 'week'
      limit?: number
      cursor?: string
    },
  ): Promise<{ items: InboxItem[]; nextCursor: string | null }> {
    const limit = Math.min(query.limit ?? 50, 100)
    const conditions = [eq(inboxItems.userId, ctx.userId)]

    if (query.state) conditions.push(eq(inboxItems.state, query.state))
    if (query.kind) conditions.push(eq(inboxItems.kind, query.kind))
    if (query.scope === 'mine') conditions.push(isNull(inboxItems.onBehalfOf))
    if (query.scope === 'delegated') conditions.push(sql`${inboxItems.onBehalfOf} is not null`)
    if (query.due === 'overdue') conditions.push(sql`${inboxItems.dueAt} < now()`)
    if (query.due === 'today') {
      conditions.push(sql`${inboxItems.dueAt}::date = current_date`)
    }
    if (query.due === 'week') {
      conditions.push(sql`${inboxItems.dueAt} < now() + interval '7 days'`)
    }
    if (query.cursor) conditions.push(sql`${inboxItems.openedAt} < ${query.cursor}`)

    const rows = await db()
      .select()
      .from(inboxItems)
      .where(and(...conditions))
      .orderBy(
        sql`CASE ${inboxItems.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`,
        sql`${inboxItems.dueAt} asc nulls last`,
        desc(inboxItems.openedAt),
      )
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    const objectIds = [
      ...new Set(page.map((r) => r.objectId).filter((v): v is string => Boolean(v))),
    ]
    const summaries = await ObjectService.summaries(objectIds)
    const userIds = [
      ...new Set(
        page.flatMap((r) => [r.actorId, r.onBehalfOf]).filter((v): v is string => Boolean(v)),
      ),
    ]
    const refs = await directory().refs(userIds)
    const t = createTranslator(ctx.locale as Locale)

    return {
      items: page.map((row) => ({
        id: row.id,
        userId: row.userId,
        kind: row.kind as InboxKind,
        title: t(row.titleKey, {
          ...(row.params as Record<string, string>),
          title: row.objectId ? (summaries.get(row.objectId)?.title ?? '') : '',
        }),
        body: null,
        object: row.objectId ? (summaries.get(row.objectId) ?? null) : null,
        actor: row.actorId ? (refs.get(row.actorId) ?? null) : null,
        onBehalfOf: row.onBehalfOf ? (refs.get(row.onBehalfOf) ?? null) : null,
        processStepId: row.processStepId,
        dueAt: row.dueAt,
        priority: row.priority as InboxItem['priority'],
        state: row.state as InboxState,
        openedAt: row.openedAt,
        resolvedAt: row.resolvedAt,
        snoozedUntil: row.snoozedUntil,
        payload: row.payload,
        actions:
          (row.payload as { actions?: InboxItem['actions'] }).actions ??
          defaultActions(row.kind as InboxKind),
      })),
      nextCursor: hasMore ? (page[page.length - 1]?.openedAt ?? null) : null,
    }
  },

  async counts(userId: string): Promise<InboxCounts> {
    const cached = await redis().get(cacheKeys.inboxCounts(userId))
    if (cached) return JSON.parse(cached) as InboxCounts

    const rows = await db()
      .select({
        kind: inboxItems.kind,
        total: sql<number>`count(*)::int`,
        overdue: sql<number>`count(*) filter (where ${inboxItems.dueAt} < now())::int`,
        dueToday: sql<number>`count(*) filter (where ${inboxItems.dueAt}::date = current_date)::int`,
        delegated: sql<number>`count(*) filter (where ${inboxItems.onBehalfOf} is not null)::int`,
      })
      .from(inboxItems)
      .where(and(eq(inboxItems.userId, userId), eq(inboxItems.state, 'open')))
      .groupBy(inboxItems.kind)

    const counts: InboxCounts = {
      total: rows.reduce((sum, r) => sum + r.total, 0),
      overdue: rows.reduce((sum, r) => sum + r.overdue, 0),
      dueToday: rows.reduce((sum, r) => sum + r.dueToday, 0),
      delegated: rows.reduce((sum, r) => sum + r.delegated, 0),
      byKind: Object.fromEntries(rows.map((r) => [r.kind, r.total])),
    }

    await redis().setex(cacheKeys.inboxCounts(userId), 60, JSON.stringify(counts))
    return counts
  },

  /** Отложенные элементы, срок которых наступил (обслуживание). */
  async wakeSnoozed(): Promise<number> {
    const rows = await db()
      .update(inboxItems)
      .set({ state: 'open', snoozedUntil: null })
      .where(and(eq(inboxItems.state, 'snoozed'), sql`${inboxItems.snoozedUntil} <= now()`))
      .returning({ userId: inboxItems.userId })
    await invalidateCounts(rows.map((r) => r.userId))
    return rows.length
  },
}

function defaultActions(kind: InboxKind): InboxItem['actions'] {
  switch (kind) {
    case 'approve':
      return [
        {
          key: 'approve',
          labelKey: 'inbox.actions.approve',
          variant: 'primary',
          requiresComment: false,
        },
        {
          key: 'remarks',
          labelKey: 'inbox.actions.remarks',
          variant: 'secondary',
          requiresComment: true,
        },
        {
          key: 'reject',
          labelKey: 'inbox.actions.reject',
          variant: 'danger',
          requiresComment: true,
        },
      ]
    case 'sign':
      return [
        { key: 'sign', labelKey: 'inbox.actions.sign', variant: 'primary', requiresComment: false },
      ]
    case 'acknowledge':
      return [
        {
          key: 'acknowledge',
          labelKey: 'inbox.actions.acknowledge',
          variant: 'primary',
          requiresComment: false,
        },
      ]
    case 'accept_instruction':
      return [
        {
          key: 'accept',
          labelKey: 'inbox.actions.accept',
          variant: 'primary',
          requiresComment: false,
        },
      ]
    case 'report_instruction':
      return [
        {
          key: 'report',
          labelKey: 'inbox.actions.report',
          variant: 'primary',
          requiresComment: true,
        },
      ]
    default:
      return [
        {
          key: 'open',
          labelKey: 'inbox.actions.open',
          variant: 'secondary',
          requiresComment: false,
        },
      ]
  }
}

const SCOPE_BY_KIND: Record<string, string[]> = {
  approve: ['all', 'approvals', 'documents'],
  sign: ['all', 'approvals', 'documents'],
  resolve: ['all', 'documents'],
  acknowledge: ['all', 'documents'],
  register: ['all', 'documents'],
  revise: ['all', 'documents'],
  accept_instruction: ['all', 'instructions'],
  report_instruction: ['all', 'instructions'],
  accept_result: ['all', 'instructions'],
  respond_invite: ['all', 'meetings'],
  review_protocol: ['all', 'meetings'],
}

/** Замещение с областью `scope` распространяется на дела вида `kind`. */
export function delegationCovers(kind: InboxKind, scope: string): boolean {
  return (SCOPE_BY_KIND[kind] ?? ['all']).includes(scope)
}

async function activeDeputies(tx: Executor, userId: string, kind: InboxKind): Promise<string[]> {
  const scopes = SCOPE_BY_KIND[kind] ?? ['all']
  const rows = await tx
    .select({ toUserId: delegations.toUserId })
    .from(delegations)
    .innerJoin(users, eq(users.id, delegations.toUserId))
    .where(
      and(
        eq(delegations.fromUserId, userId),
        eq(delegations.status, 'active'),
        eq(users.status, 'active'),
        inArray(delegations.scope, scopes),
        sql`${delegations.startsAt} <= now() AND ${delegations.endsAt} > now()`,
      ),
    )
  return rows.map((r) => r.toUserId)
}

async function invalidateCounts(userIds: string[]): Promise<void> {
  for (const userId of [...new Set(userIds)]) {
    await redis().del(cacheKeys.inboxCounts(userId))
    const counts = await InboxService.counts(userId)
    emitToUser(userId, 'inbox.changed', { counts })
  }
}
