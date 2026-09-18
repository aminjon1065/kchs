import type { ChartFilter, ChartPick } from '@kchs/chart-spec'
import type { FieldOption, Locale, QueryResult } from '@kchs/contracts'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { territoriesQuery } from './queries.js'

/**
 * Результат с подписями вместо значений в указанных столбцах: категории
 * графика и ячейки таблицы данных показывают названия, а не идентификаторы.
 * Значение без подписи остаётся как есть.
 */
export function relabelResult(
  result: QueryResult,
  labels: ReadonlyMap<string, ReadonlyMap<string, string>>,
): QueryResult {
  const columns = result.fields.flatMap((field, index) => {
    const map = labels.get(field.name)
    return map ? [{ index, map }] : []
  })
  if (columns.length === 0) return result
  return {
    ...result,
    rows: result.rows.map((row) => {
      const next = [...row]
      for (const { index, map } of columns) {
        const value = next[index]
        if (value !== null && value !== undefined) next[index] = map.get(String(value)) ?? value
      }
      return next
    }),
  }
}

/**
 * Выбранный элемент графика с подписями — обратно к значениям результата
 * (детализация и перекрёстный фильтр сравнивают значения, а не названия).
 * Строки подписанного результата идут в том же порядке, что исходные, поэтому
 * значение берётся из первой строки с той же подписью.
 */
export function unlabelPick(
  pick: ChartPick,
  original: QueryResult,
  labelled: QueryResult,
): ChartPick {
  if (original === labelled) return pick
  const valueOf = (index: number, shown: unknown): unknown => {
    if (shown === null || shown === undefined) return shown
    const row = labelled.rows.findIndex((item) => item[index] === shown)
    return row < 0 ? shown : original.rows[row]?.[index]
  }
  const restore = (condition: ChartFilter): ChartFilter => {
    const index = labelled.fields.findIndex((field) => field.name === condition.field)
    if (index < 0 || condition.op === 'between') return condition
    return {
      ...condition,
      value: Array.isArray(condition.value)
        ? condition.value.map((item) => valueOf(index, item))
        : valueOf(index, condition.value),
    }
  }
  return { ...pick, filters: pick.filters.map(restore) }
}

const NO_LABELS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map()

/** Подписи вариантов на языке интерфейса: значение → подпись. */
export function optionLabels(options: readonly FieldOption[], locale: Locale): Map<string, string> {
  return new Map(options.map((option) => [option.value, option.label[locale] ?? option.label.ru]))
}

/**
 * Подписи территорий в результате: столбцы типа «территория» (поле или
 * `territory_level()`) показывают названия единиц справочника (ADR-0057).
 * `extra` — подписи других столбцов (поля со справочником) по имени столбца.
 */
export function useLabelledResult(
  result: QueryResult | undefined,
  extra: ReadonlyMap<string, ReadonlyMap<string, string>> = NO_LABELS,
): QueryResult | undefined {
  const locale = useAppearance((s) => s.locale)
  const hasTerritory = result?.fields.some((field) => field.type === 'territory') ?? false
  const { data: territories } = useQuery({ ...territoriesQuery(), enabled: hasTerritory })
  return useMemo(() => {
    if (!result) return undefined
    const labels = new Map(extra)
    if (territories) {
      const names = new Map(
        territories.map((item) => [item.id, item.name[locale] ?? item.name.ru] as const),
      )
      for (const field of result.fields) {
        if (field.type === 'territory' && !labels.has(field.name)) labels.set(field.name, names)
      }
    }
    return labels.size > 0 ? relabelResult(result, labels) : result
  }, [result, extra, territories, locale])
}
