import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp } from 'lucide-react'
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { TableSkeleton } from '../components/feedback.js'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'
import { Checkbox } from '../primitives/controls.js'

export interface DataTableColumn<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  /** Ширина по умолчанию в пикселях. */
  width?: number
  minWidth?: number
  align?: 'start' | 'end'
  sortable?: boolean
}

export interface DataTableSort {
  field: string
  direction: 'asc' | 'desc'
}

export interface DataTableProps<T> {
  rows: T[]
  getRowId: (row: T) => string
  columns: Array<DataTableColumn<T>>
  /** Ширины столбцов, изменённые пользователем (ключ → px). */
  widths?: Record<string, number>
  onWidthsChange?: (widths: Record<string, number>) => void
  sort?: DataTableSort[]
  onSortChange?: (sort: DataTableSort[]) => void
  selectable?: boolean
  selection?: ReadonlySet<string>
  onSelectionChange?: (selection: Set<string>) => void
  /** Одинарный клик — предпросмотр, двойной и Enter — открыть. */
  onRowClick?: (row: T) => void
  onRowOpen?: (row: T) => void
  rowActions?: (row: T) => ReactNode
  onEndReached?: () => void
  loading?: boolean
  empty?: ReactNode
  'aria-label'?: string
  className?: string
}

const DEFAULT_WIDTH = 160
const MIN_WIDTH = 64
const SELECT_WIDTH = 40
const ACTIONS_WIDTH = 96

/**
 * Облегчённая таблица CollectionView (03-ui/04-interaction-patterns.md §2):
 * виртуализация строк, серверная сортировка по клику (Shift — несколько полей),
 * изменение ширины перетаскиванием, выделение, полная навигация с клавиатуры.
 * Тяжёлые сценарии (редактирование, 100 столбцов) — DataGrid фазы 1.
 */
export function DataTable<T>({
  rows,
  getRowId,
  columns,
  widths,
  onWidthsChange,
  sort = [],
  onSortChange,
  selectable = false,
  selection,
  onSelectionChange,
  onRowClick,
  onRowOpen,
  rowActions,
  onEndReached,
  loading,
  empty,
  className,
  ...props
}: DataTableProps<T>) {
  const t = useUiT()
  const scrollRef = useRef<HTMLDivElement>(null)
  // Фокус держит сетка, активная строка объявляется через aria-activedescendant
  // (шаблон WAI-ARIA grid для виртуализированных списков; поэтому div с ролями)
  const gridId = useId()
  const [active, setActive] = useState<number>(-1)
  const [draftWidths, setDraftWidths] = useState<Record<string, number> | null>(null)
  const effectiveWidths = draftWidths ?? widths ?? {}

  const { template, rowWidth } = useMemo(() => {
    const parts: string[] = []
    let minTotal = 0
    const push = (track: string, min: number) => {
      parts.push(track)
      minTotal += min
    }
    if (selectable) push(`${SELECT_WIDTH}px`, SELECT_WIDTH)
    columns.forEach((column, index) => {
      const width = effectiveWidths[column.key] ?? column.width
      if (width) push(`${width}px`, width)
      // Первый столбец без явной ширины занимает остаток строки
      else if (index === 0) push(`minmax(${column.minWidth ?? 200}px, 1fr)`, column.minWidth ?? 200)
      else push(`${DEFAULT_WIDTH}px`, DEFAULT_WIDTH)
    })
    if (rowActions) push(`${ACTIONS_WIDTH}px`, ACTIONS_WIDTH)
    // Каждая строка — отдельная сетка: у всех одна ширина, иначе 1fr первого
    // столбца считался бы по содержимому строки и столбцы расходились с шапкой
    return { template: parts.join(' '), rowWidth: `max(100%, ${minTotal}px)` }
  }, [columns, effectiveWidths, selectable, rowActions])

  const rowHeight = useRowHeight(scrollRef)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  })
  const items = virtualizer.getVirtualItems()

  // biome-ignore lint/correctness/useExhaustiveDependencies: пересчёт позиций при смене плотности
  useEffect(() => {
    virtualizer.measure()
  }, [rowHeight, virtualizer])

  const lastIndex = items[items.length - 1]?.index ?? -1
  useEffect(() => {
    if (onEndReached && rows.length > 0 && lastIndex >= rows.length - 8) onEndReached()
  }, [lastIndex, rows.length, onEndReached])

  const toggle = useCallback(
    (id: string) => {
      if (!onSelectionChange) return
      const next = new Set(selection)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      onSelectionChange(next)
    },
    [onSelectionChange, selection],
  )

  const allSelected = rows.length > 0 && rows.every((row) => selection?.has(getRowId(row)))
  const someSelected = !allSelected && rows.some((row) => selection?.has(getRowId(row)))

  const focusRow = (index: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, index))
    setActive(clamped)
    virtualizer.scrollToIndex(clamped, { align: 'auto' })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return
    const row = active >= 0 ? rows[active] : undefined
    switch (event.key) {
      case 'ArrowDown':
      case 'j':
        event.preventDefault()
        focusRow(active + 1)
        break
      case 'ArrowUp':
      case 'k':
        event.preventDefault()
        focusRow(active - 1)
        break
      case 'Home':
        event.preventDefault()
        focusRow(0)
        break
      case 'End':
        event.preventDefault()
        focusRow(rows.length - 1)
        break
      case 'Enter':
        if (row && onRowOpen) {
          event.preventDefault()
          onRowOpen(row)
        }
        break
      case ' ':
        if (row && selectable) {
          event.preventDefault()
          toggle(getRowId(row))
        } else if (row && onRowClick) {
          event.preventDefault()
          onRowClick(row)
        }
        break
      case 'Escape':
        if (selection?.size) onSelectionChange?.(new Set())
        break
      default:
        break
    }
  }

  const onHeaderClick = (column: DataTableColumn<T>, event: MouseEvent) => {
    if (!column.sortable || !onSortChange) return
    const current = sort.find((item) => item.field === column.key)
    const nextDirection = !current ? 'asc' : current.direction === 'asc' ? 'desc' : null
    const others = event.shiftKey ? sort.filter((item) => item.field !== column.key) : []
    onSortChange(
      nextDirection ? [...others, { field: column.key, direction: nextDirection }] : others,
    )
  }

  const startResize = (column: DataTableColumn<T>, event: PointerEvent<HTMLSpanElement>) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const header = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    const startWidth = header.width
    const base = { ...(widths ?? {}) }
    let latest = base
    const move = (e: globalThis.PointerEvent) => {
      const width = Math.max(
        column.minWidth ?? MIN_WIDTH,
        Math.round(startWidth + e.clientX - startX),
      )
      latest = { ...base, [column.key]: width }
      setDraftWidths(latest)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDraftWidths(null)
      onWidthsChange?.(latest)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (loading && rows.length === 0) {
    return <TableSkeleton rows={8} columns={Math.min(columns.length, 5)} />
  }

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-label={props['aria-label']}
      aria-rowcount={rows.length + 1}
      aria-multiselectable={selectable || undefined}
      tabIndex={0}
      aria-activedescendant={
        active >= 0 && rows[active] ? `${gridId}-${getRowId(rows[active] as T)}` : undefined
      }
      onKeyDown={onKeyDown}
      onFocus={() => {
        if (active < 0 && rows.length > 0) setActive(0)
      }}
      className={cn(
        'relative h-full min-h-0 overflow-auto text-sm outline-none',
        'focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset',
        className,
      )}
    >
      <div
        role="row"
        aria-rowindex={1}
        className="sticky top-0 z-(--z-sticky) grid min-w-full border-b border-line bg-surface-2 text-xs font-medium text-fg-muted"
        style={{ gridTemplateColumns: template, width: rowWidth }}
      >
        {selectable ? (
          <span role="columnheader" className="flex h-8 items-center justify-center">
            <Checkbox
              aria-label={t('ui.table.selectAll')}
              checked={allSelected ? true : someSelected ? 'indeterminate' : false}
              onCheckedChange={(checked) =>
                onSelectionChange?.(checked ? new Set(rows.map(getRowId)) : new Set())
              }
            />
          </span>
        ) : null}
        {columns.map((column) => {
          const sorted = sort.find((item) => item.field === column.key)
          const order = sort.length > 1 && sorted ? sort.indexOf(sorted) + 1 : null
          return (
            <span
              key={column.key}
              role="columnheader"
              aria-sort={
                sorted ? (sorted.direction === 'asc' ? 'ascending' : 'descending') : undefined
              }
              className="group relative flex h-8 min-w-0 items-center"
            >
              {column.sortable && onSortChange ? (
                <button
                  type="button"
                  onClick={(event) => onHeaderClick(column, event)}
                  className={cn(
                    'flex h-full min-w-0 flex-1 items-center gap-1 px-3 hover:text-fg',
                    column.align === 'end' && 'justify-end',
                    sorted && 'text-fg',
                  )}
                >
                  <span className="truncate">{column.header}</span>
                  {sorted ? (
                    sorted.direction === 'asc' ? (
                      <ArrowUp className="size-3 shrink-0" aria-hidden />
                    ) : (
                      <ArrowDown className="size-3 shrink-0" aria-hidden />
                    )
                  ) : null}
                  {order ? <span className="tabular text-2xs">{order}</span> : null}
                </button>
              ) : (
                <span
                  className={cn(
                    'flex min-w-0 flex-1 px-3',
                    column.align === 'end' && 'justify-end',
                  )}
                >
                  <span className="truncate">{column.header}</span>
                </span>
              )}
              {onWidthsChange ? (
                <span
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={t('ui.table.resize')}
                  onPointerDown={(event) => startResize(column, event)}
                  className="absolute right-0 top-1.5 bottom-1.5 w-1.5 cursor-col-resize rounded-full opacity-0 transition-opacity group-hover:bg-line-strong group-hover:opacity-100"
                />
              ) : null}
            </span>
          )
        })}
        {rowActions ? <span role="columnheader" aria-label={t('ui.table.actions')} /> : null}
      </div>

      {rows.length === 0 ? (
        <div className="py-10">{empty}</div>
      ) : (
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((item) => {
            const row = rows[item.index] as T
            const id = getRowId(row)
            const isSelected = selection?.has(id) ?? false
            const isActive = item.index === active
            return (
              <div
                key={id}
                id={`${gridId}-${id}`}
                role="row"
                aria-rowindex={item.index + 2}
                aria-selected={selectable ? isSelected : undefined}
                data-active={isActive || undefined}
                onClick={() => {
                  setActive(item.index)
                  onRowClick?.(row)
                }}
                onDoubleClick={() => onRowOpen?.(row)}
                className={cn(
                  'group/row absolute left-0 grid min-w-full cursor-pointer border-b border-line',
                  isSelected ? 'bg-accent-subtle' : 'hover:bg-surface-2',
                  isActive && 'outline-2 -outline-offset-2 outline-accent/50',
                )}
                style={{
                  gridTemplateColumns: template,
                  height: rowHeight,
                  transform: `translateY(${item.start}px)`,
                  width: rowWidth,
                }}
              >
                {selectable ? (
                  <span
                    role="gridcell"
                    className="flex items-center justify-center"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Checkbox
                      aria-label={t('ui.table.selectRow')}
                      checked={isSelected}
                      onCheckedChange={() => toggle(id)}
                    />
                  </span>
                ) : null}
                {columns.map((column) => (
                  <span
                    key={column.key}
                    role="gridcell"
                    className={cn(
                      'flex min-w-0 items-center px-3',
                      column.align === 'end' && 'justify-end tabular',
                    )}
                  >
                    {column.cell(row)}
                  </span>
                ))}
                {rowActions ? (
                  <span
                    role="gridcell"
                    className="flex items-center justify-end gap-0.5 px-2 opacity-0 transition-opacity group-hover/row:opacity-100 group-data-[active]/row:opacity-100"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    {rowActions(row)}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Высота строки из токена плотности `--row-h`, пересчитывается при смене плотности. */
function useRowHeight(ref: { current: HTMLElement | null }): number {
  const [height, setHeight] = useState(36)
  useEffect(() => {
    const read = () => {
      const element = ref.current ?? document.documentElement
      const value = Number.parseFloat(getComputedStyle(element).getPropertyValue('--row-h'))
      if (Number.isFinite(value) && value > 0) setHeight(value)
    }
    read()
    const observer = new MutationObserver(read)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-density'],
    })
    return () => observer.disconnect()
  }, [ref])
  return height
}
