import type { Space } from '@kchs/contracts'

const SPACE_ORDER: Record<string, number> = { org: 0, team: 1, unit: 2, personal: 3 }

/** Порядок пространств: общее → команды → подразделения → личное. */
export function orderSpaces(spaces: Space[]): Space[] {
  return [...spaces].sort(
    (a, b) =>
      (SPACE_ORDER[a.kind] ?? 9) - (SPACE_ORDER[b.kind] ?? 9) || a.name.localeCompare(b.name, 'ru'),
  )
}
