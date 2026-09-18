import { Check } from 'lucide-react'
import { memo, type ReactNode } from 'react'
import type { GridLayout, RenderColumn } from './layout.js'
import { cellKey, cellValue, type ErrorMap, type OverlayMap } from './overlay.js'
import type { DataGridRow } from './types.js'
import { displayText, type ValueContext } from './values.js'

export function cellId(gridId: string, row: number, col: number): string {
  return `${gridId}-${row}-${col}`
}

interface GridRowProps {
  gridId: string
  index: number
  row: DataGridRow | undefined
  top: number
  height: number
  layout: GridLayout
  /** Видимые незакреплённые столбцы: индексы в `layout.columns`, включительно. */
  colStart: number
  colEnd: number
  /** Столбцы строки в выделении (−1 — строка вне выделения). */
  selLeft: number
  selRight: number
  rowSelected: boolean
  /** Активная ячейка в этой строке (−1 — нет). */
  activeCol: number
  focused: boolean
  overlay: OverlayMap
  errors: ErrorMap
  ctx: ValueContext
}

// Классы собираются конкатенацией без tailwind-merge: строка перерисовывается
// при прокрутке, и слияние классов на каждую ячейку заметно в профиле
const CELL = 'flex items-center gap-1.5 overflow-hidden border-r px-3 '
const PINNED = 'sticky z-1 shrink-0 '
const CENTER = 'absolute inset-y-0 '

/**
 * Строка DataGrid. Мемоизирована: при вертикальной прокрутке перерисовываются
 * только появившиеся строки, остальные получают те же примитивные пропсы.
 */
export const GridRow = memo(function GridRow({
  gridId,
  index,
  row,
  top,
  height,
  layout,
  colStart,
  colEnd,
  selLeft,
  selRight,
  rowSelected,
  activeCol,
  focused,
  overlay,
  errors,
  ctx,
}: GridRowProps) {
  const renderCell = (col: RenderColumn): ReactNode => {
    const active = col.index === activeCol
    const selected = !active && col.index >= selLeft && col.index <= selRight
    const value = row ? cellValue(row, col.key, overlay) : undefined
    const error = row && errors.size > 0 ? errors.get(cellKey(row.id, col.key)) : undefined

    let className = CELL + (col.pinned ? PINNED : CENTER)
    className += col.lastPinned ? 'border-line-strong ' : 'border-line '
    if (col.numeric) className += 'justify-end tabular '
    if (selected) className += 'bg-accent-subtle '
    else if (col.pinned || active) className += 'bg-surface group-hover/row:bg-surface-2 '
    if (active) {
      className += focused
        ? `outline-2 -outline-offset-2 ${error === undefined ? 'outline-accent' : 'outline-danger'} `
        : 'outline-1 -outline-offset-1 outline-line-strong '
    } else if (error !== undefined) className += 'outline-2 -outline-offset-2 outline-danger '

    return (
      <div
        key={col.key}
        // id нужен только активной ячейке — на неё указывает aria-activedescendant
        id={active ? cellId(gridId, index, col.index) : undefined}
        role="gridcell"
        aria-colindex={col.index + 2}
        aria-selected={active || selected}
        aria-readonly={col.editor ? undefined : true}
        data-col={col.index}
        className={className}
        style={{ left: col.left, width: col.width }}
      >
        {row ? (
          renderValue(value, col, ctx)
        ) : (
          <span aria-hidden className="h-2.5 w-3/5 rounded-xs bg-surface-3" />
        )}
      </div>
    )
  }

  const cells: ReactNode[] = []
  for (let i = 0; i < layout.pinnedCount; i++) {
    const col = layout.columns[i]
    if (col) cells.push(renderCell(col))
  }
  for (let i = colStart; i <= colEnd; i++) {
    const col = layout.columns[i]
    if (col) cells.push(renderCell(col))
  }

  let gutter =
    'sticky left-0 z-1 flex shrink-0 items-center justify-end border-r border-line px-2 text-2xs tabular '
  if (rowSelected) gutter += 'bg-accent text-accent-fg'
  else if (selLeft >= 0 || activeCol >= 0) gutter += 'bg-surface-3 text-fg'
  else gutter += 'bg-surface-2 text-fg-muted'

  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-selected={rowSelected || undefined}
      aria-busy={row ? undefined : true}
      data-row={index}
      className="group/row absolute top-0 left-0 flex border-b border-line bg-surface hover:bg-surface-2"
      style={{ transform: `translateY(${top}px)`, height, width: layout.totalWidth }}
    >
      <div
        role="rowheader"
        aria-colindex={1}
        data-gutter=""
        className={gutter}
        style={{ width: layout.gutter }}
      >
        {index + 1}
      </div>
      {cells}
    </div>
  )
})

function renderValue(value: unknown, col: RenderColumn, ctx: ValueContext): ReactNode {
  const empty = value === null || value === undefined || value === ''
  const type = col.column.type
  // Пустое логическое в правимом столбце — пустая галка, по ней можно щёлкнуть
  if (type === 'boolean' && (!empty || col.editor === 'boolean')) {
    const checked = Boolean(value)
    return (
      <>
        <span
          aria-hidden
          data-toggle={col.editor === 'boolean' ? '' : undefined}
          className={
            checked
              ? 'flex size-3.5 shrink-0 items-center justify-center rounded-xs border border-accent bg-accent text-accent-fg'
              : 'size-3.5 shrink-0 rounded-xs border border-line-strong bg-surface'
          }
        >
          {checked ? <Check className="size-3" strokeWidth={3} /> : null}
        </span>
        {empty ? null : <span className="sr-only">{displayText(value, col.column, ctx)}</span>}
      </>
    )
  }
  if (empty) return null
  const text = displayText(value, col.column, ctx)
  if (type === 'select') {
    return <span className="truncate rounded-xs bg-surface-3 px-1.5 text-xs leading-5">{text}</span>
  }
  return <span className="truncate">{text}</span>
}
