import { formatNumber, parseValue } from '@kchs/fields'
import {
  type ColumnDef,
  type ColumnSizingInfoState,
  type ColumnSizingState,
  functionalUpdate,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Loader2, Plus } from 'lucide-react'
import {
  type ClipboardEvent,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type MouseEvent as ReactMouseEvent,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { EmptyState, TableSkeleton } from '../../components/feedback.js'
import { useRowHeight } from '../../hooks/use-row-height.js'
import { useUiLocale, useUiT } from '../../i18n/ui-locale.js'
import { cn } from '../../lib/cn.js'
import { parseTsv, pasteTargets, splitAppend, toTsv } from './clipboard.js'
import { reconcileColumnState } from './column-state.js'
import { type EditorMove, GridEditor } from './grid-editor.js'
import { GridHeader, type HeaderAction } from './grid-header.js'
import { cellId, GridRow } from './grid-row.js'
import {
  type CellChange,
  dropChanges,
  type EditHistory,
  EMPTY_HISTORY,
  planRedo,
  planUndo,
  recordEdit,
} from './history.js'
import {
  clampWidth,
  type GridLayout,
  gutterWidth,
  HEADER_HEIGHT,
  initialWidth,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  type RenderColumn,
} from './layout.js'
import {
  type CellOverlay,
  cellKey,
  cellValue,
  type ErrorMap,
  type OverlayMap,
  settleOverlay,
  withoutCells,
} from './overlay.js'
import {
  type CellPos,
  countRows,
  EMPTY_SELECTION,
  fitSelection,
  hasRow,
  isMultiple,
  moveBy,
  moveToEdge,
  rangeOf,
  type SelectionState,
  selectAll,
  selectCell,
  selectedColumns,
  selectedRows,
  selectRow,
  tabMove,
} from './selection.js'
import { summarize } from './summary.js'
import type {
  DataGridColumnState,
  DataGridEditResult,
  DataGridProps,
  DataGridRow,
  DataGridSortItem,
} from './types.js'
import { copyText, displayText, editorKind, editText, isNumeric, sameValue } from './values.js'

const NO_ROWS: DataGridRow[] = []
const NO_SORT: DataGridSortItem[] = []
const NO_OVERLAY: OverlayMap = new Map()
const NO_ERRORS: ErrorMap = new Map()
const INITIAL_SIZING: ColumnSizingInfoState = {
  startOffset: null,
  startSize: null,
  deltaOffset: null,
  deltaPercentage: null,
  isResizingColumn: false,
  columnSizingStart: [],
}
/** Изменений за одну вставку или очистку — больше отправлять пакетом не стоит. */
const MAX_BATCH = 5_000
/** Новых строк за одну вставку — столько же принимает вставка строк датасета. */
const MAX_APPEND = 1_000
/** Ячеек в сводке по выделению и в копировании за раз. */
const MAX_SUMMARY_CELLS = 50_000
const MAX_COPY_CELLS = 200_000
const AUTOSIZE_MAX = 480

interface GridStatus {
  tone: 'info' | 'danger'
  text: string
}

interface EditingState {
  row: number
  col: number
  text: string
  selectAll: boolean
}

interface ApplyOptions {
  /** Сообщение в подвале после сохранения. */
  success?: GridStatus
  /** Отмена или повтор: история после применения и до него (для отката при отказе). */
  step?: { next: EditHistory; previous: EditHistory }
}

function useLatest<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/**
 * Слоты строк окна: строка, оставшаяся в окне, сохраняет слот (и не
 * перерисовывается), пришедшая занимает слот ушедшей — React переиспользует
 * её DOM-узлы вместо создания новых. Повторный вызов с тем же окном даёт
 * те же слоты, поэтому двойная отрисовка StrictMode безопасна.
 */
function useRowSlots(items: ReadonlyArray<{ index: number }>): ReadonlyMap<number, number> {
  const ref = useRef<ReadonlyMap<number, number>>(new Map())
  const previous = ref.current
  const next = new Map<number, number>()
  const taken = new Set<number>()
  let top = -1
  for (const slot of previous.values()) top = Math.max(top, slot)
  for (const { index } of items) {
    const slot = previous.get(index)
    if (slot === undefined) continue
    next.set(index, slot)
    taken.add(slot)
  }
  const free = [...previous.values()].filter((slot) => !taken.has(slot))
  for (const { index } of items) {
    if (!next.has(index)) next.set(index, free.pop() ?? ++top)
  }
  ref.current = next
  return next
}

/** Стабильная ссылка на обработчик со свежим замыканием — для мемоизированных детей. */
function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...args: A) => ref.current(...args), [])
}

/**
 * Таблица данных (03-ui/04-interaction-patterns.md §1, ADR-0008): модель
 * столбцов — TanStack Table, виртуализация строк и столбцов — TanStack
 * Virtual. Управляется снаружи и ничего не знает об API: строки даёт
 * `getRow(index)`, окна подгружает родитель по `onVisibleRangeChange`,
 * сортировка — серверная (`sort`/`onSortChange`), правки уходят пакетами
 * в `onEdit`. Выделение ячеек, диапазонов и строк, клавиатура как в
 * электронных таблицах, копирование и вставка TSV, отмена и повтор.
 *
 * `columns` и `getRow` — стабильные ссылки (useMemo/useCallback): новая
 * `getRow` означает «данные обновились» и перерисовывает видимые строки.
 */
export function DataGrid({
  columns,
  rowCount,
  totalCount,
  rowCountApprox = false,
  getRow,
  onVisibleRangeChange,
  sort = NO_SORT,
  onSortChange,
  onColumnFilter,
  filteredKeys,
  columnState,
  onColumnStateChange,
  onEdit,
  onAppendRows,
  onSelectionChange,
  onRowOpen,
  onRowPreview,
  readOnly = false,
  loading = false,
  empty,
  locale: localeProp,
  timezone,
  className,
  ...props
}: DataGridProps) {
  const t = useUiT()
  const uiLocale = useUiLocale()
  const locale = localeProp ?? uiLocale
  const ctx = useMemo(() => ({ locale, timezone }), [locale, timezone])
  const gridId = useId()
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowHeight = useRowHeight(scrollRef)
  const editable = !readOnly && Boolean(onEdit)

  // ─── Раскладка столбцов ────────────────────────────────────────────────────
  const [innerState, setInnerState] = useState<Partial<DataGridColumnState>>()
  const controlled = columnState !== undefined
  const state = useMemo(
    () => reconcileColumnState(columns, controlled ? columnState : innerState),
    [columns, controlled, columnState, innerState],
  )
  const stateRef = useLatest(state)
  const commitState = useStableCallback((next: DataGridColumnState) => {
    if (!controlled) setInnerState(next)
    onColumnStateChange?.(next)
  })

  // TanStack Table ведёт модель столбцов: порядок, видимость, закрепление и
  // ширины с перетаскиванием края. Строк в нём нет — их даёт getRow
  const [draftSizing, setDraftSizing] = useState<ColumnSizingState | null>(null)
  const draftRef = useRef<ColumnSizingState | null>(null)
  const [sizingInfo, setSizingInfo] = useState(INITIAL_SIZING)
  const sizingInfoRef = useRef(INITIAL_SIZING)
  const columnDefs = useMemo<Array<ColumnDef<DataGridRow>>>(
    () =>
      columns.map((column) => ({
        id: column.key,
        accessorFn: (row: DataGridRow) => row.values[column.key],
        size: initialWidth(column),
        minSize: column.minWidth ?? MIN_COLUMN_WIDTH,
        maxSize: MAX_COLUMN_WIDTH,
      })),
    [columns],
  )
  const columnVisibility = useMemo(
    () => Object.fromEntries(state.hidden.map((key) => [key, false])),
    [state.hidden],
  )
  const table = useReactTable({
    data: NO_ROWS,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: 'onChange',
    state: {
      columnOrder: state.order,
      columnSizing: draftSizing ?? state.widths,
      columnSizingInfo: sizingInfo,
      columnVisibility,
      columnPinning: { left: state.pinned, right: [] },
    },
    onColumnSizingChange: (updater) => {
      const next = functionalUpdate(updater, draftRef.current ?? stateRef.current.widths)
      draftRef.current = next
      setDraftSizing(next)
    },
    // Применяется сразу, а не в функции-обновителе React: обновитель TanStack
    // сам меняет ширины, а побочные эффекты в обновителях состояния запрещены
    onColumnSizingInfoChange: (updater) => {
      const next = functionalUpdate(updater, sizingInfoRef.current)
      sizingInfoRef.current = next
      setSizingInfo(next)
    },
  })
  const resizingKey = sizingInfo.isResizingColumn || null
  // Перетаскивание края закончилось — ширины уходят в раскладку одним изменением
  useEffect(() => {
    if (resizingKey || !draftRef.current) return
    const widths = Object.fromEntries(
      Object.entries(draftRef.current).map(([key, width]) => [key, Math.round(width)]),
    )
    draftRef.current = null
    setDraftSizing(null)
    commitState({ ...stateRef.current, widths })
  }, [resizingKey, commitState, stateRef])

  const gutter = gutterWidth(rowCount)
  // biome-ignore lint/correctness/useExhaustiveDependencies: table — один экземпляр, его состояние (раскладка и черновик ширин) — в зависимостях
  const layout = useMemo<GridLayout>(() => {
    const byKey = new Map(columns.map((column) => [column.key, column]))
    const out: RenderColumn[] = []
    let left = gutter
    const push = (key: string, width: number, pinned: boolean) => {
      const column = byKey.get(key)
      if (!column) return
      const kind = editorKind(column)
      out.push({
        key,
        index: out.length,
        column,
        width,
        left,
        pinned,
        lastPinned: false,
        numeric: isNumeric(column.type),
        editor: editable && column.editable ? kind : null,
      })
      left += width
    }
    for (const column of table.getLeftVisibleLeafColumns()) push(column.id, column.getSize(), true)
    const pinnedCount = out.length
    const last = out[pinnedCount - 1]
    if (last) last.lastPinned = true
    const pinnedWidth = left - gutter
    for (const column of table.getCenterVisibleLeafColumns()) {
      push(column.id, column.getSize(), false)
    }
    return { columns: out, pinnedCount, gutter, pinnedWidth, totalWidth: left }
  }, [table, columns, columnDefs, state, draftSizing, gutter, editable])
  const layoutRef = useLatest(layout)
  const pinnedCount = layout.pinnedCount
  const leading = layout.gutter + layout.pinnedWidth

  // ─── Виртуализация ────────────────────────────────────────────────────────
  const columnKey = useCallback(
    (index: number) => layout.columns[pinnedCount + index]?.key ?? index,
    [layout, pinnedCount],
  )
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: layout.columns.length - pinnedCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => layout.columns[pinnedCount + index]?.width ?? MIN_COLUMN_WIDTH,
    getItemKey: columnKey,
    paddingStart: leading,
    scrollPaddingStart: leading,
    overscan: 2,
  })
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    paddingStart: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    overscan: 6,
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: пересчёт позиций при смене плотности
  useLayoutEffect(() => {
    rowVirtualizer.measure()
  }, [rowHeight, rowVirtualizer])

  const rowItems = rowVirtualizer.getVirtualItems()
  const rowSlots = useRowSlots(rowItems)
  const columnItems = columnVirtualizer.getVirtualItems()
  const colStart = pinnedCount + (columnItems[0]?.index ?? 0)
  const colEnd = pinnedCount + (columnItems[columnItems.length - 1]?.index ?? -1)
  const firstRow = rowItems[0]?.index ?? 0
  const lastRow = rowItems[rowItems.length - 1]?.index ?? -1

  const onRangeRef = useLatest(onVisibleRangeChange)
  useEffect(() => {
    if (lastRow >= firstRow) onRangeRef.current?.(firstRow, lastRow + 1)
  }, [firstRow, lastRow, onRangeRef])

  // ─── Состояние ─────────────────────────────────────────────────────────────
  const bounds = useMemo(
    () => ({ rows: rowCount, cols: layout.columns.length }),
    [rowCount, layout.columns.length],
  )
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION)
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [overlay, setOverlay] = useState<OverlayMap>(NO_OVERLAY)
  const [errors, setErrors] = useState<ErrorMap>(NO_ERRORS)
  const [history, setHistory] = useState<EditHistory>(EMPTY_HISTORY)
  const [status, setStatus] = useState<GridStatus | null>(null)
  const [pending, setPending] = useState(0)
  const [focused, setFocused] = useState(false)
  const [menuKey, setMenuKey] = useState<string | null>(null)
  /** «Добавить строки»: следующая вставка — новыми строками в конец таблицы. */
  const [appendArmed, setAppendArmed] = useState(false)
  const overlayRef = useLatest(overlay)
  const historyRef = useLatest(history)
  const dragRef = useRef<'cells' | 'rows' | null>(null)
  const measureRef = useRef<CanvasRenderingContext2D | null>(null)

  useEffect(() => {
    setSelection((current) => fitSelection(current, bounds))
    setEditing((current) =>
      current && (current.row >= bounds.rows || current.col >= bounds.cols) ? null : current,
    )
  }, [bounds])

  // Новые данные от родителя: сохранённые правки, которые данные уже отражают, снимаются
  const lastGetRow = useRef(getRow)
  useEffect(() => {
    if (lastGetRow.current === getRow) return
    lastGetRow.current = getRow
    setOverlay((current) => settleOverlay(current, getRow))
  }, [getRow])

  const onSelectionRef = useLatest(onSelectionChange)
  const boundsRef = useLatest(bounds)
  useEffect(() => {
    const callback = onSelectionRef.current
    if (!callback) return
    const active = selection.active
    const column = active ? layoutRef.current.columns[active.col] : undefined
    const spans = selectedRows(selection, boundsRef.current)
    const cols = selectedColumns(selection, boundsRef.current)
    const rows = countRows(spans)
    callback({
      active: active && column ? { rowIndex: active.row, key: column.key } : null,
      rows,
      cells: cols ? rows * (cols[1] - cols[0] + 1) : 0,
      rowSpans: spans,
    })
  }, [selection, onSelectionRef, layoutRef, boundsRef])

  useEffect(() => {
    const up = () => {
      dragRef.current = null
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [])

  // ─── Правка ───────────────────────────────────────────────────────────────
  const valueAt = (row: DataGridRow, key: string) => cellValue(row, key, overlayRef.current)

  const changeFor = (rowIndex: number, col: RenderColumn, value: unknown): CellChange | null => {
    const row = getRow(rowIndex)
    if (!row) return null
    const previous = valueAt(row, col.key)
    if (sameValue(previous, value)) return null
    return { rowId: row.id, rowIndex, key: col.key, previous, value }
  }

  /**
   * Пакет изменений: сразу виден в ячейках, уходит в `onEdit`; отказ сервера
   * (целиком или по ячейкам) откатывает ячейки и объясняет причину в подвале.
   */
  const applyChanges = useStableCallback(
    async (changes: CellChange[], options: ApplyOptions = {}) => {
      if (!onEdit || changes.length === 0) {
        if (options.success) setStatus(options.success)
        return
      }
      const token = {}
      setOverlay((current) => {
        const next = new Map<string, CellOverlay>(current)
        for (const change of changes) {
          next.set(cellKey(change.rowId, change.key), {
            rowId: change.rowId,
            rowIndex: change.rowIndex,
            key: change.key,
            value: change.value,
            token,
            status: 'pending',
            generation: 0,
          })
        }
        return next
      })
      setErrors((current) => withoutCells(current, changes))
      const step = options.step
      setHistory((current) => (step ? step.next : recordEdit(current, changes)))
      setPending((count) => count + 1)
      setStatus(null)

      let rejected: NonNullable<DataGridEditResult['rejected']> = []
      let failure: string | null = null
      try {
        rejected = (await onEdit(changes))?.rejected ?? []
      } catch (error) {
        failure = error instanceof Error ? error.message : ''
      }
      setPending((count) => count - 1)

      const reasons = new Map(rejected.map((item) => [cellKey(item.rowId, item.key), item.message]))
      const dropped = new Set(
        failure !== null
          ? changes
          : changes.filter((change) => reasons.has(cellKey(change.rowId, change.key))),
      )
      setOverlay((current) => {
        const next = new Map<string, CellOverlay>(current)
        for (const change of changes) {
          const key = cellKey(change.rowId, change.key)
          const entry = next.get(key)
          if (!entry || entry.token !== token) continue
          if (dropped.has(change)) next.delete(key)
          else next.set(key, { ...entry, status: 'saved' })
        }
        return next
      })
      if (dropped.size === 0) {
        if (options.success) setStatus(options.success)
        return
      }
      setErrors((current) => {
        const next = new Map(current)
        for (const change of dropped) {
          const key = cellKey(change.rowId, change.key)
          next.set(key, reasons.get(key) ?? failure ?? '')
        }
        return next
      })
      if (step) setHistory((current) => (current === step.next ? step.previous : current))
      else setHistory((current) => dropChanges(current, changes, dropped))
      const message = rejected[0]?.message || failure
      const reason = message ? t('ui.grid.saveFailed', { message }) : t('ui.grid.notSaved')
      // Отчёт о вставке остаётся рядом с причиной отказа
      const report = options.success?.text
      setStatus({ tone: 'danger', text: report ? `${reason} · ${report}` : reason })
    },
  )

  /** Ячейка в поле зрения; переход в закреплённый столбец (Home, ←) — к началу по горизонтали. */
  const scrollToCell = (pos: CellPos, from?: CellPos | null) => {
    rowVirtualizer.scrollToIndex(pos.row, { align: 'auto' })
    if (pos.col >= pinnedCount) {
      columnVirtualizer.scrollToIndex(pos.col - pinnedCount, { align: 'auto' })
    } else if (from?.col !== pos.col) {
      columnVirtualizer.scrollToOffset(0)
    }
  }

  const select = (next: SelectionState) => {
    const from = selection.active
    setSelection(next)
    if (next.active) scrollToCell(next.active, from)
  }

  const focusGrid = () => scrollRef.current?.focus({ preventScroll: true })

  const toggleBoolean = (pos: CellPos) => {
    const col = layout.columns[pos.col]
    const row = getRow(pos.row)
    if (!row || !col || col.editor !== 'boolean') return
    const change = changeFor(pos.row, col, !valueAt(row, col.key))
    if (change) void applyChanges([change])
  }

  const startEditing = (pos: CellPos, seed: string | null): boolean => {
    const col = layout.columns[pos.col]
    const row = getRow(pos.row)
    if (!col?.editor || !row) return false
    if (col.editor === 'boolean') {
      toggleBoolean(pos)
      return true
    }
    scrollToCell(pos, pos)
    setEditing({
      row: pos.row,
      col: pos.col,
      text: seed ?? editText(valueAt(row, col.key), col.column, ctx),
      selectAll: seed === null,
    })
    return true
  }

  const finishEditing = (value: unknown, move: EditorMove, refocus: boolean) => {
    const current = editing
    setEditing(null)
    if (current) {
      const col = layout.columns[current.col]
      const change = col ? changeFor(current.row, col, value) : null
      if (change) void applyChanges([change])
      if (move === 'down' || move === 'up') {
        select(moveBy(selection, move === 'down' ? 1 : -1, 0, bounds))
      } else if (move) select(tabMove(selection, move === 'left', bounds))
    }
    if (refocus) focusGrid()
  }

  const cancelEditing = (invalid: boolean, refocus: boolean) => {
    const current = editing
    setEditing(null)
    const col = current ? layout.columns[current.col] : undefined
    if (invalid && col) {
      setStatus({ tone: 'danger', text: t('ui.grid.invalid', { name: col.column.label }) })
    }
    if (refocus) focusGrid()
  }

  /** Строки выделения по порядку: загруженные — с данными, остальные — undefined. */
  const eachSelectedRow = (visit: (rowIndex: number, row: DataGridRow | undefined) => boolean) => {
    for (const [start, end] of selectedRows(selection, bounds)) {
      for (let rowIndex = start; rowIndex <= end; rowIndex++) {
        if (!visit(rowIndex, getRow(rowIndex))) return
      }
    }
  }

  const clearSelected = () => {
    const cols = selectedColumns(selection, bounds)
    if (!cols) return
    const changes: CellChange[] = []
    eachSelectedRow((rowIndex, row) => {
      if (!row) return true
      for (let c = cols[0]; c <= cols[1]; c++) {
        const col = layout.columns[c]
        if (!col?.editor) continue
        const change = changeFor(rowIndex, col, null)
        if (change) changes.push(change)
      }
      return changes.length < MAX_BATCH
    })
    if (changes.length === 0) return
    void applyChanges(changes, {
      success: { tone: 'info', text: t('ui.grid.cleared', { count: changes.length }) },
    })
  }

  const copySelected = (): { text: string; cells: number; partial: boolean } | null => {
    const cols = selectedColumns(selection, bounds)
    if (!cols) return null
    const lines: string[][] = []
    let cells = 0
    let partial = false
    eachSelectedRow((_, row) => {
      if (!row) {
        partial = true
        return true
      }
      const line: string[] = []
      for (let c = cols[0]; c <= cols[1]; c++) {
        const col = layout.columns[c]
        if (col) line.push(copyText(valueAt(row, col.key), col.column, ctx))
      }
      lines.push(line)
      cells += line.length
      if (cells < MAX_COPY_CELLS) return true
      partial = true
      return false
    })
    return lines.length > 0 ? { text: toTsv(lines), cells, partial } : null
  }

  /**
   * Вставка. После «Добавить строки» (`appendArmed`) все строки буфера —
   * новые строки в конец таблицы, начиная со столбца активной ячейки.
   */
  const pasteText = (text: string) => {
    const append = appendArmed && Boolean(onAppendRows)
    if (appendArmed) setAppendArmed(false)
    const matrix = parseTsv(text)
    const range = append ? null : rangeOf(selection)
    const firstSpan = append ? undefined : selection.rows?.[0]
    const start = range
      ? { row: range.top, col: range.left }
      : firstSpan
        ? { row: firstSpan[0], col: 0 }
        : onAppendRows
          ? // Режим добавления или ничего не выделено (пустая таблица) — строки в конец
            { row: bounds.rows, col: append ? (selection.active?.col ?? 0) : 0 }
          : null
    if (!start || matrix.length === 0) return
    const split = onAppendRows ? splitAppend(matrix, start, bounds) : null
    const { targets, clipped } = pasteTargets(split ? split.existing : matrix, start, range, bounds)
    const added = split ? rowsToAppend(split.appended, start.col) : null

    const changes: CellChange[] = []
    const invalid: Array<{ text: string; col: RenderColumn; rowId: string }> = []
    let skipped = 0
    let unchanged = 0
    let overflow = 0
    for (const target of targets) {
      if (changes.length >= MAX_BATCH) {
        overflow += 1
        continue
      }
      const col = layout.columns[target.col]
      const row = getRow(target.row)
      if (!col?.editor || !row) {
        skipped += 1
        continue
      }
      const parsed = parseValue(target.text, col.column, ctx)
      if (!parsed.ok) {
        invalid.push({ text: target.text, col, rowId: row.id })
        continue
      }
      const change = changeFor(target.row, col, parsed.value)
      if (change) changes.push(change)
      else unchanged += 1
    }

    // Вставленный блок остаётся выделенным
    const last = targets[targets.length - 1]
    if (last) setSelection({ active: start, anchor: { row: last.row, col: last.col }, rows: null })
    if (invalid.length > 0) {
      setErrors((current) => {
        const next = new Map(current)
        for (const item of invalid) {
          next.set(
            cellKey(item.rowId, item.col.key),
            t('ui.grid.invalid', { name: item.col.column.label }),
          )
        }
        return next
      })
    }

    if (added?.invalid) {
      const bad = added.invalid
      setStatus({
        tone: 'danger',
        text: t('ui.grid.appendInvalid', {
          row: bad.row + 1,
          value: bad.text,
          name: bad.col.column.label,
        }),
      })
      return
    }

    const parts =
      targets.length > 0 ? [t('ui.grid.pasted', { count: changes.length + unchanged })] : []
    if (invalid.length > 0) {
      const examples = invalid
        .slice(0, 3)
        .map((item) => t('ui.grid.pasteExample', { value: item.text, name: item.col.column.label }))
        .join(', ')
      parts.push(t('ui.grid.pasteInvalid', { count: invalid.length, examples }))
    }
    if (skipped > 0) parts.push(t('ui.grid.pasteSkipped', { count: skipped }))
    const outside = clipped + overflow + (split?.clipped ?? 0) + (added?.overflow ?? 0)
    if (outside > 0) parts.push(t('ui.grid.pasteClipped', { count: outside }))
    const report: GridStatus = {
      tone: invalid.length > 0 || skipped > 0 ? 'danger' : 'info',
      text: parts.join(' · '),
    }
    void (async () => {
      if (changes.length > 0) await applyChanges(changes, { success: report })
      else if (!added?.rows.length) setStatus(report)
      if (added?.rows.length) await appendRows(added.rows, changes.length > 0 ? null : report.text)
    })()
  }

  /**
   * Строки вставки ниже последней — значения по столбцам, начиная со `startCol`:
   * пустые и только для чтения пропускаются, строка заголовков отбрасывается.
   * Первое нераспознанное значение останавливает добавление целиком.
   */
  const rowsToAppend = (lines: string[][], startCol: number) => {
    const columnAt = (offset: number) => layout.columns[startCol + offset]
    const header = (cells: string[]) =>
      cells.length > 0 &&
      cells.every(
        (text, offset) =>
          text.trim().toLowerCase() === columnAt(offset)?.column.label.trim().toLowerCase(),
      )
    const data = lines.length > 0 && header(lines[0] ?? []) ? lines.slice(1) : lines
    const rows: Array<Record<string, unknown>> = []
    for (const [index, cells] of data.slice(0, MAX_APPEND).entries()) {
      const values: Record<string, unknown> = {}
      for (const [offset, text] of cells.entries()) {
        const col = columnAt(offset)
        if (!col?.editor || text.trim() === '') continue
        const parsed = parseValue(text, col.column, ctx)
        if (!parsed.ok) return { rows, overflow: 0, invalid: { row: index, text, col } }
        values[col.key] = parsed.value
      }
      if (Object.keys(values).length > 0) rows.push(values)
    }
    const overflow = data.slice(MAX_APPEND).reduce((sum, cells) => sum + cells.length, 0)
    return { rows, overflow, invalid: null }
  }

  /** Новые строки — родителю одним пакетом; итог и причина отказа — в подвале. */
  const appendRows = async (rows: Array<Record<string, unknown>>, report: string | null) => {
    if (!onAppendRows) return
    setPending((count) => count + 1)
    let message: string | null = null
    try {
      const rejected = (await onAppendRows(rows))?.rejected ?? []
      if (rejected.length > 0) message = rejected[0]?.message ?? ''
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    setPending((count) => count - 1)
    const text =
      message === null
        ? t('ui.grid.appended', { count: rows.length })
        : t('ui.grid.appendFailed', { message })
    setStatus({
      tone: message === null ? 'info' : 'danger',
      text: report ? `${text} · ${report}` : text,
    })
  }

  const undo = () => {
    const plan = planUndo(historyRef.current)
    if (!plan) return
    selectChanged(plan.apply)
    void applyChanges(plan.apply, {
      success: { tone: 'info', text: t('ui.grid.undone') },
      step: { next: plan.next, previous: historyRef.current },
    })
  }

  const redo = () => {
    const plan = planRedo(historyRef.current)
    if (!plan) return
    selectChanged(plan.apply)
    void applyChanges(plan.apply, {
      success: { tone: 'info', text: t('ui.grid.redone') },
      step: { next: plan.next, previous: historyRef.current },
    })
  }

  /** После отмены и повтора видно, какие ячейки изменились. */
  const selectChanged = (changes: CellChange[]) => {
    const cols = changes.map((change) => layout.columns.findIndex((col) => col.key === change.key))
    const rows = changes.map((change) => change.rowIndex)
    if (cols.some((col) => col < 0) || rows.some((row) => row >= rowCount)) return
    const top = Math.min(...rows)
    const left = Math.min(...cols)
    select({
      active: { row: top, col: left },
      anchor: { row: Math.max(...rows), col: Math.max(...cols) },
      rows: null,
    })
  }

  // ─── Столбцы ──────────────────────────────────────────────────────────────
  const toggleSort = (key: string, multi: boolean) => {
    if (!onSortChange) return
    const current = sort.find((item) => item.key === key)
    const dir = !current ? 'asc' : current.dir === 'asc' ? 'desc' : null
    if (!multi) {
      onSortChange(dir ? [{ key, dir }] : [])
      return
    }
    // Shift: порядок полей сохраняется, поле меняет направление на месте
    if (!current) onSortChange([...sort, { key, dir: 'asc' }])
    else if (dir) onSortChange(sort.map((item) => (item.key === key ? { key, dir } : item)))
    else onSortChange(sort.filter((item) => item.key !== key))
  }

  const reorderColumn = (key: string, target: string, after: boolean) => {
    const current = stateRef.current
    const pinned = current.pinned.includes(key)
    const list = (pinned ? current.pinned : current.order).filter((item) => item !== key)
    const at = list.indexOf(target)
    if (at < 0) return
    list.splice(after ? at + 1 : at, 0, key)
    commitState(pinned ? { ...current, pinned: list } : { ...current, order: list })
  }

  const autosize = (key: string) => {
    const col = layout.columns.find((item) => item.key === key)
    const grid = scrollRef.current
    if (!col || !grid) return
    const context = measureRef.current ?? document.createElement('canvas').getContext('2d')
    if (!context) return
    measureRef.current = context
    const style = getComputedStyle(grid)
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
    // Ширина по выборке: заголовок (со значком сортировки и меню) и загруженные видимые строки
    let width = context.measureText(col.column.label).width + 56
    for (const item of rowItems) {
      const row = getRow(item.index)
      if (!row) continue
      const text = displayText(valueAt(row, key), col.column, ctx)
      width = Math.max(width, context.measureText(text).width + 28)
    }
    const current = stateRef.current
    commitState({
      ...current,
      widths: {
        ...current.widths,
        [key]: clampWidth(Math.min(width, AUTOSIZE_MAX), col.column.minWidth),
      },
    })
  }

  const openMenu = (col: number) => {
    const column = layout.columns[col]
    if (!column) return
    if (col >= pinnedCount) columnVirtualizer.scrollToIndex(col - pinnedCount, { align: 'auto' })
    setMenuKey(column.key)
  }

  const onHeaderAction = useStableCallback((action: HeaderAction) => {
    const current = stateRef.current
    switch (action.type) {
      case 'sort':
        toggleSort(action.key, action.multi)
        break
      case 'sortDir':
        onSortChange?.(
          action.dir
            ? [{ key: action.key, dir: action.dir }]
            : sort.filter((item) => item.key !== action.key),
        )
        break
      case 'pin':
        commitState({
          ...current,
          pinned: action.pinned
            ? [...current.pinned, action.key]
            : current.pinned.filter((key) => key !== action.key),
        })
        break
      case 'move': {
        const index = layout.columns.findIndex((col) => col.key === action.key)
        const col = layout.columns[index]
        const neighbor = layout.columns[index + action.delta]
        if (col && neighbor && neighbor.pinned === col.pinned) {
          reorderColumn(action.key, neighbor.key, action.delta > 0)
        }
        break
      }
      case 'reorder':
        reorderColumn(action.key, action.target, action.after)
        break
      case 'autosize':
        autosize(action.key)
        break
      case 'hide':
        commitState({ ...current, hidden: [...current.hidden, action.key] })
        break
      case 'filter':
        onColumnFilter?.(action.key)
        break
      case 'menu':
        setMenuKey(action.key)
        break
      case 'selectAll':
        focusGrid()
        setSelection(selectAll(bounds))
        break
      case 'focus':
        focusGrid()
        break
    }
  })

  const onResizeStart = useStableCallback(
    (key: string, event: ReactMouseEvent | ReactTouchEvent) => {
      const header = table.getFlatHeaders().find((item) => item.column.id === key)
      header?.getResizeHandler()(event)
    },
  )

  // ─── События таблицы ──────────────────────────────────────────────────────
  const positionOf = (target: EventTarget | null): { row: number; col: number | null } | null => {
    if (!(target instanceof Element)) return null
    const rowElement = target.closest<HTMLElement>('[data-row]')
    if (!rowElement || !scrollRef.current?.contains(rowElement)) return null
    const cell = target.closest<HTMLElement>('[data-col]')
    return { row: Number(rowElement.dataset.row), col: cell ? Number(cell.dataset.col) : null }
  }

  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const pos = positionOf(event.target)
    if (!pos) return
    // Без выделения текста при протягивании; фокус — таблице (и правка сохраняется)
    event.preventDefault()
    focusGrid()
    if (pos.col === null) {
      const mode = event.shiftKey ? 'extend' : event.metaKey || event.ctrlKey ? 'toggle' : 'single'
      setSelection(selectRow(selection, pos.row, bounds, mode))
      dragRef.current = 'rows'
      return
    }
    const cell = { row: pos.row, col: pos.col }
    if (event.target instanceof Element && event.target.closest('[data-toggle]')) {
      setSelection(selectCell(selection, cell, bounds))
      toggleBoolean(cell)
      return
    }
    setSelection(selectCell(selection, cell, bounds, event.shiftKey))
    dragRef.current = 'cells'
  }

  const onMouseOver = (event: MouseEvent<HTMLDivElement>) => {
    const mode = dragRef.current
    if (!mode) return
    const pos = positionOf(event.target)
    if (!pos) return
    if (mode === 'rows') setSelection((current) => selectRow(current, pos.row, bounds, 'extend'))
    else if (pos.col !== null) {
      const cell = { row: pos.row, col: pos.col }
      setSelection((current) => selectCell(current, cell, bounds, true))
    }
  }

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const pos = positionOf(event.target)
    if (!pos) return
    const col = pos.col === null ? undefined : layout.columns[pos.col]
    if (pos.col !== null && col?.editor && col.editor !== 'boolean') {
      startEditing({ row: pos.row, col: pos.col }, null)
      return
    }
    const row = getRow(pos.row)
    if (row) onRowOpen?.(row, pos.row)
  }

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    setFocused(true)
    if (!selection.active && bounds.rows > 0 && bounds.cols > 0) {
      setSelection(selectCell(EMPTY_SELECTION, { row: firstRow, col: 0 }, bounds))
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) setFocused(false)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // События из поля правки, меню и других вложенных элементов таблица не трогает
    if (event.target !== event.currentTarget || event.nativeEvent.isComposing) return
    if (bounds.rows === 0 || bounds.cols === 0) return
    const mod = event.metaKey || event.ctrlKey
    const shift = event.shiftKey
    const active = selection.active
    const handled = () => {
      event.preventDefault()
      event.stopPropagation()
    }

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'ArrowLeft':
      case 'ArrowRight': {
        if (event.altKey) {
          if (event.key === 'ArrowDown' && active) {
            handled()
            openMenu(active.col)
          }
          return
        }
        handled()
        const vertical = event.key === 'ArrowDown' || event.key === 'ArrowUp'
        const sign = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
        if (selection.rows && vertical && shift && active) {
          select(selectRow(selection, active.row + sign, bounds, 'extend'))
        } else if (mod) {
          const edge = vertical
            ? sign > 0
              ? 'colEnd'
              : 'colStart'
            : sign > 0
              ? 'rowEnd'
              : 'rowStart'
          select(moveToEdge(selection, edge, bounds, shift))
        } else {
          select(moveBy(selection, vertical ? sign : 0, vertical ? 0 : sign, bounds, shift))
        }
        return
      }
      case 'Home':
      case 'End': {
        handled()
        const end = event.key === 'End'
        const edge = mod ? (end ? 'gridEnd' : 'gridStart') : end ? 'rowEnd' : 'rowStart'
        select(moveToEdge(selection, edge, bounds, shift))
        return
      }
      case 'PageDown':
      case 'PageUp': {
        handled()
        const viewport = (scrollRef.current?.clientHeight ?? 0) - HEADER_HEIGHT
        const page = Math.max(1, Math.floor(viewport / rowHeight) - 1)
        select(moveBy(selection, event.key === 'PageDown' ? page : -page, 0, bounds, shift))
        return
      }
      case 'Tab': {
        if (mod || event.altKey) return
        const next = tabMove(selection, shift, bounds)
        // На краю таблицы Tab уводит фокус дальше по странице
        if (next === selection) return
        handled()
        select(next)
        return
      }
      case 'Enter': {
        if (!active || mod || event.altKey) return
        handled()
        if (startEditing(active, null)) return
        const row = getRow(active.row)
        if (row && onRowOpen) onRowOpen(row, active.row)
        else explainReadOnly(active)
        return
      }
      case 'F2':
        if (active) {
          handled()
          if (!startEditing(active, null)) explainReadOnly(active)
        }
        return
      case ' ': {
        if (!active || mod) return
        handled()
        if (shift) {
          // Shift+Пробел — строки текущего диапазона целиком
          const current = rangeOf(selection)
          const top = current ? current.top : active.row
          const bottom = current ? current.bottom : active.row
          const anchor = { row: active.row === top ? bottom : top, col: active.col }
          setSelection({ active, anchor, rows: [[top, bottom]] })
          return
        }
        if (layout.columns[active.col]?.editor === 'boolean') {
          toggleBoolean(active)
          return
        }
        const row = getRow(active.row)
        if (row) onRowPreview?.(row, active.row)
        return
      }
      case 'Escape':
        if (appendArmed) setAppendArmed(false)
        if (status || errors.size > 0) {
          setStatus(null)
          setErrors(NO_ERRORS)
        }
        if (active && isMultiple(selection)) {
          handled()
          setSelection(selectCell(EMPTY_SELECTION, active, bounds))
        }
        return
      case 'Delete':
      case 'Backspace':
        if (!editable) return
        handled()
        clearSelected()
        return
      case 'ContextMenu':
        if (active) {
          handled()
          openMenu(active.col)
        }
        return
      case 'F10':
        if (shift && active) {
          handled()
          openMenu(active.col)
        }
        return
      default:
        break
    }

    if (mod && !event.altKey) {
      const key = event.key.toLowerCase()
      if (key === 'a') {
        handled()
        setSelection(selectAll(bounds))
      } else if (key === 'z' && editable) {
        handled()
        if (shift) redo()
        else undo()
      } else if (key === 'y' && event.ctrlKey && editable) {
        handled()
        redo()
      } else if (!shift && (key === 'c' || key === 'x' || key === 'v')) {
        // Без preventDefault: команду буфера выполнит браузер, но уже в скрытом поле
        routeClipboard(key === 'c' ? 'copy' : key === 'x' ? 'cut' : 'paste')
      }
      return
    }

    // Печатный символ начинает правку с этого символа
    if (active && event.key.length === 1 && !event.altKey) {
      const kind = layout.columns[active.col]?.editor
      if (kind && kind !== 'boolean') {
        handled()
        startEditing(active, event.key)
      } else if (!kind) explainReadOnly(active)
    }
  }

  /** Попытка править столбец только для чтения в правимой таблице — объяснение в подвале. */
  const explainReadOnly = (pos: CellPos) => {
    if (editable && !layout.columns[pos.col]?.editor) {
      setStatus({ tone: 'info', text: t('ui.grid.readOnly') })
    }
  }

  // ─── Буфер обмена ─────────────────────────────────────────────────────────
  // Команды буфера с клавиатуры браузер адресует выделенному тексту или полю
  // ввода, а не элементу с фокусом: у таблицы нет ни того, ни другого. Поэтому
  // ⌘C/⌘X/⌘V переводят фокус в скрытое поле (TSV выделен в нём целиком),
  // браузер выполняет команду там, и фокус возвращается в таблицу.
  const clipboardRef = useRef<HTMLTextAreaElement>(null)
  const copiedRef = useRef<{ cells: number; partial: boolean } | null>(null)

  const reportCopy = (copied: { cells: number; partial: boolean }) => {
    const text = t('ui.grid.copied', { count: copied.cells })
    setStatus({
      tone: 'info',
      text: copied.partial ? `${text} · ${t('ui.grid.copyPartial')}` : text,
    })
  }

  const routeClipboard = (kind: 'copy' | 'cut' | 'paste') => {
    const area = clipboardRef.current
    if (!area) return
    if (kind === 'paste') {
      if (!editable) return
      area.value = ''
    } else {
      const copied = copySelected()
      if (!copied) return
      copiedRef.current = copied
      area.value = copied.text
    }
    area.focus({ preventScroll: true })
    area.select()
    // Команда выполняется сразу после keydown, в той же задаче
    window.setTimeout(() => {
      if (document.activeElement === area) focusGrid()
    }, 0)
  }

  const onClipboardCopy = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const copied = copiedRef.current
    copiedRef.current = null
    if (!copied) return
    reportCopy(copied)
    if (event.type === 'cut' && editable) clearSelected()
  }

  const onClipboardPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    if (text) pasteText(text)
  }

  // Событие буфера, пришедшее прямо в таблицу (меню браузера, программная вставка)
  const onCopy = (event: ClipboardEvent<HTMLDivElement>): boolean => {
    if (event.target !== event.currentTarget) return false
    const copied = copySelected()
    if (!copied) return false
    event.preventDefault()
    event.clipboardData.setData('text/plain', copied.text)
    reportCopy(copied)
    return true
  }

  const onCut = (event: ClipboardEvent<HTMLDivElement>) => {
    if (onCopy(event) && editable) clearSelected()
  }

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || !editable) return
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    event.preventDefault()
    pasteText(text)
  }

  // ─── Отрисовка ────────────────────────────────────────────────────────────
  const active = selection.active
  const range = rangeOf(selection)
  const multiple = isMultiple(selection)
  const activeVisible =
    active !== null &&
    !editing &&
    active.row >= firstRow &&
    active.row <= lastRow &&
    (active.col < pinnedCount || (active.col >= colStart && active.col <= colEnd))

  const summary = useMemo(() => {
    // Выделены строки целиком: сумма по разным столбцам смысла не имеет — только счёт строк
    if (selection.rows || !isMultiple(selection)) return null
    const cols = selectedColumns(selection, bounds)
    if (!cols) return null
    const spans = selectedRows(selection, bounds)
    const cells = countRows(spans) * (cols[1] - cols[0] + 1)
    const numeric = layout.columns.slice(cols[0], cols[1] + 1).filter((col) => col.numeric)
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
  }, [selection, bounds, layout, getRow, overlay])

  const activeRow = active ? getRow(active.row) : undefined
  const activeColumn = active ? layout.columns[active.col] : undefined
  const activeError =
    activeRow && activeColumn && errors.size > 0
      ? errors.get(cellKey(activeRow.id, activeColumn.key))
      : undefined
  const message = activeError ? { tone: 'danger' as const, text: activeError } : status

  const counter =
    totalCount !== undefined && totalCount !== rowCount
      ? t('ui.grid.rowsOf', { shown: formatNumber(rowCount, {}, ctx), count: totalCount })
      : rowCountApprox
        ? t('ui.grid.rowsApprox', { count: rowCount })
        : t('ui.grid.rows', { count: rowCount })

  const editingColumn = editing ? layout.columns[editing.col] : undefined

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden bg-surface', className)}>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          role="grid"
          aria-label={props['aria-label']}
          aria-rowcount={rowCount + 1}
          aria-colcount={layout.columns.length + 1}
          aria-multiselectable
          aria-readonly={editable ? undefined : true}
          aria-busy={loading || undefined}
          aria-activedescendant={
            activeVisible && active ? cellId(gridId, active.row, active.col) : undefined
          }
          // Видна рамка активной ячейки — кольцо фокуса вокруг всей таблицы не нужно (base.css)
          data-cell-focus={activeVisible || undefined}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onMouseDown={onMouseDown}
          onMouseOver={onMouseOver}
          onDoubleClick={onDoubleClick}
          onFocus={onFocus}
          onBlur={onBlur}
          onCopy={onCopy}
          onCut={onCut}
          onPaste={onPaste}
          className="absolute inset-0 isolate overflow-auto text-sm text-fg outline-none"
        >
          <div
            className="relative"
            style={{ width: layout.totalWidth, height: rowVirtualizer.getTotalSize() }}
          >
            <GridHeader
              layout={layout}
              colStart={colStart}
              colEnd={colEnd}
              sort={sort}
              sortable={Boolean(onSortChange)}
              filterable={Boolean(onColumnFilter)}
              filtered={filteredKeys}
              selLeft={range ? range.left : -1}
              selRight={range ? range.right : -1}
              menuKey={menuKey}
              resizingKey={resizingKey}
              onAction={onHeaderAction}
              onResizeStart={onResizeStart}
            />
            {rowItems.map((item) => {
              const index = item.index
              let selLeft = -1
              let selRight = -1
              let rowSelected = false
              if (selection.rows) {
                if (hasRow(selection.rows, index)) {
                  rowSelected = true
                  selLeft = 0
                  selRight = layout.columns.length - 1
                }
              } else if (multiple && range && index >= range.top && index <= range.bottom) {
                selLeft = range.left
                selRight = range.right
              }
              const activeCol = active && active.row === index ? active.col : -1
              return (
                <GridRow
                  // Ключ — слот, а не номер строки: строка, ушедшая из окна, отдаёт свои
                  // DOM-узлы пришедшей, и при быстрой прокрутке узлы не создаются заново
                  key={rowSlots.get(index)}
                  gridId={gridId}
                  index={index}
                  row={getRow(index)}
                  top={item.start}
                  height={rowHeight}
                  layout={layout}
                  colStart={colStart}
                  colEnd={colEnd}
                  selLeft={selLeft}
                  selRight={selRight}
                  rowSelected={rowSelected}
                  activeCol={activeCol}
                  focused={activeCol >= 0 && focused}
                  overlay={overlay}
                  errors={errors}
                  ctx={ctx}
                />
              )
            })}
          </div>
          {loading && rowCount === 0 ? (
            <div aria-hidden className="sticky left-0">
              <TableSkeleton rows={8} columns={Math.min(Math.max(layout.columns.length, 1), 5)} />
            </div>
          ) : null}
          {!loading && rowCount === 0 ? (
            <div className="sticky left-0">
              {empty ?? <EmptyState compact title={t('ui.grid.empty')} />}
            </div>
          ) : null}
        </div>
        {editing && editingColumn ? (
          <GridEditor
            key={`${editing.row}:${editing.col}`}
            column={editingColumn}
            initialText={editing.text}
            selectAll={editing.selectAll}
            top={HEADER_HEIGHT + editing.row * rowHeight}
            height={rowHeight}
            leading={leading}
            scrollRef={scrollRef}
            ctx={ctx}
            onCommit={finishEditing}
            onCancel={cancelEditing}
          />
        ) : null}
        <textarea
          ref={clipboardRef}
          aria-hidden
          tabIndex={-1}
          onCopy={onClipboardCopy}
          onCut={onClipboardCopy}
          onPaste={onClipboardPaste}
          className="pointer-events-none absolute top-0 left-0 size-px resize-none opacity-0"
        />
      </div>
      <div className="flex h-8 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-xs text-fg-secondary">
        <div
          role="status"
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5',
            pending === 0 && message?.tone === 'danger' && 'text-danger',
          )}
        >
          {pending > 0 ? (
            <>
              <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin-fast" />
              <span className="truncate">{t('ui.grid.saving')}</span>
            </>
          ) : (
            <span className="truncate">{message?.text}</span>
          )}
        </div>
        {selection.rows ? (
          <div className="shrink-0 tabular">
            {t('ui.grid.selectedRows', { count: countRows(selection.rows) })}
          </div>
        ) : null}
        {summary ? (
          <div className="flex shrink-0 items-center gap-3 tabular">
            <span>{t('ui.grid.selected', { count: formatNumber(summary.cells, {}, ctx) })}</span>
            {summary.sum !== null ? (
              <span>{t('ui.grid.sum', { value: formatNumber(summary.sum, {}, ctx) })}</span>
            ) : null}
            {summary.avg !== null ? (
              <span>{t('ui.grid.avg', { value: formatNumber(summary.avg, {}, ctx) })}</span>
            ) : null}
            {summary.partial ? <span className="text-fg-muted">{t('ui.grid.partial')}</span> : null}
          </div>
        ) : null}
        {editable && onAppendRows ? (
          <button
            type="button"
            aria-pressed={appendArmed}
            onClick={() => {
              const armed = !appendArmed
              setAppendArmed(armed)
              setStatus(armed ? { tone: 'info', text: t('ui.grid.appendArmed') } : null)
              focusGrid()
            }}
            className={cn(
              'flex h-6 shrink-0 items-center gap-1 rounded-xs px-1.5 hover:bg-surface-3 hover:text-fg',
              appendArmed && 'bg-accent-subtle text-accent',
            )}
          >
            <Plus aria-hidden className="size-3.5" />
            {t('ui.grid.appendRows')}
          </button>
        ) : null}
        <div className="flex shrink-0 items-center gap-1.5 text-fg-muted tabular">
          {loading && rowCount > 0 ? (
            <Loader2 aria-hidden className="size-3.5 animate-spin-fast" />
          ) : null}
          {loading && rowCount === 0 ? null : counter}
        </div>
      </div>
    </div>
  )
}
