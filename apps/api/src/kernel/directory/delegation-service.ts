import { and, desc, eq, or, sql } from 'drizzle-orm'
import { invalidatePrincipalSet } from '~/kernel/access/principal-set.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { delegations, users } from '~/kernel/directory/schema.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { UserCtx } from '~/shared/context.js'
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

  async stop(tx: Tx, ctx: UserCtx, id: string): Promise<void> {
    const [row] = await tx.select().from(delegations).where(eq(delegations.id, id)).limit(1)
    // Постороннему замещение не видно — 404, как недоступный объект (ADR-0187);
    // заместитель о нём знает, ему — понятный отказ
    const party = row && (row.fromUserId === ctx.userId || row.toUserId === ctx.userId)
    if (!row || (!party && !ctx.isSystemAdmin)) throw errors.notFound('Замещение')
    if (row.fromUserId !== ctx.userId && !ctx.isSystemAdmin) {
      throw errors.forbidden('Замещение может завершить только назначивший его')
    }

    await tx
      .update(delegations)
      .set({ status: 'finished', endsAt: sql`now()` })
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
      },
      tx,
    )
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

    const userIds = [...new Set(rows.flatMap((r) => [r.fromUserId, r.toUserId]))]
    const refs = await UserService.refs(userIds, database)

    return rows.map((row) => ({
      id: row.id,
      fromUser: refs.get(row.fromUserId)!,
      toUser: refs.get(row.toUserId)!,
      scope: row.scope as 'all' | 'approvals' | 'instructions' | 'documents' | 'meetings',
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      note: row.note,
    }))
  },
}
