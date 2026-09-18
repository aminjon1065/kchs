/**
 * Модель выделения DataGrid (04-interaction-patterns.md §1): активная ячейка,
 * диапазон от опорной ячейки, строки через номер строки (Shift — подряд,
 * ⌘/Ctrl — выборочно). Чистые функции: компонент хранит только состояние.
 * Индексы столбцов — позиции среди видимых столбцов.
 */

export interface CellPos {
  row: number
  col: number
}

/** Диапазон ячеек, границы включительно. */
export interface GridRange {
  top: number
  bottom: number
  left: number
  right: number
}

/** Строки, выделенные через номер строки: отсортированные непересекающиеся отрезки. */
export type RowSpans = ReadonlyArray<readonly [number, number]>

export interface SelectionState {
  /** Активная ячейка — фокус клавиатуры. */
  active: CellPos | null
  /** Опорная ячейка: Shift расширяет диапазон от неё. */
  anchor: CellPos | null
  /** Выделенные строки; null — выделен диапазон ячеек. */
  rows: RowSpans | null
}

export interface GridBounds {
  rows: number
  cols: number
}

export const EMPTY_SELECTION: SelectionState = { active: null, anchor: null, rows: null }

export function clampPos(pos: CellPos, bounds: GridBounds): CellPos {
  return {
    row: Math.max(0, Math.min(bounds.rows - 1, pos.row)),
    col: Math.max(0, Math.min(bounds.cols - 1, pos.col)),
  }
}

/** Диапазон ячеек выделения; при выделении строк — null. */
export function rangeOf(state: SelectionState): GridRange | null {
  if (state.rows || !state.active) return null
  const anchor = state.anchor ?? state.active
  return {
    top: Math.min(anchor.row, state.active.row),
    bottom: Math.max(anchor.row, state.active.row),
    left: Math.min(anchor.col, state.active.col),
    right: Math.max(anchor.col, state.active.col),
  }
}

/** Щелчок по ячейке; `extend` — Shift: диапазон от опорной ячейки. */
export function selectCell(
  state: SelectionState,
  pos: CellPos,
  bounds: GridBounds,
  extend = false,
): SelectionState {
  if (bounds.rows === 0 || bounds.cols === 0) return EMPTY_SELECTION
  const target = clampPos(pos, bounds)
  if (extend && state.active && !state.rows) {
    return { active: target, anchor: state.anchor ?? state.active, rows: null }
  }
  return { active: target, anchor: target, rows: null }
}

/** Сдвиг активной ячейки (стрелки, PgUp/PgDn); `extend` — расширить диапазон. */
export function moveBy(
  state: SelectionState,
  dRow: number,
  dCol: number,
  bounds: GridBounds,
  extend = false,
): SelectionState {
  const from = state.active ?? { row: 0, col: 0 }
  return selectCell(state, { row: from.row + dRow, col: from.col + dCol }, bounds, extend)
}

export type Edge = 'rowStart' | 'rowEnd' | 'gridStart' | 'gridEnd' | 'colStart' | 'colEnd'

/** Home/End, ⌘/Ctrl+Home/End, ⌘/Ctrl+стрелки — к краю строки, столбца или таблицы. */
export function moveToEdge(
  state: SelectionState,
  edge: Edge,
  bounds: GridBounds,
  extend = false,
): SelectionState {
  const from = state.active ?? { row: 0, col: 0 }
  const target: Record<Edge, CellPos> = {
    rowStart: { row: from.row, col: 0 },
    rowEnd: { row: from.row, col: bounds.cols - 1 },
    colStart: { row: 0, col: from.col },
    colEnd: { row: bounds.rows - 1, col: from.col },
    gridStart: { row: 0, col: 0 },
    gridEnd: { row: bounds.rows - 1, col: bounds.cols - 1 },
  }
  return selectCell(state, target[edge], bounds, extend)
}

/** Tab / Shift+Tab: вправо и влево с переходом на соседнюю строку. */
export function tabMove(state: SelectionState, back: boolean, bounds: GridBounds): SelectionState {
  const from = state.active ?? { row: 0, col: -1 }
  let { row, col } = from
  col += back ? -1 : 1
  if (col >= bounds.cols) {
    col = 0
    row += 1
  } else if (col < 0) {
    col = bounds.cols - 1
    row -= 1
  }
  if (row < 0 || row >= bounds.rows) return state
  return selectCell(state, { row, col }, bounds)
}

export function selectAll(bounds: GridBounds): SelectionState {
  if (bounds.rows === 0 || bounds.cols === 0) return EMPTY_SELECTION
  return {
    active: { row: 0, col: 0 },
    anchor: { row: bounds.rows - 1, col: bounds.cols - 1 },
    rows: null,
  }
}

/** Слияние отрезков строк: сортировка и объединение соприкасающихся. */
export function normalizeSpans(spans: ReadonlyArray<readonly [number, number]>): RowSpans {
  const sorted = spans
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)] as const)
    .sort((x, y) => x[0] - y[0])
  const out: Array<[number, number]> = []
  for (const [start, end] of sorted) {
    const last = out[out.length - 1]
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else out.push([start, end])
  }
  return out
}

function withoutRow(spans: RowSpans, row: number): RowSpans {
  const out: Array<readonly [number, number]> = []
  for (const [start, end] of spans) {
    if (row < start || row > end) out.push([start, end])
    else {
      if (start <= row - 1) out.push([start, row - 1])
      if (row + 1 <= end) out.push([row + 1, end])
    }
  }
  return out
}

export function hasRow(spans: RowSpans | null, row: number): boolean {
  if (!spans) return false
  let low = 0
  let high = spans.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const span = spans[mid] as readonly [number, number]
    if (row < span[0]) high = mid - 1
    else if (row > span[1]) low = mid + 1
    else return true
  }
  return false
}

export function countRows(spans: RowSpans | null): number {
  return spans ? spans.reduce((sum, [start, end]) => sum + end - start + 1, 0) : 0
}

/**
 * Щелчок по номеру строки: `single` — только эта строка, `extend` (Shift) —
 * подряд от опорной, `toggle` (⌘/Ctrl) — добавить или убрать строку.
 */
export function selectRow(
  state: SelectionState,
  row: number,
  bounds: GridBounds,
  mode: 'single' | 'extend' | 'toggle' = 'single',
): SelectionState {
  if (bounds.rows === 0) return EMPTY_SELECTION
  const target = Math.max(0, Math.min(bounds.rows - 1, row))
  const col = state.active?.col ?? 0
  const active = { row: target, col }
  if (mode === 'extend' && state.anchor) {
    // Как в электронных таблицах: отрезок от опорной строки заменяет прежний
    return { active, anchor: state.anchor, rows: normalizeSpans([[state.anchor.row, target]]) }
  }
  if (mode === 'toggle' && state.rows) {
    const spans = hasRow(state.rows, target)
      ? withoutRow(state.rows, target)
      : normalizeSpans([...state.rows, [target, target]])
    return { active, anchor: { row: target, col }, rows: spans.length > 0 ? spans : null }
  }
  return { active, anchor: { row: target, col }, rows: [[target, target]] }
}

/** Выделена ли ячейка: в диапазоне или в выделенной строке. */
export function isCellSelected(state: SelectionState, row: number, col: number): boolean {
  if (state.rows) return hasRow(state.rows, row)
  const range = rangeOf(state)
  return Boolean(
    range && row >= range.top && row <= range.bottom && col >= range.left && col <= range.right,
  )
}

/** Для строки: столбцы, попадающие в выделение (null — строка не выделена). */
export function rowSelectionSpan(
  state: SelectionState,
  row: number,
  cols: number,
): { left: number; right: number } | null {
  if (state.rows) return hasRow(state.rows, row) ? { left: 0, right: cols - 1 } : null
  const range = rangeOf(state)
  if (!range || row < range.top || row > range.bottom) return null
  return { left: range.left, right: range.right }
}

/** Таблица стала меньше (фильтр, скрытый столбец) — выделение не указывает за край. */
export function fitSelection(state: SelectionState, bounds: GridBounds): SelectionState {
  const { active, anchor, rows } = state
  if (!active) return state
  if (bounds.rows === 0 || bounds.cols === 0) return EMPTY_SELECTION
  const inside = (pos: CellPos | null) => !pos || (pos.row < bounds.rows && pos.col < bounds.cols)
  const lastRow = rows ? (rows[rows.length - 1]?.[1] ?? -1) : -1
  if (inside(active) && inside(anchor) && lastRow < bounds.rows) return state
  return selectCell(EMPTY_SELECTION, active, bounds)
}

/** Выделено больше одной ячейки или строки — есть что копировать и сводить. */
export function isMultiple(state: SelectionState): boolean {
  if (state.rows) return countRows(state.rows) > 0
  const range = rangeOf(state)
  return Boolean(range && (range.top !== range.bottom || range.left !== range.right))
}

/** Перечень выделенных ячеек по строкам (для копирования, очистки, сводки). */
export function selectedRows(state: SelectionState, bounds: GridBounds): RowSpans {
  if (state.rows) return state.rows
  const range = rangeOf(state)
  return range ? [[range.top, Math.min(range.bottom, bounds.rows - 1)]] : []
}

export function selectedColumns(
  state: SelectionState,
  bounds: GridBounds,
): [number, number] | null {
  if (state.rows) return bounds.cols > 0 ? [0, bounds.cols - 1] : null
  const range = rangeOf(state)
  return range ? [range.left, range.right] : null
}
