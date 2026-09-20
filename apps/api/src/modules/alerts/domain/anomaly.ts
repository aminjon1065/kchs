import type { AlertAnomalyCondition, AlertCompareOp } from '@kchs/contracts'

/**
 * Условия алертов (06-analytics-engine.md §14, ADR-0104) — чистые функции:
 * порог, изменение в процентах и отклонение по z-score с учётом сезонности.
 * Их считает и задание проверки, и тестовый прогон — одним кодом.
 */

export interface SeriesPoint {
  /** Начало единицы периода, `ГГГГ-ММ-ДД`. */
  period: string
  value: number | null
}

/** Выполняется ли сравнение с порогом. */
export function compare(value: number, op: AlertCompareOp, threshold: number): boolean {
  switch (op) {
    case 'gt':
      return value > threshold
    case 'gte':
      return value >= threshold
    case 'lt':
      return value < threshold
    case 'lte':
      return value <= threshold
  }
}

/** Изменение к базе в процентах; null — база нулевая или значения нет. */
export function changePercent(value: number | null, base: number | null): number | null {
  if (value === null || base === null || base === 0) return null
  return ((value - base) / Math.abs(base)) * 100
}

/** День недели даты `ГГГГ-ММ-ДД`: 0 — воскресенье. */
function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay()
}

function dayOfMonth(day: string): number {
  return Number(day.slice(8, 10))
}

/** Минимум точек основы: на меньшем отклонение неустойчиво. */
const MIN_BASELINE = 4

export interface AnomalyResult {
  /** Отклонение в единицах стандартного отклонения; null — основы не хватило. */
  score: number | null
  value: number | null
  /** Среднее основы — показываем в сообщении как «обычно». */
  mean: number | null
  reason: string | null
}

/**
 * Отклонение последней точки истории от её основы. Сезонность оставляет в
 * основе только сопоставимые точки: те же дни недели или те же числа месяца —
 * иначе понедельник вечно выглядел бы аномалией после выходных.
 */
export function anomaly(
  series: readonly SeriesPoint[],
  condition: AlertAnomalyCondition,
): AnomalyResult {
  const known = series.filter((point) => point.value !== null)
  const last = known[known.length - 1]
  if (!last || last.value === null) {
    return { score: null, value: null, mean: null, reason: 'нет значений истории' }
  }
  const history = known.slice(0, -1).slice(-condition.points)
  const baseline =
    condition.seasonality === 'weekly'
      ? history.filter((point) => weekday(point.period) === weekday(last.period))
      : condition.seasonality === 'monthly'
        ? history.filter((point) => dayOfMonth(point.period) === dayOfMonth(last.period))
        : history

  if (baseline.length < MIN_BASELINE) {
    return {
      score: null,
      value: last.value,
      mean: null,
      reason: `для оценки нужно не меньше ${MIN_BASELINE} сопоставимых точек истории`,
    }
  }
  const values = baseline.map((point) => point.value as number)
  const mean = values.reduce((sum, item) => sum + item, 0) / values.length
  const variance = values.reduce((sum, item) => sum + (item - mean) ** 2, 0) / (values.length - 1)
  const sd = Math.sqrt(variance)
  if (!Number.isFinite(sd) || sd === 0) {
    return { score: null, value: last.value, mean, reason: 'история без разброса' }
  }
  return { score: (last.value - mean) / sd, value: last.value, mean, reason: null }
}
