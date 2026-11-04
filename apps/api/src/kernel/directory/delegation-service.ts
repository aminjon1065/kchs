import { and, asc, desc, eq, gt, lte, or, sql } from 'drizzle-orm'
import { hasCapability } from '~/kernel/access/authorize.js'
import { invalidatePrincipalSet } from '~/kernel/access/principal-set.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { delegations, users } from '~/kernel/directory/schema.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { type Ctx, systemCtx, type UserCtx } from '~/shared/context.js'
import { type Database, db, type Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { UserService } from './service.js'

/** Делегирование (03-access-model.md §Делегирование): замещения на срок и по области. */

export const DelegationService = {
  async create(
    tx: Tx,
    ctx: UserCtx,
    input: {
      toUserId: string
      scope: string
      startsAt: string
      endsAt: string
      note?: string | null
    },
    fromUserId = ctx.userId,
  ): Promise<string> {
    if (input.toUserId === fromUserId) throw errors.validation('Нельзя назначить заместителем себя')
    if (new Date(input.endsAt) <= new Date()) {
      throw errors.validation('Замещение уже закончилось бы: дата окончания — в прошлом')
    }
    const [deputy] = await tx
      .select({ kind: users.kind })
      .from(users)
      .where(eq(users.id, input.toUserId))
      .limit(1)
    if (!deputy) throw errors.validation('Нет такого сотрудника')
    // Замещение — работа человека: служебная запись не получает дел (ADR-0130)
    if (deputy.kind === 'service') {
      throw errors.validation('Заместителем назначают сотрудника, а не служебную запись')
    }
    if (new Date(input.endsAt) <= new Date(input.startsAt)) {
      throw errors.validation('Дата окончания должна быть позже начала')
    }

    const id = newId()
    await tx.insert(delegations).values({
      id,
      fromUserId,
      toUserId: input.toUserId,
      scope: input.scope,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      note: input.note ?? null,
      status: 'active',
      createdBy: ctx.userId,
    })

    await invalidatePrincipalSet(input.toUserId, tx)
    await publishEvent(tx, ctx, {
      type: 'delegation.started',
      object: { id, type: 'delegation' },
      payload: { fromUserId, toUserId: input.toUserId, scope: input.scope },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.delegationStarted,
        objectId: id,
        objectType: 'delegation',
        details: { fromUserId, toUserId: input.toUserId, scope: input.scope },
        severity: 'notice',
      },
      tx,
    )
    return id
  },

  /**
   * Завершить действующее или отменить запланированное замещение (ADR-0229): сам
   * отсутствующий, администратор системы или кадры (`users.manage`) — например, когда
   * отсутствующий заболел и сам в систему не войдёт.
   */
  async stop(tx: Tx, ctx: UserCtx, id: string): Promise<void> {
    const [row] = await tx.select().from(delegations).where(eq(delegations.id, id)).limit(1)
    const manager = ctx.isSystemAdmin || hasCapability(ctx, 'users.manage')
    // Постороннему замещение не видно — 404, как недоступный объект (ADR-0187);
    // заместитель о нём знает, ему — понятный отказ
    const party = row && (row.fromUserId === ctx.userId || row.toUserId === ctx.userId)
    if (!row || (!party && !manager)) throw errors.notFound('Замещение')
    if (row.fromUserId !== ctx.userId && !manager) {
      throw errors.forbidden('Замещение может завершить только назначивший его')
    }
    if (row.status !== 'active') return

    // Ещё не началось — отмена без смены срока; идёт — окончание сейчас
    const upcoming = new Date(row.startsAt) > new Date()
    await tx
      .update(delegations)
      .set(upcoming ? { status: 'cancelled' } : { status: 'finished', endsAt: sql`now()` })
      .where(eq(delegations.id, id))
    await invalidatePrincipalSet(row.toUserId, tx)

    await publishEvent(tx, ctx, {
      type: 'delegation.ended',
      object: { id, type: 'delegation' },
      payload: { fromUserId: row.fromUserId, toUserId: row.toUserId },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.delegationEnded,
        objectId: id,
        objectType: 'delegation',
        severity: 'notice',
        ...(upcoming ? { details: { cancelled: true } } : {}),
      },
      tx,
    )
  },

  /**
   * Срок замещений истёк сам — у них нет события «закончилось», а копии дел у
   * заместителя по нему закрываются (ADR-0229). Задание `delegations.sync`.
   */
  async expireDue(): Promise<Array<{ fromUserId: string; toUserId: string }>> {
    return db().transaction(async (tx) => {
      const ended = await tx
        .update(delegations)
        .set({ status: 'finished' })
        .where(and(eq(delegations.status, 'active'), lte(delegations.endsAt, sql`now()`)))
        .returning({
          id: delegations.id,
          fromUserId: delegations.fromUserId,
          toUserId: delegations.toUserId,
        })
      const ctx: Ctx = systemCtx('delegations.sync')
      for (const row of ended) {
        await invalidatePrincipalSet(row.toUserId, tx)
        await publishEvent(tx, ctx, {
          type: 'delegation.ended',
          object: { id: row.id, type: 'delegation' },
          payload: { fromUserId: row.fromUserId, toUserId: row.toUserId },
        })
      }
      return ended.map(({ fromUserId, toUserId }) => ({ fromUserId, toUserId }))
    })
  },

  /** Пары «отсутствующий → заместитель» действующих сейчас замещений. */
  async effectivePairs(): Promise<Array<{ fromUserId: string; toUserId: string }>> {
    const rows = await db()
      .selectDistinct({ fromUserId: delegations.fromUserId, toUserId: delegations.toUserId })
      .from(delegations)
      .where(
        and(
          eq(delegations.status, 'active'),
          lte(delegations.startsAt, sql`now()`),
          gt(delegations.endsAt, sql`now()`),
        ),
      )
    return rows
  },

  /**
   * Замещения сотрудника для профиля и консоли: действующие и запланированные
   * (ADR-0229) — запланированное видно заранее, его можно отменить.
   */
  async listFor(userId: string, database: Database = db()) {
    const rows = await database
      .select()
      .from(delegations)
      .where(
        and(
          eq(delegations.status, 'active'),
          or(eq(delegations.toUserId, userId), eq(delegations.fromUserId, userId)),
          gt(delegations.endsAt, sql`now()`),
        ),
      )
      .orderBy(asc(delegations.startsAt))
    return toDelegations(rows, database)
  },

  async activeFor(userId: string, database: Database = db()) {
    const rows = await database
      .select()
      .from(delegations)
      .where(
        and(
          eq(delegations.status, 'active'),
          or(eq(delegations.toUserId, userId), eq(delegations.fromUserId, userId)),
          sql`${delegations.startsAt} <= now() AND ${delegations.endsAt} > now()`,
        ),
      )
      .orderBy(desc(delegations.startsAt))

    return toDelegations(rows, database)
  },
}

async function toDelegations(rows: Array<typeof delegations.$inferSelect>, database: Database) {
  const userIds = [...new Set(rows.flatMap((r) => [r.fromUserId, r.toUserId]))]
  const refs = await UserService.refs(userIds, database)
  const now = Date.now()
  return rows.map((row) => ({
    id: row.id,
    fromUser: refs.get(row.fromUserId)!,
    toUser: refs.get(row.toUserId)!,
    scope: row.scope as 'all' | 'approvals' | 'instructions' | 'documents' | 'meetings',
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    note: row.note,
    upcoming: new Date(row.startsAt).getTime() > now,
  }))
}
