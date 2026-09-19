import type {
  AcknowledgmentEntry,
  AcknowledgmentRequestRecord,
  AcknowledgmentSource,
  InboxAction,
  ObjectAcknowledgments,
  UserRef,
} from '@kchs/contracts'
import { and, desc, eq, inArray, isNull, lt, or, type SQL, sql } from 'drizzle-orm'
import { actorId, type Ctx, type UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { acknowledgmentRequests, acknowledgments } from '~/shared/db/schema/index.js'
import { AppError, errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { authorize, loadObject } from '../access/authorize.js'
import { clearedUsers, effectiveConfidentiality } from '../access/confidentiality.js'
import type { ObjectLike } from '../access/types.js'
import { AUDIT_ACTIONS, audit } from '../audit/service.js'
import { directory } from '../directory/port.js'
import { publishEvent } from '../events/publisher.js'
import { InboxService } from '../inbox/service.js'
import { ProcessService } from '../process/service.js'
import { confirmSecondFactor } from '../second-factor/port.js'

/**
 * Ознакомление с объектом (08-documents.md §10, ADR-0084) — общий механизм
 * ядра для документов и страниц базы знаний. Одна правда «кто и когда
 * ознакомился»: запросы из карточки и правилом типа открывают дела Входящих
 * `acknowledge`; шаг маршрута `acknowledge` открывает свои дела, а учёт ведёт
 * наблюдатель движка процессов в той же транзакции (`processAcknowledgments`).
 * Отметка любым путём закрывает все ожидания сотрудника по объекту, кроме
 * требующих кода второго фактора — их закрывает только отметка с кодом.
 */

/** Ознакомление ждёт: ни отметки, ни снятия. */
const PENDING = and(isNull(acknowledgments.acknowledgedAt), isNull(acknowledgments.cancelledAt))

/** Повторное напоминание одному сотруднику — не чаще раза в час. */
const REMIND_INTERVAL_MS = 60 * 60 * 1000

/** Ключ дела Входящих: одно дело на сотрудника и объект, сколько бы ни было запросов. */
const inboxKey = (objectId: string) => `ack:${objectId}`

/** Кнопка дела: «Ознакомлен», с кодом второго фактора, если запрос его требует. */
export function acknowledgeAction(requireSecondFactor: boolean): InboxAction {
  return {
    key: 'acknowledge',
    labelKey: 'inbox.actions.acknowledge',
    variant: 'primary',
    requiresComment: false,
    ...(requireSecondFactor ? { requiresSecondFactor: true } : {}),
  }
}

export interface AcknowledgmentRequestSpec {
  objectId: string
  source: AcknowledgmentSource
  userIds?: readonly string[]
  unitIds?: readonly string[]
  groupIds?: readonly string[]
  dueAt?: Date | string | null
  requireSecondFactor?: boolean
  note?: string | null
  /** Шаг маршрута `acknowledge`: учёт ведёт движок, Входящие открывает он же. */
  processStepId?: string | null
}

export interface AcknowledgmentRequestOutcome {
  requestId: string | null
  added: string[]
  skipped: Array<{ userId: string; reason: 'clearance' | 'pending' }>
}

const unique = (ids: Iterable<string>) => [...new Set(ids)]

function eventObject(object: ObjectLike) {
  return { id: object.id, type: object.type, spaceId: object.spaceId, title: object.title }
}

/** Сотрудники запроса: люди, подразделения (с вложенными) и группы — только активные. */
async function expandTargets(spec: AcknowledgmentRequestSpec): Promise<string[]> {
  const [fromUnits, fromGroups] = await Promise.all([
    Promise.all((spec.unitIds ?? []).map((id) => directory().unitMembers(id))),
    Promise.all((spec.groupIds ?? []).map((id) => directory().groupMembers(id))),
  ])
  const all = unique([...(spec.userIds ?? []), ...fromUnits.flat(), ...fromGroups.flat()])
  return all.length > 0 ? directory().activeUsers(all) : []
}

/** Отметить ожидания сотрудника; вернуть идентификаторы их запросов. */
async function markAcknowledged(
  tx: Executor,
  rowIds: string[],
  mark: { actorId: string | null; secondFactor: boolean },
): Promise<string[]> {
  if (rowIds.length === 0) return []
  const rows = await tx
    .update(acknowledgments)
    .set({ acknowledgedAt: sql`now()`, actorId: mark.actorId, secondFactor: mark.secondFactor })
    .where(and(inArray(acknowledgments.id, rowIds), PENDING))
    .returning({ requestId: acknowledgments.requestId })
  return unique(rows.map((row) => row.requestId))
}

export const Acknowledgments = {
  /**
   * Запрос ознакомления в транзакции вызывающего: сотрудники без допуска к
   * грифу объекта и те, кого ознакомление уже ждёт, пропускаются (кроме шага
   * маршрута — он решает сам). Остальным — дела Входящих (кроме шага маршрута:
   * их открывает движок) и событие `acknowledgment.requested`.
   */
  async request(
    tx: Executor,
    ctx: Ctx,
    spec: AcknowledgmentRequestSpec,
  ): Promise<AcknowledgmentRequestOutcome> {
    const object = await loadObject(spec.objectId, tx)
    if (!object || object.deletedAt) throw errors.notFound()
    const fromProcess = spec.source === 'process'
    const people = fromProcess ? unique(spec.userIds ?? []) : await expandTargets(spec)

    const skipped: AcknowledgmentRequestOutcome['skipped'] = []
    let targets = people
    if (!fromProcess && people.length > 0) {
      const grif = await effectiveConfidentiality(object.id, tx)
      const cleared = new Set(await clearedUsers(people, grif, tx))
      const waiting = await tx
        .select({ userId: acknowledgments.userId })
        .from(acknowledgments)
        .where(
          and(
            eq(acknowledgments.objectId, object.id),
            inArray(acknowledgments.userId, people),
            PENDING,
          ),
        )
      const pending = new Set(waiting.map((row) => row.userId))
      targets = []
      for (const userId of people) {
        if (!cleared.has(userId)) skipped.push({ userId, reason: 'clearance' })
        else if (pending.has(userId)) skipped.push({ userId, reason: 'pending' })
        else targets.push(userId)
      }
    }
    if (targets.length === 0 && !fromProcess) return { requestId: null, added: [], skipped }

    const requestId = newId()
    const dueAt = spec.dueAt ? new Date(spec.dueAt).toISOString() : null
    const requireSecondFactor = !fromProcess && Boolean(spec.requireSecondFactor)
    await tx.insert(acknowledgmentRequests).values({
      id: requestId,
      objectId: object.id,
      source: spec.source,
      processStepId: spec.processStepId ?? null,
      requestedBy: actorId(ctx),
      dueAt,
      requireSecondFactor,
      note: spec.note ?? null,
    })
    if (targets.length > 0) {
      await tx.insert(acknowledgments).values(
        targets.map((userId) => ({
          id: newId(),
          requestId,
          objectId: object.id,
          userId,
          source: spec.source,
          dueAt,
        })),
      )
    }
    if (!fromProcess) {
      for (const userId of targets) {
        await InboxService.open(tx, ctx, {
          userId,
          kind: 'acknowledge',
          objectId: object.id,
          titleKey: 'inbox.tpl.acknowledge',
          dueAt,
          dedupeKey: inboxKey(object.id),
          actions: [acknowledgeAction(requireSecondFactor)],
        })
      }
    }
    await publishEvent(tx, ctx, {
      type: 'acknowledgment.requested',
      object: eventObject(object),
      payload: { requestId, source: spec.source, userIds: targets, dueAt },
    })
    return { requestId, added: targets, skipped }
  },

  /**
   * Отметка «Ознакомлен» (карточка, Входящие, API): все ожидания сотрудника
   * по объекту. Если хоть одно требует кода второго фактора — код вводит тот,
   * кто нажимает (при замещении — заместитель). Ожидания шага маршрута
   * отмечаются решением шага (`ProcessService.act`) — маршрут идёт дальше.
   */
  async acknowledge(
    tx: Executor,
    ctx: UserCtx,
    objectId: string,
    input: { code?: string | undefined } = {},
  ): Promise<void> {
    const userId = ctx.onBehalfOf ?? ctx.userId
    const object = await loadObject(objectId, tx)
    if (!object || object.deletedAt) throw errors.notFound()
    // Заместитель отмечает от имени того, кого просили ознакомиться: объект
    // видит замещаемый (ожидание выдано ему)
    const view = await authorize(ctx, 'view', object, { soft: true })
    if (!view.allowed && !ctx.onBehalfOf) throw errors.notFound()

    const rows = await tx
      .select({
        id: acknowledgments.id,
        requestId: acknowledgments.requestId,
        processStepId: acknowledgmentRequests.processStepId,
        requireSecondFactor: acknowledgmentRequests.requireSecondFactor,
      })
      .from(acknowledgments)
      .innerJoin(acknowledgmentRequests, eq(acknowledgmentRequests.id, acknowledgments.requestId))
      .where(
        and(eq(acknowledgments.objectId, objectId), eq(acknowledgments.userId, userId), PENDING),
      )
      .for('update', { of: acknowledgments })
    if (rows.length === 0) {
      if (!view.allowed) throw errors.notFound()
      throw errors.conflict('Ознакомление не требуется или уже отмечено')
    }
    const secondFactor = rows.some((row) => row.requireSecondFactor)
    if (secondFactor) await confirmSecondFactor(ctx.userId, input.code)

    const requestIds = await markAcknowledged(
      tx,
      rows.map((row) => row.id),
      { actorId: ctx.userId !== userId ? ctx.userId : null, secondFactor },
    )
    // Дела Входящих запросов закрываются отметкой; дело шага — решением шага
    await InboxService.resolve(
      tx,
      ctx,
      { objectId, kind: 'acknowledge', userId },
      'resolved',
      'acknowledged',
    )
    for (const stepId of unique(rows.flatMap((row) => row.processStepId ?? []))) {
      try {
        await ProcessService.act(tx, ctx, { stepId, action: 'acknowledge' })
      } catch (error) {
        // Шаг уже не ждёт решения (маршрут ушёл дальше) — отметка остаётся в силе
        if (!(error instanceof AppError && error.status === 409)) throw error
      }
    }
    await publishEvent(tx, ctx, {
      type: 'acknowledgment.acknowledged',
      object: eventObject(object),
      payload: { userId, requestIds, secondFactor },
    })
    if (secondFactor || ctx.onBehalfOf) {
      await audit(
        ctx,
        {
          action: AUDIT_ACTIONS.objectAcknowledged,
          objectId,
          objectType: object.type,
          details: { userId, requestIds, secondFactor },
        },
        tx,
      )
    }
  },

  /**
   * Напомнить не ознакомившимся (всем или выбранным): не чаще раза в час
   * одному сотруднику; уведомления шлёт подписчик `acknowledgment.reminded`.
   */
  async remind(
    tx: Executor,
    ctx: Ctx,
    objectId: string,
    options: { userIds?: readonly string[] | undefined; auto?: boolean } = {},
  ): Promise<string[]> {
    const object = await loadObject(objectId, tx)
    if (!object || object.deletedAt) throw errors.notFound()
    const conditions: SQL[] = [
      eq(acknowledgments.objectId, objectId),
      PENDING as SQL,
      or(
        isNull(acknowledgments.remindedAt),
        lt(acknowledgments.remindedAt, new Date(Date.now() - REMIND_INTERVAL_MS).toISOString()),
      ) as SQL,
    ]
    if (options.userIds) {
      if (options.userIds.length === 0) return []
      conditions.push(inArray(acknowledgments.userId, [...options.userIds]))
    }
    const rows = await tx
      .update(acknowledgments)
      .set({ remindedAt: sql`now()`, reminders: sql`${acknowledgments.reminders} + 1` })
      .where(and(...conditions))
      .returning({ userId: acknowledgments.userId })
    const userIds = unique(rows.map((row) => row.userId))
    if (userIds.length === 0) return []
    await publishEvent(tx, ctx, {
      type: 'acknowledgment.reminded',
      object: eventObject(object),
      payload: { userIds, auto: Boolean(options.auto) },
    })
    return userIds
  },

  /** Сотрудники с ожиданием или отметкой по объекту (не снятые) — права участников. */
  async usersOf(executor: Executor, objectId: string): Promise<string[]> {
    const rows = await executor
      .selectDistinct({ userId: acknowledgments.userId })
      .from(acknowledgments)
      .where(and(eq(acknowledgments.objectId, objectId), isNull(acknowledgments.cancelledAt)))
    return rows.map((row) => row.userId)
  },

  /** Ждёт ли ознакомление сотрудника и нужен ли код. */
  async pendingFor(
    executor: Executor,
    objectId: string,
    userId: string,
  ): Promise<{ pending: boolean; requireSecondFactor: boolean }> {
    const rows = await executor
      .select({ requireSecondFactor: acknowledgmentRequests.requireSecondFactor })
      .from(acknowledgments)
      .innerJoin(acknowledgmentRequests, eq(acknowledgmentRequests.id, acknowledgments.requestId))
      .where(
        and(eq(acknowledgments.objectId, objectId), eq(acknowledgments.userId, userId), PENDING),
      )
    return {
      pending: rows.length > 0,
      requireSecondFactor: rows.some((row) => row.requireSecondFactor),
    }
  },

  /**
   * Вкладка «Ознакомление»: по сотруднику — ждёт ли он (хотя бы один открытый
   * запрос) или когда ознакомился; запросы с итогами; права смотрящего.
   * Отправить и напомнить может тот, кому тип объекта разрешает действие
   * `request_acknowledgment` (у документа — право правки).
   */
  async list(ctx: UserCtx, objectId: string): Promise<ObjectAcknowledgments> {
    await authorize(ctx, 'view', objectId)
    const [requests, rows, can, mine] = await Promise.all([
      db()
        .select()
        .from(acknowledgmentRequests)
        .where(eq(acknowledgmentRequests.objectId, objectId))
        .orderBy(desc(acknowledgmentRequests.requestedAt)),
      db().select().from(acknowledgments).where(eq(acknowledgments.objectId, objectId)),
      authorize(ctx, 'request_acknowledgment', objectId, { soft: true }),
      Acknowledgments.pendingFor(db(), objectId, ctx.onBehalfOf ?? ctx.userId),
    ])
    const people = await directory().refs(
      unique([
        ...rows.flatMap((row) => [row.userId, ...(row.actorId ? [row.actorId] : [])]),
        ...requests.flatMap((request) => (request.requestedBy ? [request.requestedBy] : [])),
      ]),
    )
    const person = (id: string | null): UserRef | null => (id ? (people.get(id) ?? null) : null)
    const now = Date.now()

    const byUser = new Map<string, typeof rows>()
    for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row])
    const items: AcknowledgmentEntry[] = []
    for (const [userId, own] of byUser) {
      const user = person(userId)
      if (!user) continue
      const open = own.filter((row) => !row.acknowledgedAt && !row.cancelledAt)
      const done = own
        .filter((row) => row.acknowledgedAt)
        .sort((a, b) => String(b.acknowledgedAt).localeCompare(String(a.acknowledgedAt)))
      const last = done[0] ?? null
      const state = open.length > 0 ? 'pending' : last ? 'acknowledged' : 'cancelled'
      const dues = open.flatMap((row) => (row.dueAt ? [row.dueAt] : [])).sort()
      const dueAt = dues[0] ?? null
      const reminded = own
        .flatMap((row) => (row.remindedAt ? [row.remindedAt] : []))
        .sort()
        .reverse()
      items.push({
        user,
        state,
        sources: unique(own.map((row) => row.source)) as AcknowledgmentSource[],
        requiredAt: (open[0] ?? last ?? own[0])?.requiredAt ?? new Date().toISOString(),
        dueAt,
        overdue: state === 'pending' && dueAt !== null && new Date(dueAt).getTime() < now,
        acknowledgedAt: state === 'acknowledged' ? (last?.acknowledgedAt ?? null) : null,
        actor: state === 'acknowledged' ? person(last?.actorId ?? null) : null,
        secondFactor: state === 'acknowledged' ? Boolean(last?.secondFactor) : false,
        remindedAt: reminded[0] ?? null,
        reminders: own.reduce((sum, row) => sum + row.reminders, 0),
      })
    }
    // Сначала просроченные и ждущие, затем ознакомившиеся; внутри — по имени
    const order = (entry: AcknowledgmentEntry) =>
      entry.overdue ? 0 : entry.state === 'pending' ? 1 : entry.state === 'acknowledged' ? 2 : 3
    items.sort(
      (a, b) => order(a) - order(b) || a.user.displayName.localeCompare(b.user.displayName, 'ru'),
    )

    const records: AcknowledgmentRequestRecord[] = requests.map((request) => {
      const own = rows.filter((row) => row.requestId === request.id && !row.cancelledAt)
      return {
        id: request.id,
        source: request.source as AcknowledgmentSource,
        requestedBy: person(request.requestedBy),
        requestedAt: request.requestedAt,
        dueAt: request.dueAt,
        requireSecondFactor: request.requireSecondFactor,
        note: request.note,
        total: own.length,
        acknowledged: own.filter((row) => row.acknowledgedAt).length,
        cancelledAt: request.cancelledAt,
      }
    })

    const active = items.filter((item) => item.state !== 'cancelled')
    return {
      items,
      requests: records,
      summary: {
        total: active.length,
        acknowledged: active.filter((item) => item.state === 'acknowledged').length,
        pending: active.filter((item) => item.state === 'pending').length,
        overdue: active.filter((item) => item.overdue).length,
      },
      mine,
      can: { request: can.allowed, remind: can.allowed },
    }
  },
}
