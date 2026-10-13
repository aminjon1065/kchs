import type { RenderColumn } from './layout.js'
import { cellValue, type OverlayMap } from './overlay.js'
import {
  countRows,
  type GridBounds,
  isMultiple,
  type SelectionState,
  selectedColumns,
  selectedRows,
} from './selection.js'
import type { DataGridRow } from './types.js'

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

/** Ячеек в сводке по выделению и в копировании за раз. */
const MAX_SUMMARY_CELLS = 50_000

/** Сводка по выделенным ячейкам: числа — только по загруженным строкам и не больше предела. */
export function selectionSummary(
  selection: SelectionState,
  bounds: GridBounds,
  columns: readonly RenderColumn[],
  getRow: (index: number) => DataGridRow | undefined,
  overlay: OverlayMap,
): SelectionSummary | null {
  // Выделены строки целиком: сумма по разным столбцам смысла не имеет — только счёт строк
  if (selection.rows || !isMultiple(selection)) return null
  const cols = selectedColumns(selection, bounds)
  if (!cols) return null
  const spans = selectedRows(selection, bounds)
  const cells = countRows(spans) * (cols[1] - cols[0] + 1)
  const numeric = columns.slice(cols[0], cols[1] + 1).filter((col) => col.numeric)
  if (numeric.length === 0) return summarize([], cells, false, false)
  const values: unknown[] = []
  let partial = false
  outer: for (const [start, end] of spans) {
    for (let rowIndex = start; rowIndex <= end; rowIndex++) {
      const row = getRow(rowIndex)
      if (!row) {
        partial = true
        continue
      }
      for (const col of numeric) values.push(cellValue(row, col.key, overlay))
      if (values.length >= MAX_SUMMARY_CELLS) {
        partial = true
        break outer
      }
    }
  }
  return summarize(values, cells, true, partial)
}
