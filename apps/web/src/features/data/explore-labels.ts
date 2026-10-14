import {
  type ChartSpec,
  type ChartType,
  COMPARE_PARTS,
  calcAlias,
  compareAlias,
  type DatasetField,
  type ExploreMeasure,
  type ExplorePlan,
  groupAlias,
  type LangText,
  lagAlias,
  measureAlias,
  planColumns,
  type QueryResult,
} from '@kchs/contracts'
import { useCallback, useMemo } from 'react'
import { optionLabels, useLabelledResult } from '~/entities/data/result-labels.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useFieldOptions } from './field-options.js'

/**
 * Подписи и план «Исследования» без компонентов: их берут конструктор, ячейки тетради
 * и печать отчёта — через публичный вход data.
 */

export const CHART_TYPES: ChartType[] = [
  'bar',
  'line',
  'area',
  'pie',
  'donut',
  'table',
  'number',
  'scatter',
  'heatmap',
  'treemap',
  'funnel',
]

export const labelOf = (field: DatasetField, locale: 'ru' | 'tg' | 'en') =>
  field.label[locale] ?? field.label.ru ?? field.key

/**
 * Подписи осей и легенды — в самой спецификации: сохранённый график и плитка
 * дашборда показывают «Количество», а не имя столбца `count`.
 */
export function withChannelLabels(spec: ChartSpec, result: QueryResult): ChartSpec {
  const labels = new Map(result.fields.map((field) => [field.name, field.label]))
  const label = <T extends { field: string; label?: LangText }>(channel: T): T => {
    const text = labels.get(channel.field)
    return text && !channel.label ? { ...channel, label: text } : channel
  }
  const encoding = spec.encoding
  return {
    ...spec,
    encoding: {
      ...encoding,
      ...(encoding.x ? { x: label(encoding.x) } : {}),
      y: encoding.y.map(label),
      ...(encoding.color && 'field' in encoding.color ? { color: label(encoding.color) } : {}),
      ...(encoding.size ? { size: label(encoding.size) } : {}),
    },
  }
}

/** Изменение плана: сортировка по столбцу, которого в сводке больше нет, снимается. */
export function updatePlan<T extends ExplorePlan>(current: T, patch: Partial<ExplorePlan>): T {
  const next = { ...current, ...patch }
  if (next.sort && (next.groups.length > 0 || next.measures.length > 0)) {
    if (!planColumns(next).includes(next.sort.field)) next.sort = null
  }
  return next
}

/**
 * Подписи результата: поля — по схеме, меры — «функция: поле», значения
 * территорий и справочников — подписями (ADR-0057).
 */
export function useExploreLabels(
  fields: readonly DatasetField[],
  plan: ExplorePlan,
  result: QueryResult | undefined,
): { columnLabel: (name: string) => string; labelled: QueryResult | undefined } {
  const t = useT()
  const locale = useLocale()
  const byKey = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields])
  const fieldOptions = useFieldOptions(fields)

  const measureLabel = useCallback(
    (measure: ExploreMeasure): string => {
      if (measure.agg === 'expr') return measure.name || measure.expr || measureAlias(measure)
      const agg = t(`data.explore.aggregates.${measure.agg}`)
      const target = measure.field ? byKey.get(measure.field) : undefined
      return target ? t('data.explore.measureOf', { agg, field: labelOf(target, locale) }) : agg
    },
    [byKey, locale, t],
  )

  const columnLabel = useCallback(
    (name: string): string => {
      const field = byKey.get(name)
      if (field) return labelOf(field, locale)
      const group = plan.groups.find(
        (item) => (item.bucket || item.level) && groupAlias(item) === name,
      )
      const grouped = group ? byKey.get(group.field) : undefined
      if (group?.bucket && grouped) {
        return `${labelOf(grouped, locale)} · ${t(`data.explore.buckets.${group.bucket}`)}`
      }
      if (group?.level && grouped) {
        return `${labelOf(grouped, locale)} · ${t(`data.explore.levels.${group.level}`)}`
      }
      for (const measure of plan.measures) {
        if (measureAlias(measure) === name) return measureLabel(measure)
        // Части сравнения периодов и расчёты над мерой — подписью меры с уточнением
        const part = COMPARE_PARTS.find((item) => compareAlias(measure, item) === name)
        if (part) {
          return t(`data.explore.compare.parts.${part}`, { measure: measureLabel(measure) })
        }
        if (measure.calc && calcAlias(measure) === name) {
          return t('data.explore.calc.of', {
            measure: measureLabel(measure),
            calc: t(`data.explore.calc.${measure.calc}`),
          })
        }
        if (lagAlias(measure) === name) {
          return t('data.explore.calc.lag', { measure: measureLabel(measure) })
        }
      }
      return name
    },
    [byKey, plan.groups, plan.measures, measureLabel, locale, t],
  )

  const valueLabels = useMemo(
    () =>
      new Map(
        [...fieldOptions].map(([key, options]) => [key, optionLabels(options, locale)] as const),
      ),
    [fieldOptions, locale],
  )
  const relabelled = useLabelledResult(result, valueLabels)

  // Результат с подписями мер — ими пользуются и таблица, и оси графика
  const labelled = useMemo<QueryResult | undefined>(() => {
    if (!relabelled) return undefined
    return {
      ...relabelled,
      fields: relabelled.fields.map((field) => ({
        ...field,
        label: field.label ?? { ru: columnLabel(field.name) },
      })),
    }
  }, [relabelled, columnLabel])

  return { columnLabel, labelled }
}
