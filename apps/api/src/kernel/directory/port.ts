import type { UserRef } from '@kchs/contracts'
import type { Database } from '~/shared/db/client.js'

/**
 * Порт справочника людей и оргструктуры.
 *
 * Ядру нужны имена авторов, руководители и подчинённые (лента активности,
 * уведомления, политики типов), но ядро не должно знать о модулях
 * (01-overview.md §Правила границ). Модуль `identity` регистрирует реализацию
 * при старте — это инверсия зависимости, такая же, как реестр типов объектов.
 */
export interface DirectoryProvider {
  refs: (userIds: string[], database?: Database) => Promise<Map<string, UserRef>>
  displayName: (userId: string) => Promise<string>
  manager: (userId: string) => Promise<string | null>
  subordinates: (userId: string) => Promise<string[]>
  unitHead: (unitId: string) => Promise<string | null>
}

const EMPTY: DirectoryProvider = {
  refs: async () => new Map(),
  displayName: async () => 'Система',
  manager: async () => null,
  subordinates: async () => [],
  unitHead: async () => null,
}

let provider: DirectoryProvider = EMPTY

export function setDirectoryProvider(next: DirectoryProvider): void {
  provider = next
}

export function directory(): DirectoryProvider {
  return provider
}

export function resetDirectoryProvider(): void {
  provider = EMPTY
}
