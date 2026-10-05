import type { NumberTileModel } from '@kchs/chart-spec'
import type { FieldFormat, Locale, MetricPeriod, MetricValue } from '@kchs/contracts'
import { formatCompactNumber, formatDate, formatNumber, formatPercent } from '@kchs/fields'

type Translate = (key: string, params?: Record<string, string | number>) => string

/** Периоды на выбор в карточке и плитке: календарные единицы, последние дни, всё время. */
export const METRIC_PERIOD_PRESETS = [
  'today',
  'week',
  'month',
  'quarter',
  'year',
  'last7',
  'last30',
  'last90',
  'all',
] as const
export type MetricPeriodPreset = (typeof METRIC_PERIOD_PRESETS)[number]

const LAST_DAYS: Partial<Record<MetricPeriodPreset, number>> = { last7: 7, last30: 30, last90: 90 }

export function presetPeriod(preset: MetricPeriodPreset): MetricPeriod | null {
  if (preset === 'all') return null
  if (preset === 'today') return { unit: 'day', from: 0, to: 0 }
  const days = LAST_DAYS[preset]
  if (days) return { unit: 'day', from: 1 - days, to: 0 }
  return { unit: preset as 'week' | 'month' | 'quarter' | 'year', from: 0, to: 0 }
}

/** Пресет периода или `custom` — диапазон дат и прочие относительные периоды. */
export function periodPreset(period: MetricPeriod | null): MetricPeriodPreset | 'custom' {
  const found = METRIC_PERIOD_PRESETS.find(
    (preset) => JSON.stringify(presetPeriod(preset)) === JSON.stringify(period),
  )
  return found ?? 'custom'
}

/**
 * Подпись периода: «Сегодня», «Этот месяц», «Вчера», «Последние 14 дней»,
 * «01.03.2026 — 31.03.2026»; прочие относительные периоды — единицами отсчёта.
 */
export function periodText(period: MetricPeriod | null, t: Translate, locale: Locale): string {
  const preset = periodPreset(period)
  if (preset !== 'custom') return t(`data.metric.periods.${preset}`)
  if (period && 'start' in period) {
    return `${formatDate(period.start, { locale })} — ${formatDate(period.end, { locale })}`
  }
  if (period) {
    if (period.from === -1 && period.to === -1) return t(`data.metric.previousUnit.${period.unit}`)
    if (period.to === 0)
      return t(`data.metric.lastUnits.${period.unit}`, { count: 1 - period.from })
    return t('data.metric.periodRelative', {
      unit: t(`data.metric.units.${period.unit}`),
      from: period.from,
      to: period.to,
    })
  }
  return t('data.metric.periods.all')
}

/** Число показателя по его формату; от миллиона — компактно («1,2 млн»). */
export function formatMetricNumber(
  value: number,
  format: FieldFormat | null,
  locale: Locale,
): string {
  if (Math.abs(value) >= 1_000_000 && format?.scale !== 'percent') {
    return formatCompactNumber(value, { locale }, { threshold: 1_000_000, format: format ?? {} })
  }
  if (format?.scale === 'percent') return formatPercent(value, format, { locale })
  return formatNumber(value, format ?? {}, { locale })
}

/**
 * Модель плитки `NumberTile` из значения показателя. Значение, база, дельта,
 * статус и история посчитаны сервером (ADR-0058) — здесь только форматирование.
 */
export function metricTileModel(
  value: MetricValue,
  t: Translate,
  locale: Locale,
  label?: string | null,
): NumberTileModel {
  const format = (n: number) => formatMetricNumber(n, value.format, locale)
  const delta = value.delta
  const sign = delta?.direction === 'up' ? '+' : delta?.direction === 'down' ? '−' : ''
  const target =
    value.target !== null && value.value !== null
      ? {
          value: value.target,
          formatted: format(value.target),
          // «Меньше — лучше»: цель достигнута, когда значение опустилось до неё
          progress:
            value.direction === 'down'
              ? value.value > 0
                ? value.target / value.value
                : 1
              : value.target !== 0
                ? value.value / value.target
                : 0,
          label: t('data.metric.targetValue', { value: format(value.target) }),
        }
      : null
  return {
    label: label || value.name,
    value: value.value,
    formatted: value.value === null ? t('data.metric.none') : format(value.value),
    unit: value.unit,
    delta: delta
      ? {
          value: delta.relative ?? delta.absolute,
          formatted: `${sign}${
            delta.relative !== null
              ? formatPercent(Math.abs(delta.relative), { precision: 1 }, { locale })
              : format(Math.abs(delta.absolute))
          }`,
          direction: delta.direction,
          good: delta.good,
          label: t(`data.metric.compareLabels.${value.comparison}`),
        }
      : null,
    target,
    status: value.status,
    spark: value.series.flatMap((point) => (point.value === null ? [] : [point.value])),
  }
}
