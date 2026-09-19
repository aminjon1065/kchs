import { TerritoryPassport } from './passport/territory-passport.js'

/**
 * Вкладка объекта-территории (`/o/{id}`) — паспорт территории (03-screens.md §11,
 * ADR-0077); переходы к предкам, соседям и дочерним единицам — в их вкладки.
 */
export function TerritoryView({ objectId }: { objectId: string }) {
  return <TerritoryPassport territoryId={objectId} />
}
