import type { DashboardFilter, FilterNode, QuerySpec } from '@kchs/contracts'

const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0)

/** Условие глобального фильтра дашборда над полем плитки; пустое значение — без условия. */
export function filterCondition(
  filter: DashboardFilter,
  field: string,
  value: unknown,
): FilterNode | null {
  if (isEmpty(value)) return null
  switch (filter.kind) {
    case 'period':
      if (Array.isArray(value) && value.length === 2) return { field, op: 'between', value }
      if (typeof value === 'object' && value !== null && 'unit' in value) {
        return { field, op: 'relative', value }
      }
      return null
    case 'select':
    case 'unit':
      return Array.isArray(value) ? { field, op: 'in', value } : { field, op: 'eq', value }
    case 'text':
      return typeof value === 'string' ? { field, op: 'contains', value } : null
    case 'territory':
      if (typeof value === 'object' && value !== null && 'id' in value) {
        return { field, op: 'within', value }
      }
      return Array.isArray(value) ? { field, op: 'in', value } : { field, op: 'eq', value }
  }
}

/**
 * Глобальные фильтры дашборда → шаг `filter` в начале запроса плитки: условия
 * действуют на строки источника до сводок. Фильтр без привязки к плитке её не
 * трогает; значение не задано — берётся значение по умолчанию фильтра.
 */
export function applyDashboardFilters(
  spec: QuerySpec,
  filters: DashboardFilter[],
  bindings: Record<string, string>,
  values: Record<string, unknown>,
): QuerySpec {
  const conditions = filters.flatMap((filter) => {
    const field = bindings[filter.id]
    if (!field) return []
    const value = filter.id in values ? values[filter.id] : filter.default
    const condition = filterCondition(filter, field, value)
    return condition ? [condition] : []
  })
  if (conditions.length === 0) return spec
  const where: FilterNode =
    conditions.length === 1 ? (conditions[0] as FilterNode) : { and: conditions }
  return { ...spec, steps: [{ type: 'filter', where }, ...spec.steps] }
}
