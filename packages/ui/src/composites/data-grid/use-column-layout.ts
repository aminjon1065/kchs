import {
  type ColumnDef,
  type ColumnSizingInfoState,
  type ColumnSizingState,
  functionalUpdate,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { useEffect, useMemo, useRef, useState } from 'react'
import { reconcileColumnState } from './column-state.js'
import { useLatest, useStableCallback } from './hooks.js'
import {
  type GridLayout,
  gutterWidth,
  initialWidth,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  type RenderColumn,
} from './layout.js'
import type { DataGridColumnState, DataGridProps, DataGridRow } from './types.js'
import { editorKind, isNumeric } from './values.js'

const NO_ROWS: DataGridRow[] = []
const INITIAL_SIZING: ColumnSizingInfoState = {
  startOffset: null,
  startSize: null,
  deltaOffset: null,
  deltaPercentage: null,
  isResizingColumn: false,
  columnSizingStart: [],
}

/**
 * Раскладка столбцов таблицы данных: порядок, видимость, закрепление и ширины
 * (управляемые снаружи через `columnState` или свои), модель TanStack Table с
 * перетаскиванием края и итоговые позиции столбцов для отрисовки.
 */
export function useColumnLayout({
  columns,
  columnState,
  onColumnStateChange,
  rowCount,
  editable,
}: Pick<DataGridProps, 'columns' | 'columnState' | 'onColumnStateChange' | 'rowCount'> & {
  editable: boolean
}) {
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

  return { stateRef, commitState, table, resizingKey, layout, layoutRef }
}
