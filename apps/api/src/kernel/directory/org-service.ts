import type { OrgUnit, OrgUnitInput, OrgUnitPatch } from '@kchs/contracts'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { bumpPrincipalsVersion } from '~/kernel/access/principal-set.js'
import { AUDIT_ACTIONS, audit } from '~/kernel/audit/service.js'
import { employments, orgClosure, orgUnits, users } from '~/kernel/directory/schema.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { SpaceService } from '~/kernel/spaces/service.js'
import type { Ctx } from '~/shared/context.js'
import { type Database, db, type Executor, type Tx } from '~/shared/db/client.js'
import type { LangTextValue } from '~/shared/db/columns.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { UserService } from './service.js'
import { territoryLookup } from './territory-lookup.js'

/**
 * Оргструктура справочника людей (ADR-0179, ADR-0144): подразделения, их дерево и
 * замыкание, руководители и подчинённые.
 */

/**
 * Руководитель подразделения — действующий сотрудник: служебной учётной записи
 * (ADR-0130) дела и эскалации подчинённых приходили бы в пустоту.
 */
async function assertHeadIsPerson(tx: Executor, userId: string | null | undefined): Promise<void> {
  if (!userId) return
  const [row] = await tx
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!row) throw errors.validation('Нет такого сотрудника')
  if (row.kind === 'service') {
    throw errors.validation(
      'Руководителем подразделения назначают сотрудника, а не служебную запись',
    )
  }
}

/** Территория подразделения — из справочника территорий (порт ядра, ADR-0179). */
async function assertTerritory(territoryId: string | null | undefined): Promise<void> {
  if (!territoryId) return
  if (!(await territoryLookup().exists(territoryId)))
    throw errors.validation('Нет такой территории')
}

export const OrgService = {
  async createUnit(tx: Tx, ctx: Ctx, input: OrgUnitInput): Promise<string> {
    await assertTerritory(input.territoryId)
    await assertHeadIsPerson(tx, input.headUserId)
    const id = newId()
    await tx.insert(orgUnits).values({
      id,
      parentId: input.parentId ?? null,
      code: input.code,
      name: input.name,
      kind: input.kind,
      headUserId: input.headUserId ?? null,
      territoryId: input.territoryId ?? null,
      sort: input.sort,
      isActive: input.isActive,
    })
    await rebuildUnitClosure(tx, id, input.parentId ?? null)

    if (input.createSpace) {
      const spaceId = await SpaceService.create(tx, ctx, {
        key: `unit-${input.code.toLowerCase()}`.replace(/[^a-z0-9-]/g, '-'),
        name: input.name.ru,
        kind: 'unit',
        unitId: id,
      })
      await tx.update(orgUnits).set({ spaceId }).where(eq(orgUnits.id, id))
    }

    await publishEvent(tx, ctx, {
      type: 'org.unit_changed',
      object: { id, type: 'unit', title: input.name.ru },
      payload: { unitId: id, change: 'created' },
    })
    // Изменение оргструктуры — обязательное событие аудита (17-security.md §6, ADR-0185)
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.orgChanged,
        objectId: id,
        objectType: 'unit',
        severity: 'notice',
        details: { change: 'created', code: input.code, parentId: input.parentId ?? null },
      },
      tx,
    )
    await bumpPrincipalsVersion(tx)
    return id
  },

  async updateUnit(tx: Tx, ctx: Ctx, id: string, patch: OrgUnitPatch): Promise<void> {
    const [current] = await tx.select().from(orgUnits).where(eq(orgUnits.id, id)).limit(1)
    if (!current) throw errors.notFound('Подразделение')
    await assertTerritory(patch.territoryId)
    await assertHeadIsPerson(tx, patch.headUserId)

    const values: Record<string, unknown> = {}
    if (patch.code !== undefined) values.code = patch.code
    if (patch.name !== undefined) values.name = patch.name
    if (patch.kind !== undefined) values.kind = patch.kind
    if (patch.headUserId !== undefined) values.headUserId = patch.headUserId
    if (patch.territoryId !== undefined) values.territoryId = patch.territoryId
    if (patch.sort !== undefined) values.sort = patch.sort
    if (patch.isActive !== undefined) values.isActive = patch.isActive
    if (patch.parentId !== undefined) values.parentId = patch.parentId

    if (Object.keys(values).length > 0) {
      await tx
        .update(orgUnits)
        .set({ ...values, updatedAt: sql`now()` })
        .where(eq(orgUnits.id, id))
    }

    const moved = patch.parentId !== undefined && patch.parentId !== current.parentId
    if (moved) await rebuildUnitSubtreeClosure(tx, id, patch.parentId ?? null)
    // Территории сотрудников (@my_territories) выводятся из подразделений и их предков
    const territoryChanged =
      patch.territoryId !== undefined && patch.territoryId !== current.territoryId
    // Глава подразделения получает принципал `unit_head:<id>`: поручения подчинённых (ADR-0082)
    const headChanged = patch.headUserId !== undefined && patch.headUserId !== current.headUserId
    if (moved || territoryChanged || headChanged) await bumpPrincipalsVersion(tx)

    await publishEvent(tx, ctx, {
      type: 'org.unit_changed',
      object: { id, type: 'unit', title: (patch.name ?? current.name).ru },
      payload: { unitId: id, change: 'updated' },
    })
    await audit(
      ctx,
      {
        action: AUDIT_ACTIONS.orgChanged,
        objectId: id,
        objectType: 'unit',
        severity: 'notice',
        details: { change: 'updated', fields: Object.keys(values), moved },
      },
      tx,
    )
  },

  /**
   * Связь подразделения с записью внешнего каталога (DN LDAP/AD): служебный
   * столбец синхронизации, а не правка оргструктуры, — без события; событие
   * `org.unit_changed` публикуют создание и правка самого подразделения (ADR-0184).
   */
  async setExternalId(tx: Executor, id: string, externalId: string | null): Promise<void> {
    await tx.update(orgUnits).set({ externalId }).where(eq(orgUnits.id, id))
  },

  async tree(database: Database = db()): Promise<OrgUnit[]> {
    const rows = await database
      .select({
        id: orgUnits.id,
        parentId: orgUnits.parentId,
        code: orgUnits.code,
        name: orgUnits.name,
        kind: orgUnits.kind,
        headUserId: orgUnits.headUserId,
        territoryId: orgUnits.territoryId,
        spaceId: orgUnits.spaceId,
        sort: orgUnits.sort,
        isActive: orgUnits.isActive,
      })
      .from(orgUnits)
      .orderBy(asc(orgUnits.sort), asc(sql`${orgUnits.name}->>'ru'`))

    const counts = await database
      .select({ unitId: employments.unitId, count: sql<number>`count(*)::int` })
      .from(employments)
      .where(isNull(employments.endsAt))
      .groupBy(employments.unitId)
    const countMap = new Map(counts.map((c) => [c.unitId, c.count]))

    const headIds = rows.map((r) => r.headUserId).filter((v): v is string => Boolean(v))
    const heads = await UserService.refs(headIds, database)

    const childCount = new Map<string, number>()
    for (const row of rows) {
      if (row.parentId) childCount.set(row.parentId, (childCount.get(row.parentId) ?? 0) + 1)
    }

    return rows.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      code: row.code,
      name: row.name,
      kind: row.kind as OrgUnit['kind'],
      head: row.headUserId ? (heads.get(row.headUserId) ?? null) : null,
      territoryId: row.territoryId,
      sort: row.sort,
      isActive: row.isActive,
      employeeCount: countMap.get(row.id) ?? 0,
      childCount: childCount.get(row.id) ?? 0,
      spaceId: row.spaceId,
    }))
  },

  /** Код и название подразделений — индекс `{unit.code}` номеров документов, подписи. */
  async briefs(
    unitIds: string[],
    database: Database = db(),
  ): Promise<Map<string, { id: string; code: string; name: LangTextValue }>> {
    if (unitIds.length === 0) return new Map()
    const rows = await database
      .select({ id: orgUnits.id, code: orgUnits.code, name: orgUnits.name })
      .from(orgUnits)
      .where(inArray(orgUnits.id, unitIds))
    return new Map(rows.map((row) => [row.id, row]))
  },

  /** Руководитель пользователя: глава основного подразделения, иначе — родительского. */
  async manager(userId: string, database: Database = db()): Promise<string | null> {
    const [employment] = await database
      .select({ unitId: employments.unitId })
      .from(employments)
      .where(
        and(
          eq(employments.userId, userId),
          eq(employments.isPrimary, true),
          isNull(employments.endsAt),
        ),
      )
      .limit(1)
    if (!employment) return null

    const [unit] = await database
      .select({ headUserId: orgUnits.headUserId, parentId: orgUnits.parentId })
      .from(orgUnits)
      .where(eq(orgUnits.id, employment.unitId))
      .limit(1)
    if (!unit) return null

    if (unit.headUserId && unit.headUserId !== userId) return unit.headUserId
    if (!unit.parentId) return null

    const [parent] = await database
      .select({ headUserId: orgUnits.headUserId })
      .from(orgUnits)
      .where(eq(orgUnits.id, unit.parentId))
      .limit(1)
    return parent?.headUserId ?? null
  },

  /** Подчинённые транзитивно: все сотрудники подразделений, которые возглавляет пользователь. */
  async subordinates(userId: string, database: Database = db()): Promise<string[]> {
    const headed = await database
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(eq(orgUnits.headUserId, userId))
    if (headed.length === 0) return []

    const unitIds = headed.map((u) => u.id)
    const descendants = await database
      .select({ unitId: orgClosure.unitId })
      .from(orgClosure)
      .where(inArray(orgClosure.ancestorId, unitIds))

    const allUnits = [...new Set([...unitIds, ...descendants.map((d) => d.unitId)])]
    const rows = await database
      .select({ userId: employments.userId })
      .from(employments)
      .innerJoin(users, eq(users.id, employments.userId))
      .where(
        and(
          inArray(employments.unitId, allUnits),
          isNull(employments.endsAt),
          eq(users.kind, 'person'),
        ),
      )
    return [...new Set(rows.map((r) => r.userId))].filter((id) => id !== userId)
  },

  async unitHead(unitId: string, database: Database = db()): Promise<string | null> {
    const [unit] = await database
      .select({ headUserId: orgUnits.headUserId })
      .from(orgUnits)
      .where(eq(orgUnits.id, unitId))
      .limit(1)
    return unit?.headUserId ?? null
  },

  /** Действующие сотрудники подразделений — для нагрузки отдела (ADR-0082). */
  async members(unitIds: string[], database: Database = db()): Promise<string[]> {
    if (unitIds.length === 0) return []
    const rows = await database
      .selectDistinct({ userId: employments.userId })
      .from(employments)
      .innerJoin(users, eq(users.id, employments.userId))
      .where(
        and(
          inArray(employments.unitId, unitIds),
          isNull(employments.endsAt),
          eq(users.status, 'active'),
          eq(users.kind, 'person'),
        ),
      )
    return rows.map((row) => row.userId)
  },
}

export async function rebuildUnitClosure(
  tx: Executor,
  unitId: string,
  parentId: string | null,
): Promise<void> {
  await tx.delete(orgClosure).where(eq(orgClosure.unitId, unitId))
  await tx.insert(orgClosure).values({ unitId, ancestorId: unitId, depth: 0 }).onConflictDoNothing()
  if (!parentId) return
  await tx.execute(sql`
    INSERT INTO ${orgClosure} (unit_id, ancestor_id, depth)
    SELECT ${unitId}::uuid, oc.ancestor_id, oc.depth + 1
      FROM ${orgClosure} oc WHERE oc.unit_id = ${parentId}::uuid
    ON CONFLICT DO NOTHING`)
}

export async function rebuildUnitSubtreeClosure(
  tx: Executor,
  unitId: string,
  parentId: string | null,
): Promise<void> {
  const subtree = await tx
    .select({ unitId: orgClosure.unitId, depth: orgClosure.depth })
    .from(orgClosure)
    .where(eq(orgClosure.ancestorId, unitId))

  await rebuildUnitClosure(tx, unitId, parentId)
  for (const node of subtree.sort((a, b) => a.depth - b.depth)) {
    if (node.unitId === unitId) continue
    const [row] = await tx
      .select({ parentId: orgUnits.parentId })
      .from(orgUnits)
      .where(eq(orgUnits.id, node.unitId))
      .limit(1)
    await rebuildUnitClosure(tx, node.unitId, row?.parentId ?? null)
  }
}
