import type { AccessReason, Level } from '@kchs/contracts'
import { arrayContains, arrayOverlaps, eq, type SQL, sql } from 'drizzle-orm'
import { UNIT_HEAD_PRINCIPAL, unitHeadPrincipalsOf } from '~/kernel/access/principal-set.js'
import type { TypePolicy } from '~/kernel/access/types.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects, tasks } from '~/shared/db/schema/index.js'

/** Области замещения, в которых заместитель действует по поручениям. */
const INSTRUCTION_SCOPES = new Set(['all', 'instructions'])

/**
 * Кого замещает пользователь в режиме «от имени» (заголовок или копия дела во
 * Входящих): только в пределах активного замещения с областью поручений.
 */
export function actingParticipant(ctx: UserCtx): string | null {
  const target = ctx.onBehalfOf
  if (!target) return null
  const active = ctx.principals.actingFor.some(
    (item) => item.userId === target && INSTRUCTION_SCOPES.has(item.scope),
  )
  return active ? target : null
}

/** Ключи `unit_head:<id>` подразделений, которые возглавляет пользователь. */
export function headKeysOf(ctx: UserCtx): string[] {
  return (ctx.principals.headedUnitIds ?? []).map((id) => `${UNIT_HEAD_PRINCIPAL}:${id}`)
}

/** Причина доступа по политике задач: текст — свой ключ словаря («Руководитель исполнителя»). */
const reason = (level: Level, key: 'assignee_manager' | 'acting_participant'): AccessReason => ({
  kind: 'type_policy',
  level,
  messageKey: `access.reason.${key}`,
  params: {},
  sourceObjectId: null,
})

/**
 * Политика типа `task` (03-access-model.md §5, ADR-0082):
 * - руководитель видит поручения подчинённых — транзитивно, только просмотр:
 *   поручению выдаются принципалы `unit_head:<id>` всех подразделений его
 *   исполнителя, руководитель получает свои при входе; так одинаково работают
 *   `authorize()`, списки, поиск и системные датасеты;
 * - заместитель в режиме «от имени» действует за участника поручения (автора,
 *   исполнителя, соисполнителя, контролёра) с уровнем правки — кнопки решают
 *   роли замещаемого (`permissionsFor`).
 */
export const taskPolicy: TypePolicy = {
  principals: async (object, executor) => {
    const [row] = await executor
      .select({ kind: tasks.kind, assigneeId: tasks.assigneeId })
      .from(tasks)
      .where(eq(tasks.id, object.id))
      .limit(1)
    if (row?.kind !== 'instruction' || !row.assigneeId) return []
    return unitHeadPrincipalsOf(row.assigneeId, executor)
  },

  derive: async (ctx, object) => {
    const heads = new Set(headKeysOf(ctx))
    const acting = actingParticipant(ctx)
    if (heads.size === 0 && !acting) return []
    const [row] = await db()
      .select({
        kind: tasks.kind,
        authorId: tasks.authorId,
        assigneeId: tasks.assigneeId,
        coAssignees: tasks.coAssignees,
        controllerId: tasks.controllerId,
        viewers: tasks.viewers,
      })
      .from(tasks)
      .where(eq(tasks.id, object.id))
      .limit(1)
    if (row?.kind !== 'instruction') return []
    const result: Array<{ level: Level; reason: AccessReason }> = []
    const participants = [row.authorId, row.assigneeId, row.controllerId, ...row.coAssignees]
    if (acting && participants.includes(acting)) {
      result.push({ level: 'edit', reason: reason('edit', 'acting_participant') })
    }
    if (heads.size > 0 && row.viewers.some((key) => heads.has(key))) {
      result.push({ level: 'view', reason: reason('view', 'assignee_manager') })
    }
    return result
  },

  visibleSql: (ctx) => {
    const heads = headKeysOf(ctx)
    const acting = actingParticipant(ctx)
    const conditions: SQL[] = []
    if (heads.length > 0) conditions.push(arrayOverlaps(tasks.viewers, heads))
    if (acting) conditions.push(arrayContains(tasks.viewers, [`user:${acting}`]))
    if (conditions.length === 0) return null
    return sql`${objects.id} IN (SELECT ${tasks.id} FROM ${tasks}
      WHERE ${tasks.kind} = 'instruction' AND (${sql.join(conditions, sql` OR `)}))`
  },
}
