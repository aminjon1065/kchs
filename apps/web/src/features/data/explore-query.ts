import { type ExplorePlan, explorePlanSpec, type QuerySpec } from '@kchs/contracts'

/**
 * Состояние конструктора «Исследование» (03-screens.md §7): план из контрактов
 * (его же строит «Спросить данные», ADR-0061) и датасет, к которому он относится.
 */
export interface ExploreState extends ExplorePlan {
  datasetId: string
}

export function emptyExplore(datasetId: string): ExploreState {
  return {
    datasetId,
    filter: null,
    groups: [],
    measures: [{ agg: 'count' }],
    sort: null,
    limit: null,
  }
}

export function exploreSpec(state: ExploreState): QuerySpec {
  const { datasetId, ...plan } = state
  return explorePlanSpec(datasetId, plan)
}
