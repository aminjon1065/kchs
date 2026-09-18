import type { Aggregate, FilterNode, QuerySpec, QueryStep, TimeBucket } from '@kchs/contracts'

/**
 * Состояние конструктора «Исследование» (03-screens.md §7) и его QuerySpec:
 * фильтр → сводка (разрезы и меры) → сортировка → лимит.
 */
export interface ExploreGroup {
  field: string
  bucket?: TimeBucket
}

export interface ExploreMeasure {
  agg: Aggregate
  /** Без поля — количество строк. */
  field?: string
}

export interface ExploreState {
  datasetId: string
  filter: FilterNode | null
  groups: ExploreGroup[]
  measures: ExploreMeasure[]
  sort: { field: string; dir: 'asc' | 'desc' } | null
  limit: number | null
}

/** Строк без сводки — чтобы «сырое» исследование не тянуло весь датасет. */
export const RAW_LIMIT = 1000

/** Имя столбца меры в результате: латиница, как требует алиас QuerySpec. */
export function measureAlias(measure: ExploreMeasure): string {
  return measure.field ? `${measure.agg}_${measure.field}` : measure.agg
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
  const steps: QueryStep[] = []
  if (state.filter) steps.push({ type: 'filter', where: state.filter })
  const aggregated = state.groups.length > 0 || state.measures.length > 0
  if (aggregated) {
    // Повторы меры (одна и та же функция над тем же полем) дали бы одинаковые алиасы
    const measures = new Map(state.measures.map((measure) => [measureAlias(measure), measure]))
    steps.push({
      type: 'aggregate',
      groupBy: state.groups.map((group) => ({
        field: group.field,
        ...(group.bucket ? { bucket: group.bucket } : {}),
      })),
      measures: [...measures].map(([alias, measure]) => ({
        alias,
        agg: measure.agg,
        ...(measure.field ? { field: measure.field } : {}),
      })),
    })
  }
  if (state.sort)
    steps.push({ type: 'sort', by: [{ field: state.sort.field, dir: state.sort.dir }] })
  const limit = state.limit ?? (aggregated ? null : RAW_LIMIT)
  if (limit !== null) steps.push({ type: 'limit', limit, offset: 0 })
  return {
    version: 1,
    source: { kind: 'dataset', id: state.datasetId },
    steps,
    params: {},
    options: { cache: true, approxCount: true },
  }
}
