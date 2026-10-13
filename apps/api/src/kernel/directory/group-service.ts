import type { UserRef } from '@kchs/contracts'
import { asc, eq, sql } from 'drizzle-orm'
import { bumpPrincipalsVersion } from '~/kernel/access/principal-set.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { groupMembers, groups } from '~/kernel/directory/schema.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { recheckUserRooms } from '~/kernel/realtime/gateway.js'
import type { Ctx } from '~/shared/context.js'
import { afterCommit, type Database, db, type Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { UserService } from './service.js'

/** Группы сотрудников (ADR-0144): состав с записью в аудит, правка и список. */

export const GroupService = {
  async list(database: Database = db()) {
    const rows = await database.select().from(groups).orderBy(asc(groups.name))
    const counts = await database
      .select({ groupId: groupMembers.groupId, count: sql<number>`count(*)::int` })
      .from(groupMembers)
      .groupBy(groupMembers.groupId)
    const countMap = new Map(counts.map((c) => [c.groupId, c.count]))
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind as 'static' | 'system',
      spaceId: row.spaceId,
      description: row.description,
      memberCount: countMap.get(row.id) ?? 0,
    }))
  },

  /** Группа, её событие и аудит — в транзакции вызывающего (ADR-0177). */
  async create(tx: Tx, ctx: Ctx, name: string, description?: string | null): Promise<string> {
    const id = newId()
    await tx.insert(groups).values({ id, name, description: description ?? null })
    await publishEvent(tx, ctx, {
      type: 'org.group_changed',
      object: { id, type: 'group', title: name },
      payload: { groupId: id, change: 'created' },
    })
    await audit(
      ctx,
      { action: AUDIT_ACTIONS.groupCreated, objectId: id, objectType: 'group', details: { name } },
      tx,
    )
    return id
  },

  /**
   * Состав группы меняет права участников (ADR-0177): событие и аудит с теми, кого
   * добавили и убрали, — в транзакции; кэш принципалов сбрасывается после фиксации,
   * комнаты realtime исключённых перепроверяются (ADR-0169).
   */
  async setMembers(
    tx: Tx,
    ctx: Ctx,
    groupId: string,
    userIds: string[],
  ): Promise<{ added: string[]; removed: string[] }> {
    const before = new Set(
      (
        await tx
          .select({ userId: groupMembers.userId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, groupId))
      ).map((row) => row.userId),
    )
    const after = new Set(userIds)
    const added = [...after].filter((userId) => !before.has(userId))
    const removed = [...before].filter((userId) => !after.has(userId))
    if (added.length === 0 && removed.length === 0) return { added, removed }

    await tx.delete(groupMembers).where(eq(groupMembers.groupId, groupId))
    if (after.size > 0) {
      await tx.insert(groupMembers).values([...after].map((userId) => ({ groupId, userId })))
    }
    await publishEvent(tx, ctx, {
      type: 'org.group_changed',
      object: { id: groupId, type: 'group' },
      payload: { groupId, change: 'members', added, removed },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.groupMembersChanged,
        objectId: groupId,
        objectType: 'group',
        severity: 'notice',
        details: { added, removed },
      },
      tx,
    )
    await bumpPrincipalsVersion(tx)
    if (removed.length > 0) {
      await afterCommit(tx, () => Promise.all(removed.map((userId) => recheckUserRooms(userId))))
    }
    return { added, removed }
  },

  /** Состав группы — сотрудники по имени; для консоли (N86). */
  async members(groupId: string, database: Database = db()): Promise<UserRef[]> {
    const rows = await database
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId))
    const refs = await UserService.refs(
      rows.map((row) => row.userId),
      database,
    )
    return [...refs.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru'))
  },

  /** Группа для правки из консоли: системную (состав считает платформа) менять нельзя. */
  async editable(database: Database, groupId: string): Promise<{ name: string }> {
    const [row] = await database
      .select({ name: groups.name, kind: groups.kind })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1)
    if (!row) throw errors.notFound('Группа')
    if (row.kind === 'system') {
      throw errors.validation(
        'Системная группа ведётся платформой: её состав и название не меняются',
      )
    }
    return { name: row.name }
  },

  async update(
    tx: Tx,
    ctx: Ctx,
    groupId: string,
    patch: { name?: string | undefined; description?: string | null | undefined },
  ): Promise<void> {
    const current = await GroupService.editable(tx, groupId)
    await tx
      .update(groups)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
      })
      .where(eq(groups.id, groupId))
    await publishEvent(tx, ctx, {
      type: 'org.group_changed',
      object: { id: groupId, type: 'group', title: patch.name ?? current.name },
      payload: { groupId, change: 'updated' },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.groupUpdated,
        objectId: groupId,
        objectType: 'group',
        details: patch,
      },
      tx,
    )
  },
}
