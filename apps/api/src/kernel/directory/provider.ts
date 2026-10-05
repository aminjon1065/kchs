import { setDirectoryProvider } from './port.js'
import { DirectoryQueries } from './queries.js'
import { OrgService, UserService } from './service.js'

/**
 * Реализация порта справочника (ADR-0179): сервисы людей и оргструктуры — в ядре,
 * `directory()` остаётся единым входом для ядра и модулей.
 */
export function registerDirectoryProvider(): void {
  setDirectoryProvider({
    refs: (userIds, database) => UserService.refs(userIds, database),
    displayName: async (userId) => {
      const refs = await UserService.refs([userId])
      return refs.get(userId)?.displayName ?? 'Система'
    },
    manager: (userId) => OrgService.manager(userId),
    subordinates: (userId) => OrgService.subordinates(userId),
    unitHead: (unitId) => OrgService.unitHead(unitId),
    primaryUnit: (userId) => DirectoryQueries.primaryUnit(userId),
    unitMembers: (unitId) => DirectoryQueries.unitMembers(unitId),
    unitByCode: (code) => DirectoryQueries.unitByCode(code),
    groupMembers: (groupId) => DirectoryQueries.groupMembers(groupId),
    usersWithRole: (roleKey, options) => DirectoryQueries.usersWithRole(roleKey, options),
    activeUsers: (userIds) => DirectoryQueries.activeUsers(userIds),
    profile: (userId) => UserService.profile(userId),
    account: async (userId) => (await DirectoryQueries.accounts([userId])).get(userId) ?? null,
    accounts: (userIds) => DirectoryQueries.accounts(userIds),
    orgTree: () => OrgService.tree(),
    unitBriefs: (unitIds) => OrgService.briefs(unitIds),
    unitStaff: (unitIds) => OrgService.members(unitIds),
  })
}
