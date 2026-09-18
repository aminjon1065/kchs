import type { Space, SpaceCreateInput, SpaceKind, SpaceMember, SpaceRole } from '@kchs/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { type Database, db, type Executor } from '~/shared/db/client.js'
import {
  employments,
  objects,
  orgUnits,
  positions,
  spaceMembers,
  spaces,
  users,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { bumpPrincipalsVersion, invalidatePrincipalSet } from '../access/principal-set.js'
import { publishEvent } from '../events/publisher.js'
import { ObjectService } from '../objects/service.js'

/**
 * Пространство — контейнер совместной работы и единица «где это лежит»
 * (02-platform-kernel.md §2). Пространство само является объектом реестра.
 */
export const SpaceService = {
  async create(
    tx: Executor,
    ctx: Ctx,
    input: Omit<SpaceCreateInput, 'kind'> & { kind?: SpaceKind; ownerId?: string },
  ): Promise<string> {
    const existing = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(eq(spaces.key, input.key))
      .limit(1)
    if (existing.length > 0) throw errors.conflict('Пространство с таким кодом уже существует')

    const owner = input.ownerId ?? actorId(ctx)
    const object = await ObjectService.create(tx, ctx, {
      type: 'space',
      spaceId: null,
      title: input.name,
      subtitle: input.description ?? null,
      icon: input.settings?.icon ?? null,
      ownerId: owner,
      meta: { kind: input.kind ?? 'team', key: input.key },
      silent: true,
    })

    // Пространство принадлежит самому себе: объекты в нём ссылаются на этот id
    await tx.update(objects).set({ spaceId: object.id }).where(eq(objects.id, object.id))

    await tx.insert(spaces).values({
      id: object.id,
      key: input.key,
      kind: input.kind ?? 'team',
      unitId: input.unitId ?? null,
      description: input.description ?? null,
      settings: {
        defaultVisibility: 'space',
        ...(input.settings ?? {}),
      },
    })

    if (owner) {
      await tx.insert(spaceMembers).values({
        spaceId: object.id,
        userId: owner,
        role: 'admin',
        addedBy: actorId(ctx),
      })
      await invalidatePrincipalSet(owner)
    }

    await publishEvent(tx, ctx, {
      type: 'space.created',
      object: { id: object.id, type: 'space', spaceId: object.id, title: input.name },
      payload: { key: input.key, kind: input.kind ?? 'team' },
    })

    return object.id
  },

  /** Личное пространство создаётся автоматически вместе с пользователем. */
  async ensurePersonal(
    tx: Executor,
    ctx: Ctx,
    userId: string,
    _displayName: string,
  ): Promise<string> {
    const existing = await tx
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.kind, 'personal'), sql`${spaces.settings}->>'ownerId' = ${userId}`))
      .limit(1)
    if (existing[0]) return existing[0].id

    const key = `u-${userId.replace(/-/g, '').slice(-12)}`
    return SpaceService.create(tx, ctx, {
      key,
      name: 'Моё пространство',
      kind: 'personal',
      ownerId: userId,
      settings: { defaultVisibility: 'private', ownerId: userId } as never,
    })
  },

  async addMember(
    tx: Executor,
    ctx: Ctx,
    spaceId: string,
    userId: string,
    role: SpaceRole,
  ): Promise<void> {
    await tx
      .insert(spaceMembers)
      .values({ spaceId, userId, role, addedBy: actorId(ctx) })
      .onConflictDoUpdate({
        target: [spaceMembers.spaceId, spaceMembers.userId],
        set: { role },
      })
    await invalidatePrincipalSet(userId)
    await publishEvent(tx, ctx, {
      type: 'space.member_added',
      object: { id: spaceId, type: 'space', spaceId },
      payload: { userId, role },
    })
  },

  async removeMember(tx: Executor, ctx: Ctx, spaceId: string, userId: string): Promise<void> {
    await tx
      .delete(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
    await invalidatePrincipalSet(userId)
    await publishEvent(tx, ctx, {
      type: 'space.member_removed',
      object: { id: spaceId, type: 'space', spaceId },
      payload: { userId },
    })
  },

  async setMemberRole(
    tx: Executor,
    ctx: Ctx,
    spaceId: string,
    userId: string,
    role: SpaceRole,
  ): Promise<void> {
    const [current] = await tx
      .select({ role: spaceMembers.role })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
      .limit(1)
    if (!current) throw errors.notFound('Участник пространства')

    await tx
      .update(spaceMembers)
      .set({ role })
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))
    await invalidatePrincipalSet(userId)
    await publishEvent(tx, ctx, {
      type: 'space.member_role_changed',
      object: { id: spaceId, type: 'space', spaceId },
      payload: { userId, role, from: current.role },
    })
  },

  async listForUser(ctx: UserCtx, database: Database = db()): Promise<Space[]> {
    const memberships = Object.keys(ctx.principals.spaceRoles)
    const rows = await database
      .select({
        id: spaces.id,
        key: spaces.key,
        kind: spaces.kind,
        unitId: spaces.unitId,
        description: spaces.description,
        settings: spaces.settings,
        title: objects.title,
        ownerId: objects.ownerId,
        createdAt: objects.createdAt,
        updatedAt: objects.updatedAt,
      })
      .from(spaces)
      .innerJoin(objects, eq(objects.id, spaces.id))
      .where(
        ctx.isSystemAdmin
          ? sql`${objects.deletedAt} is null`
          : and(
              sql`${objects.deletedAt} is null`,
              memberships.length > 0
                ? sql`(${inArray(spaces.id, memberships)} OR ${spaces.kind} = 'org')`
                : eq(spaces.kind, 'org'),
            ),
      )

    const counts = await database
      .select({ spaceId: spaceMembers.spaceId, count: sql<number>`count(*)::int` })
      .from(spaceMembers)
      .groupBy(spaceMembers.spaceId)
    const countMap = new Map(counts.map((c) => [c.spaceId, c.count]))

    return rows.map((row) => ({
      id: row.id,
      key: row.key,
      name: row.title,
      kind: row.kind as SpaceKind,
      unitId: row.unitId,
      ownerId: row.ownerId,
      description: row.description,
      settings: row.settings as Space['settings'],
      memberCount: countMap.get(row.id) ?? 0,
      myRole: (ctx.principals.spaceRoles[row.id] as SpaceRole | undefined) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
  },

  async members(spaceId: string, database: Database = db()): Promise<SpaceMember[]> {
    const rows = await database
      .select({
        spaceId: spaceMembers.spaceId,
        userId: spaceMembers.userId,
        role: spaceMembers.role,
        addedAt: spaceMembers.addedAt,
        displayName: users.displayName,
        avatarFileId: users.avatarFileId,
        positionName: positions.name,
        unitName: orgUnits.name,
      })
      .from(spaceMembers)
      .innerJoin(users, eq(users.id, spaceMembers.userId))
      .leftJoin(employments, and(eq(employments.userId, users.id), eq(employments.isPrimary, true)))
      .leftJoin(positions, eq(positions.id, employments.positionId))
      .leftJoin(orgUnits, eq(orgUnits.id, employments.unitId))
      .where(eq(spaceMembers.spaceId, spaceId))

    return rows.map((row) => ({
      spaceId: row.spaceId,
      userId: row.userId,
      role: row.role as SpaceRole,
      displayName: row.displayName,
      avatarUrl: row.avatarFileId ? `/api/v1/files/${row.avatarFileId}/content` : null,
      position: row.positionName?.ru ?? null,
      unitName: row.unitName?.ru ?? null,
      addedAt: row.addedAt,
    }))
  },

  async get(spaceId: string, ctx: UserCtx, database: Database = db()): Promise<Space | null> {
    const list = await SpaceService.listForUser(ctx, database)
    return list.find((s) => s.id === spaceId) ?? null
  },
}

export async function invalidateAllPrincipals(): Promise<void> {
  await bumpPrincipalsVersion()
}
