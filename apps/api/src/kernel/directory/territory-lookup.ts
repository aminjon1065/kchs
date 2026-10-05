/**
 * Порт справочника территорий для оргструктуры (ADR-0179): у подразделения может
 * быть территория, а справочник территорий ведёт модуль. Ядро только спрашивает,
 * есть ли такая; реализацию регистрирует модуль-владелец территорий при старте.
 */
export interface TerritoryLookup {
  exists: (territoryId: string) => Promise<boolean>
}

// Без справочника территорию подразделению не назначить
let lookup: TerritoryLookup = { exists: async () => false }

export function setTerritoryLookup(next: TerritoryLookup): void {
  lookup = next
}

export function territoryLookup(): TerritoryLookup {
  return lookup
}
