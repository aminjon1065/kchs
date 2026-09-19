import {
  applyNotebookParams,
  type DatasetRecord,
  type ExplorePlan,
  explorePlanSpec,
  type MetricPeriod,
  type NotebookBindings,
  type NotebookParams,
  notebookParamFields,
  type QuerySpec,
} from '@kchs/contracts'
import { relativeRange, zonedMidnight } from '@kchs/fields'

/**
 * Выполнение ячеек тетради (ADR-0071): запросы — через те же маршруты, что
 * «Исследование», SQL-лаборатория и показатели, с правами смотрящего; кэш
 * результатов — по версии данных на сервере и в кэше клиента. Ключи всех ячеек
 * начинаются с `['notebook', id]` — «пересчитать всё» обновляет их разом.
 */
export const notebookKeys = {
  all: (notebookId: string) => ['notebook', notebookId] as const,
  cell: (notebookId: string, cellId: string, input: unknown) =>
    ['notebook', notebookId, 'cell', cellId, input] as const,
}

/** Запрос визуальной ячейки: план «Исследования» и параметры тетради шагом filter. */
export function cellSpec(
  dataset: DatasetRecord,
  plan: ExplorePlan,
  params: NotebookParams,
  bindings: NotebookBindings | undefined,
): QuerySpec {
  return applyNotebookParams(
    explorePlanSpec(dataset.id, plan),
    params,
    notebookParamFields(bindings, dataset.fields, dataset.territoryField),
  )
}

/** Запрос сохранённого графика с параметрами тетради — если он над датасетом. */
export function chartQuerySpec(
  query: QuerySpec,
  dataset: DatasetRecord | undefined,
  params: NotebookParams,
  bindings: NotebookBindings | undefined,
): QuerySpec {
  if (!dataset) return query
  return applyNotebookParams(
    query,
    params,
    notebookParamFields(bindings, dataset.fields, dataset.territoryField),
  )
}

function dayAfter(date: string): [number, number, number] {
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()]
}

/**
 * Параметры тетради для SQL-ячейки: `{{period_from}}` и `{{period_to}}` —
 * моменты ISO 8601 в поясе пользователя (конец не входит), `{{territory}}` —
 * идентификатор единицы. Не заданы — NULL: запрос сам решает, что это значит.
 */
export function sqlParams(params: NotebookParams, timezone: string): Record<string, string | null> {
  let from: string | null = null
  let to: string | null = null
  if (params.period && 'unit' in params.period) {
    const range = relativeRange(params.period, new Date(), timezone)
    from = range.from.toISOString()
    to = range.to.toISOString()
  } else if (params.period) {
    const [y = 1970, m = 1, d = 1] = params.period.from.split('-').map(Number)
    from = zonedMidnight(y, m, d, timezone).toISOString()
    to = zonedMidnight(...dayAfter(params.period.to), timezone).toISOString()
  }
  return { period_from: from, period_to: to, territory: params.territory?.id ?? null }
}

/** Период тетради для показателя; не задан — у показателя свой период. */
export function metricPeriod(params: NotebookParams): MetricPeriod | undefined {
  if (!params.period) return undefined
  if ('unit' in params.period) return params.period
  return { start: params.period.from, end: params.period.to }
}
