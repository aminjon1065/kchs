import { useVirtualizer } from '@tanstack/react-virtual'
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
import { type EditorMove, GridEditor } from './grid-editor.js'
import { GridFooter } from './grid-footer.js'
import { GridHeader, type HeaderAction } from './grid-header.js'
import { cellId, GridRow } from './grid-row.js'
import { type CellChange, planRedo, planUndo } from './history.js'
import { useLatest, useRowSlots, useStableCallback } from './hooks.js'
import { handleGridKey } from './keyboard.js'
import { clampWidth, HEADER_HEIGHT, MIN_COLUMN_WIDTH, type RenderColumn } from './layout.js'
import { cellKey, cellValue } from './overlay.js'
import { MAX_BATCH, pasteChanges, pasteReport, rowsToAppend } from './paste.js'
import {
  type CellPos,
  countRows,
  EMPTY_SELECTION,
  fitSelection,
  hasRow,
  isMultiple,
  moveBy,
  rangeOf,
  type SelectionState,
  selectAll,
  selectCell,
  selectedColumns,
  selectedRows,
  selectRow,
  tabMove,
} from './selection.js'
import { selectionSummary } from './summary.js'
import type { DataGridProps, DataGridRow, DataGridSortItem } from './types.js'
import { useColumnLayout } from './use-column-layout.js'
import { NO_ERRORS, useGridEdits } from './use-grid-edits.js'
import { copyText, displayText, editText, sameValue } from './values.js'

const NO_SORT: DataGridSortItem[] = []
/** Ячеек в копировании за раз. */
const MAX_COPY_CELLS = 200_000
const AUTOSIZE_MAX = 480

interface EditingState {
  row: number
  col: number
  text: string
  selectAll: boolean
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
  const { stateRef, commitState, table, resizingKey, layout, layoutRef } = useColumnLayout({
    columns,
    columnState,
    onColumnStateChange,
    rowCount,
    editable,
  })
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
  const {
    overlay,
    overlayRef,
    errors,
    setErrors,
    historyRef,
    status,
    setStatus,
    pending,
    applyChanges,
    appendRows,
  } = useGridEdits({ getRow, onEdit, onAppendRows, t })
  const [focused, setFocused] = useState(false)
  const [menuKey, setMenuKey] = useState<string | null>(null)
  /** «Добавить строки»: следующая вставка — новыми строками в конец таблицы. */
  const [appendArmed, setAppendArmed] = useState(false)
  const dragRef = useRef<'cells' | 'rows' | null>(null)
  const measureRef = useRef<CanvasRenderingContext2D | null>(null)

  useEffect(() => {
    setSelection((current) => fitSelection(current, bounds))
    setEditing((current) =>
      current && (current.row >= bounds.rows || current.col >= bounds.cols) ? null : current,
    )
  }, [bounds])

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
    const added = split ? rowsToAppend(split.appended, start.col, layout.columns, ctx) : null

    const plan = pasteChanges(targets, layout.columns, getRow, changeFor, ctx)
    const { changes, invalid } = plan

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

    const outside = clipped + plan.overflow + (split?.clipped ?? 0) + (added?.overflow ?? 0)
    const report = pasteReport(t, plan, targets.length, outside)
    void (async () => {
      if (changes.length > 0) await applyChanges(changes, { success: report })
      else if (!added?.rows.length) setStatus(report)
      if (added?.rows.length) await appendRows(added.rows, changes.length > 0 ? null : report.text)
    })()
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

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) =>
    handleGridKey(event, {
      bounds,
      selection,
      layout,
      editable,
      rowHeight,
      viewportHeight: () => scrollRef.current?.clientHeight ?? 0,
      getRow,
      select,
      setSelection,
      openMenu,
      startEditing,
      explainReadOnly,
      toggleBoolean,
      onRowOpen,
      onRowPreview,
      dismiss: () => {
        if (appendArmed) setAppendArmed(false)
        if (status || errors.size > 0) {
          setStatus(null)
          setErrors(NO_ERRORS)
        }
      },
      clearSelected,
      undo,
      redo,
      routeClipboard,
    })

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

  const summary = useMemo(
    () => selectionSummary(selection, bounds, layout.columns, getRow, overlay),
    [selection, bounds, layout, getRow, overlay],
  )

  const activeRow = active ? getRow(active.row) : undefined
  const activeColumn = active ? layout.columns[active.col] : undefined
  const activeError =
    activeRow && activeColumn && errors.size > 0
      ? errors.get(cellKey(activeRow.id, activeColumn.key))
      : undefined
  const message = activeError ? { tone: 'danger' as const, text: activeError } : status

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
      <GridFooter
        pending={pending}
        message={message}
        selectedRowCount={selection.rows ? countRows(selection.rows) : null}
        summary={summary}
        appendArmed={appendArmed}
        onToggleAppend={
          editable && onAppendRows
            ? () => {
                const armed = !appendArmed
                setAppendArmed(armed)
                setStatus(armed ? { tone: 'info', text: t('ui.grid.appendArmed') } : null)
                focusGrid()
              }
            : undefined
        }
        loading={loading}
        rowCount={rowCount}
        totalCount={totalCount}
        rowCountApprox={rowCountApprox}
        ctx={ctx}
      />
    </div>
  )
}
