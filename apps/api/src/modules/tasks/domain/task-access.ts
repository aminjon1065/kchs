import { type Level, maxLevel, SPACE_ROLE_DEFAULT_LEVEL, type SpaceRole } from '@kchs/contracts'
import { eq } from 'drizzle-orm'
import { grantAccess, readPrincipalsFor, revokeAccess } from '~/kernel/access/acl-service.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import type { Executor } from '~/shared/db/client.js'
import { tasks } from '~/shared/db/schema/index.js'

interface Participants {
  assigneeId: string | null
  coAssignees: readonly string[]
  controllerId: string | null
}

/** Участники с правом правки: исполнитель, соисполнители, контролёр (автор — владелец объекта). */
export function participantsOf(row: Participants): string[] {
  return [
    ...new Set(
      [row.assigneeId, ...row.coAssignees, row.controllerId].filter(
        (id): id is string => typeof id === 'string',
      ),
    ),
  ]
}

/**
 * Права участников — записями ACL объекта (ADR-0060): так задачу одинаково
 * видят списки, поиск, realtime и проверка `authorize()`. Выдача тихая —
 * о назначении сообщает сам модуль, а не «с вами поделились».
 */
export async function syncParticipants(
  tx: Executor,
  ctx: Ctx,
  taskId: string,
  ownerId: string | null,
  before: readonly string[],
  after: readonly string[],
): Promise<void> {
  const wanted = new Set(after.filter((id) => id !== ownerId))
  const had = new Set(before.filter((id) => id !== ownerId))
  const added = [...wanted].filter((id) => !had.has(id))
  const removed = [...had].filter((id) => !wanted.has(id))
  if (added.length > 0) {
    await grantAccess(
      tx,
      ctx,
      taskId,
      added.map((id) => ({ principal: { type: 'user' as const, id }, level: 'edit' as const })),
      { quiet: true },
    )
  }
  for (const id of removed) await revokeAccess(tx, ctx, taskId, { type: 'user', id })
}

/**
 * Кто видит задачу — принципалы из прав ядра (как фильтр поиска). Нужен
 * системному датасету `tasks`: строки ограничивает пересечение с
 * принципалами смотрящего.
 */
export async function refreshViewers(executor: Executor, taskId: string): Promise<void> {
  const principals = await readPrincipalsFor(taskId, executor)
  await executor.update(tasks).set({ viewers: principals }).where(eq(tasks.id, taskId))
}

/**
 * Оценка уровня для списков — без запроса прав на каждую строку: владелец,
 * участник, роль в пространстве при наследовании. Кнопки карточки считает
 * точный `authorize()`, а каждое действие сервер проверяет заново.
 */
export function approximateLevel(
  ctx: UserCtx,
  row: Participants & {
    ownerId: string | null
    authorId: string | null
    accessMode: string
    spaceId: string | null
  },
): Level {
  const ids = new Set([ctx.userId, ...(ctx.onBehalfOf ? [ctx.onBehalfOf] : [])])
  if (row.ownerId && ids.has(row.ownerId)) return 'owner'
  let level: Level = 'view'
  if (participantsOf(row).some((id) => ids.has(id))) level = 'edit'
  if (row.authorId && ids.has(row.authorId)) level = maxLevel(level, 'manage')
  const role = row.spaceId ? ctx.principals.spaceRoles[row.spaceId] : undefined
  if (role && row.accessMode !== 'restricted') {
    level = maxLevel(level, SPACE_ROLE_DEFAULT_LEVEL[role as SpaceRole] ?? 'view')
  }
  return level
}
