import type { Principal, PrincipalRef } from '@kchs/contracts'
import { eq, inArray } from 'drizzle-orm'
import { type Database, db } from '~/shared/db/client.js'
import {
  employments,
  groups,
  objects,
  orgUnits,
  positions,
  roles,
  users,
} from '~/shared/db/schema/index.js'

/**
 * Превращает принципалы в отображаемые чипы для диалога «Поделиться»
 * и вкладки «Кто имеет доступ».
 */
export async function describePrincipals(
  principals: Principal[],
  database: Database = db(),
): Promise<Map<string, PrincipalRef>> {
  const result = new Map<string, PrincipalRef>()
  if (principals.length === 0) return result

  const byType = new Map<string, string[]>()
  for (const p of principals) {
    const list = byType.get(p.type) ?? []
    list.push(p.id)
    byType.set(p.type, list)
  }

  const userIds = byType.get('user') ?? []
  if (userIds.length) {
    const rows = await database
      .select({
        id: users.id,
        displayName: users.displayName,
        avatarFileId: users.avatarFileId,
        unitName: orgUnits.name,
        positionName: positions.name,
        status: users.status,
        kind: users.kind,
        description: users.description,
      })
      .from(users)
      .leftJoin(employments, eq(employments.userId, users.id))
      .leftJoin(orgUnits, eq(orgUnits.id, employments.unitId))
      .leftJoin(positions, eq(positions.id, employments.positionId))
      .where(inArray(users.id, userIds))

    for (const row of rows) {
      if (result.has(`user:${row.id}`)) continue
      // Служебная учётная запись (ADR-0130): подпись — её назначение, отметку
      // «служебная» рисует интерфейс по признаку `service`
      if (row.kind === 'service') {
        result.set(`user:${row.id}`, {
          type: 'user',
          id: row.id,
          title: row.displayName,
          subtitle: row.description ?? undefined,
          avatarUrl: null,
          icon: 'bot',
          service: true,
        })
        continue
      }
      result.set(`user:${row.id}`, {
        type: 'user',
        id: row.id,
        title: row.displayName,
        subtitle: [row.positionName?.ru, row.unitName?.ru].filter(Boolean).join(' · ') || undefined,
        avatarUrl: row.avatarFileId ? `/api/v1/files/${row.avatarFileId}/content` : null,
        icon: 'user',
      })
    }
  }

  const groupIds = byType.get('group') ?? []
  if (groupIds.length) {
    const rows = await database.select().from(groups).where(inArray(groups.id, groupIds))
    for (const row of rows) {
      result.set(`group:${row.id}`, {
        type: 'group',
        id: row.id,
        title: row.name,
        subtitle: 'Группа',
        icon: 'users',
      })
    }
  }

  const unitIds = byType.get('unit') ?? []
  if (unitIds.length) {
    const rows = await database.select().from(orgUnits).where(inArray(orgUnits.id, unitIds))
    for (const row of rows) {
      result.set(`unit:${row.id}`, {
        type: 'unit',
        id: row.id,
        title: row.name.ru,
        subtitle: 'Подразделение и вложенные',
        icon: 'building-2',
      })
    }
  }

  const positionIds = byType.get('position') ?? []
  if (positionIds.length) {
    const rows = await database.select().from(positions).where(inArray(positions.id, positionIds))
    for (const row of rows) {
      result.set(`position:${row.id}`, {
        type: 'position',
        id: row.id,
        title: row.name.ru,
        subtitle: 'Должность',
        icon: 'briefcase',
      })
    }
  }

  const roleKeys = byType.get('role') ?? []
  if (roleKeys.length) {
    const rows = await database.select().from(roles).where(inArray(roles.key, roleKeys))
    for (const row of rows) {
      result.set(`role:${row.key}`, {
        type: 'role',
        id: row.key,
        title: row.name.ru,
        subtitle: 'Системная роль',
        icon: 'shield',
      })
    }
  }

  const spaceRoleIds = byType.get('space_role') ?? []
  if (spaceRoleIds.length) {
    const spaceIds = spaceRoleIds.map((id) => id.split(':')[0]!).filter(Boolean)
    const rows = spaceIds.length
      ? await database
          .select({ id: objects.id, title: objects.title })
          .from(objects)
          .where(inArray(objects.id, spaceIds))
      : []
    const titles = new Map(rows.map((r) => [r.id, r.title]))
    for (const id of spaceRoleIds) {
      const [spaceId = '', role = ''] = id.split(':')
      result.set(`space_role:${id}`, {
        type: 'space_role',
        id,
        title: titles.get(spaceId) ?? 'Пространство',
        subtitle: `Роль не ниже «${role}»`,
        icon: 'layout-grid',
      })
    }
  }

  if (byType.has('everyone')) {
    result.set('everyone:*', {
      type: 'everyone',
      id: '*',
      title: 'Все сотрудники',
      subtitle: 'Любой вошедший пользователь',
      icon: 'globe',
    })
  }

  for (const linkId of byType.get('link') ?? []) {
    result.set(`link:${linkId}`, {
      type: 'link',
      id: linkId,
      title: 'Доступ по ссылке',
      subtitle: 'Гостевая ссылка',
      icon: 'link',
    })
  }

  return result
}
