import type { OrgUnit, UserProfile, UserRef } from '@kchs/contracts'
import type { Database } from '~/shared/db/client.js'
import type { LangTextValue } from '~/shared/db/columns.js'

/** Учётная запись для решений модулей: можно ли действовать от неё, куда писать. */
export interface DirectoryAccount {
  id: string
  /** `person` — сотрудник, `service` — служебная запись (ADR-0130). */
  kind: string
  status: string
  email: string | null
  displayName: string
  locale: string
  timezone: string
}

/**
 * Порт справочника людей и оргструктуры — единый вход для ядра и модулей.
 *
 * Ядру нужны имена авторов, руководители и подчинённые (лента активности,
 * уведомления, политики типов), движку процессов — назначения по оргструктуре
 * (ADR-0079), модулям — профиль, учётная запись, дерево и сведения о
 * подразделениях. Сервисы справочника живут в ядре (`kernel/directory`, ADR-0179);
 * реализацию регистрирует `registerDirectoryProvider` при старте, а тесты могут
 * подменить её.
 */
export interface DirectoryProvider {
  refs: (userIds: string[], database?: Database) => Promise<Map<string, UserRef>>
  displayName: (userId: string) => Promise<string>
  manager: (userId: string) => Promise<string | null>
  subordinates: (userId: string) => Promise<string[]>
  unitHead: (unitId: string) => Promise<string | null>
  /** Основное подразделение сотрудника (иначе — любое действующее). */
  primaryUnit: (userId: string) => Promise<string | null>
  /** Сотрудники подразделения и вложенных подразделений: действующие занятости, активные. */
  unitMembers: (unitId: string) => Promise<string[]>
  unitByCode: (code: string) => Promise<string | null>
  /** Активные члены группы. */
  groupMembers: (groupId: string) => Promise<string[]>
  /**
   * Активные обладатели роли. `effective` — роль без ограничения и роль,
   * ограниченная пространством `spaceId`; `space` — только ограниченная им.
   */
  usersWithRole: (
    roleKey: string,
    options: { spaceId: string | null; scope: 'effective' | 'space' },
  ) => Promise<string[]>
  /** Существующие активные пользователи из списка — в том же порядке. */
  activeUsers: (userIds: string[]) => Promise<string[]>
  /** Профиль пользователя (как в `/me`), `null` — нет такого. */
  profile: (userId: string) => Promise<UserProfile | null>
  /** Учётная запись одного пользователя (любого статуса), `null` — нет такой. */
  account: (userId: string) => Promise<DirectoryAccount | null>
  /** Учётные записи из списка (любого статуса); отсутствующих в ответе нет. */
  accounts: (userIds: string[]) => Promise<Map<string, DirectoryAccount>>
  /** Дерево оргструктуры. */
  orgTree: () => Promise<OrgUnit[]>
  /** Код и название подразделений из списка. */
  unitBriefs: (
    unitIds: string[],
  ) => Promise<Map<string, { id: string; code: string; name: LangTextValue }>>
  /** Активные сотрудники подразделений из списка (без вложенных) — действующие занятости. */
  unitStaff: (unitIds: string[]) => Promise<string[]>
}

const EMPTY: DirectoryProvider = {
  refs: async () => new Map(),
  displayName: async () => 'Система',
  manager: async () => null,
  subordinates: async () => [],
  unitHead: async () => null,
  primaryUnit: async () => null,
  unitMembers: async () => [],
  unitByCode: async () => null,
  groupMembers: async () => [],
  usersWithRole: async () => [],
  activeUsers: async () => [],
  profile: async () => null,
  account: async () => null,
  accounts: async () => new Map(),
  orgTree: async () => [],
  unitBriefs: async () => new Map(),
  unitStaff: async () => [],
}

let provider: DirectoryProvider = EMPTY

export function setDirectoryProvider(next: DirectoryProvider): void {
  provider = next
}

export function directory(): DirectoryProvider {
  return provider
}
