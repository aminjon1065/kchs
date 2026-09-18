import type { ViewDefinition } from '@kchs/contracts'
import type { CollectionMode, CollectionState } from '@kchs/ui'

/** Состояние CollectionView ↔ ViewDefinition сохранённого представления. */
export function emptyCollectionState(mode: CollectionMode = 'table'): CollectionState {
  return { mode, filter: null, sort: [], search: '', groupBy: null, columns: [] }
}

export function toDefinition(state: CollectionState): ViewDefinition {
  return {
    mode: state.mode,
    filter: state.filter,
    sort: state.sort.map((item) => ({ field: item.field, direction: item.direction })),
    groupBy: state.groupBy,
    columns: state.columns.map((column) => ({
      key: column.key,
      ...(column.width ? { width: column.width } : {}),
      hidden: column.hidden ?? false,
    })),
    search: state.search,
    params: {},
  }
}

export function fromDefinition(definition: ViewDefinition): CollectionState {
  const mode = (['table', 'list', 'board', 'gallery'] as const).includes(
    definition.mode as CollectionMode,
  )
    ? (definition.mode as CollectionMode)
    : 'table'
  return {
    mode,
    filter: definition.filter ?? null,
    sort: definition.sort.map((item) => ({ field: item.field, direction: item.direction })),
    search: definition.search ?? '',
    groupBy: definition.groupBy ?? null,
    columns: definition.columns.map((column) => ({
      key: column.key,
      ...(column.width ? { width: column.width } : {}),
      hidden: column.hidden,
    })),
  }
}

/** Совпадает ли состояние с сохранённым представлением («Изменено» в панели). */
export function sameState(a: CollectionState, b: CollectionState): boolean {
  return JSON.stringify(toDefinition(a)) === JSON.stringify(toDefinition(b))
}
