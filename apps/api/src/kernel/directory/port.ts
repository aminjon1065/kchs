import type { UserRef } from '@kchs/contracts'
import type { Database } from '~/shared/db/client.js'

/**
 * Порт справочника людей и оргструктуры.
 *
 * Ядру нужны имена авторов, руководители и подчинённые (лента активности,
 * уведомления, политики типов), а движку процессов — ещё и назначения по
 * оргструктуре (ADR-0079), но ядро не должно знать о модулях
 * (01-overview.md §Правила границ). Модуль `identity` регистрирует реализацию
 * при старте — это инверсия зависимости, такая же, как реестр типов объектов.
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
}

let provider: DirectoryProvider = EMPTY

export function setDirectoryProvider(next: DirectoryProvider): void {
  provider = next
}

export function directory(): DirectoryProvider {
  return provider
}
