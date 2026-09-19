import { SPACE_ROLE_VALUE, type SpaceRole } from '@kchs/contracts'
import type { AssigneeDirectory } from '@kchs/process'
import { directory } from '../directory/port.js'
import { SpaceService } from '../spaces/service.js'

function isSpaceRole(key: string): key is SpaceRole {
  return Object.hasOwn(SPACE_ROLE_VALUE, key)
}

/**
 * Справочник резолвера назначений поверх порта ядра (реализация — модуль
 * identity) и участников пространств (ядро). `role_in_space:<ключ>`
 * (ADR-0079): для ролей участника пространства (`viewer`…`admin`) — участники
 * пространства объекта с ролью не ниже; для остальных ключей — сотрудники с
 * ролью, ограниченной пространством объекта, а если таких нет — с той же ролью
 * без ограничения.
 */
export const kernelDirectory: AssigneeDirectory = {
  activeUsers: (userIds) => directory().activeUsers([...userIds]),
  groupMembers: (groupId) => directory().groupMembers(groupId),
  unitMembers: (unitId) => directory().unitMembers(unitId),
  unitHead: (unitId) => directory().unitHead(unitId),
  manager: (userId) => directory().manager(userId),
  primaryUnit: (userId) => directory().primaryUnit(userId),
  unitByCode: (code) => directory().unitByCode(code),
  usersWithRole: (roleKey, spaceId) =>
    directory().usersWithRole(roleKey, { spaceId, scope: 'effective' }),
  usersWithRoleInSpace: async (roleKey, spaceId) => {
    if (isSpaceRole(roleKey)) {
      if (!spaceId) return []
      const members = await SpaceService.members(spaceId)
      const rank = SPACE_ROLE_VALUE[roleKey]
      return members
        .filter((member) => (SPACE_ROLE_VALUE[member.role as SpaceRole] ?? 0) >= rank)
        .map((member) => member.userId)
    }
    const scoped = await directory().usersWithRole(roleKey, { spaceId, scope: 'space' })
    if (scoped.length > 0) return scoped
    return directory().usersWithRole(roleKey, { spaceId: null, scope: 'effective' })
  },
}
