import type { AccessReason, Level } from '@kchs/contracts'
import { and, eq, ne, or, type SQL, sql } from 'drizzle-orm'
import type { UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, processInstances, processSteps } from '~/shared/db/schema/index.js'
import type { ObjectLike, TypePolicy } from '../access/types.js'

/**
 * Производное право участника маршрута видеть объект (03-access-model.md,
 * источник №5: «участник согласования видит версию»; ADR-0079). Политику
 * подключает модуль в описании своего типа объекта:
 *
 *   policy: withProcessParticipants(documentPolicy, { afterStep: 'view' })
 *
 * Участник — назначенный шага (кроме получателей уведомлений), заместитель —
 * через замещаемого. `afterStep: 'view'` — право остаётся после шага (лист
 * согласования), `'none'` — только пока шаг идёт.
 */
export interface ProcessParticipantOptions {
  afterStep?: 'view' | 'none'
}

const REASON: AccessReason = {
  kind: 'type_policy',
  level: 'view',
  messageKey: 'access.reason.process_step',
  params: {},
}

/** Условие «пользователь — назначенный шага» по GIN-индексу `assignees`. */
function assigneeOf(userIds: readonly string[]): SQL {
  const conditions = userIds.map(
    (userId) => sql`${processSteps.assignees} @> ${JSON.stringify([{ userId }])}::jsonb`,
  )
  return (conditions.length === 1 ? conditions[0] : or(...conditions)) as SQL
}

function stepScope(options: ProcessParticipantOptions): SQL {
  const participant = ne(processSteps.kind, 'notify')
  return options.afterStep === 'none'
    ? (and(participant, eq(processSteps.status, 'active')) as SQL)
    : participant
}

function people(ctx: UserCtx): string[] {
  return [ctx.userId, ...ctx.principals.actingFor.map((item) => item.userId)]
}

export function processParticipantPolicy(
  options: ProcessParticipantOptions = {},
): Required<Pick<TypePolicy, 'derive' | 'visibleSql' | 'principals'>> {
  return {
    derive: async (ctx, object) => {
      const [row] = await db()
        .select({ id: processSteps.id })
        .from(processSteps)
        .innerJoin(processInstances, eq(processInstances.id, processSteps.instanceId))
        .where(
          and(
            eq(processInstances.objectId, object.id),
            stepScope(options),
            assigneeOf(people(ctx)),
          ),
        )
        .limit(1)
      return row ? [{ level: 'view' as Level, reason: REASON }] : []
    },
    visibleSql: (ctx) =>
      sql`${objects.id} IN (
        SELECT ${processInstances.objectId} FROM ${processInstances}
          JOIN ${processSteps} ON ${processSteps.instanceId} = ${processInstances.id}
         WHERE ${stepScope(options)} AND ${assigneeOf(people(ctx))}
      )`,
    principals: async (object: ObjectLike, executor: Executor) => {
      const rows = await executor
        .select({ assignees: processSteps.assignees })
        .from(processSteps)
        .innerJoin(processInstances, eq(processInstances.id, processSteps.instanceId))
        .where(and(eq(processInstances.objectId, object.id), stepScope(options)))
      const ids = new Set<string>()
      for (const row of rows) {
        for (const entry of row.assignees) {
          if (typeof entry.userId === 'string') ids.add(`user:${entry.userId}`)
        }
      }
      return [...ids]
    },
  }
}

/** Политика типа модуля с правом участников маршрута: уровни — максимум, SQL — «или». */
export function withProcessParticipants(
  policy: TypePolicy | undefined,
  options: ProcessParticipantOptions = {},
): TypePolicy {
  const participants = processParticipantPolicy(options)
  return {
    ...policy,
    derive: async (ctx, object) => [
      ...((await policy?.derive?.(ctx, object)) ?? []),
      ...(await participants.derive(ctx, object)),
    ],
    visibleSql: (ctx) => {
      const own = policy?.visibleSql?.(ctx) ?? null
      const derived = participants.visibleSql(ctx) as SQL
      return own ? sql`(${own} OR ${derived})` : derived
    },
    principals: async (object, executor) => [
      ...((await policy?.principals?.(object, executor)) ?? []),
      ...(await participants.principals(object, executor)),
    ],
  }
}
