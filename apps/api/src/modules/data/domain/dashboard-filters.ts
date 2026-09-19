import {
  type DashboardFilter,
  dashboardFilterCondition,
  dashboardFiltersWhere,
  type QuerySpec,
} from '@kchs/contracts'

/**
 * Условие глобального фильтра дашборда над полем плитки; пустое значение — без
 * условия. Та же функция строит условия тайлов плитки-карты на клиенте (ADR-0074).
 */
export const filterCondition = dashboardFilterCondition

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
  const where = dashboardFiltersWhere(filters, bindings, values)
  if (!where) return spec
  return { ...spec, steps: [{ type: 'filter', where }, ...spec.steps] }
}
