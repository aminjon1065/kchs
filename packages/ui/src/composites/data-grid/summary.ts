/** Сводка по выделению для подвала: количество, для чисел — сумма и среднее. */

export interface SelectionSummary {
  /** Выделено ячеек. */
  cells: number
  /** Непустых значений среди загруженных. */
  filled: number
  /** Числа: сумма и среднее по загруженным значениям. */
  sum: number | null
  avg: number | null
  /** Часть выделенных строк не загружена — сводка неполная. */
  partial: boolean
}

export function summarize(
  values: unknown[],
  cells: number,
  numeric: boolean,
  partial: boolean,
): SelectionSummary {
  let filled = 0
  let sum = 0
  let numbers = 0
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue
    filled += 1
    if (numeric) {
      const number = typeof value === 'number' ? value : Number(value)
      if (Number.isFinite(number)) {
        sum += number
        numbers += 1
      }
    }
  }
  return {
    cells,
    filled,
    sum: numeric && numbers > 0 ? sum : null,
    avg: numeric && numbers > 0 ? sum / numbers : null,
    partial,
  }
}
