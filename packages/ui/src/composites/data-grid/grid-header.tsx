import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  EyeOff,
  ListFilter,
  MoveHorizontal,
  Pin,
  PinOff,
} from 'lucide-react'
import {
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  useRef,
  useState,
} from 'react'
import { useUiT } from '../../i18n/ui-locale.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/overlays.js'
import type { GridLayout, RenderColumn } from './layout.js'
import type { DataGridSortItem } from './types.js'

export type HeaderAction =
  | { type: 'sort'; key: string; multi: boolean }
  | { type: 'sortDir'; key: string; dir: 'asc' | 'desc' | null }
  | { type: 'pin'; key: string; pinned: boolean }
  | { type: 'move'; key: string; delta: -1 | 1 }
  | { type: 'reorder'; key: string; target: string; after: boolean }
  | { type: 'autosize'; key: string }
  | { type: 'hide'; key: string }
  | { type: 'filter'; key: string }
  | { type: 'menu'; key: string | null }
  | { type: 'selectAll' }
  | { type: 'focus' }

interface GridHeaderProps {
  layout: GridLayout
  colStart: number
  colEnd: number
  sort: ReadonlyArray<DataGridSortItem>
  sortable: boolean
  filterable: boolean
  /** Столбцы в выделении — подсвечиваются в шапке. */
  selLeft: number
  selRight: number
  menuKey: string | null
  resizingKey: string | null
  onAction: (action: HeaderAction) => void
  onResizeStart: (key: string, event: ReactMouseEvent | ReactTouchEvent) => void
}

interface DropTarget {
  target: string
  after: boolean
}

const NOT_SORTABLE = new Set(['geometry', 'json', 'file', 'signature'])

/**
 * Шапка DataGrid: сортировка щелчком (Shift — по нескольким полям),
 * ширина перетаскиванием края (двойной щелчок — по содержимому), порядок
 * перетаскиванием заголовка, меню столбца. Кнопки шапки не входят в порядок
 * Tab: с клавиатуры меню открывается из ячейки (Alt+↓).
 */
export const GridHeader = memo(function GridHeader({
  layout,
  colStart,
  colEnd,
  sort,
  sortable,
  filterable,
  selLeft,
  selRight,
  menuKey,
  resizingKey,
  onAction,
  onResizeStart,
}: GridHeaderProps) {
  const t = useUiT()
  const [drop, setDrop] = useState<DropTarget | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const dropRef = useRef<DropTarget | null>(null)
  const suppressClick = useRef(false)

  const startDrag = (col: RenderColumn, event: ReactPointerEvent<HTMLDivElement>) => {
    suppressClick.current = false
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-no-drag]')) return
    const row = event.currentTarget.parentElement
    const startX = event.clientX
    let active = false
    const update = (next: DropTarget | null) => {
      dropRef.current = next
      setDrop(next)
    }
    const move = (moveEvent: PointerEvent) => {
      if (!active && Math.abs(moveEvent.clientX - startX) < 5) return
      if (!active) {
        active = true
        setDragKey(col.key)
      }
      update(row ? dropTarget(row, moveEvent.clientX, col) : null)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!active) return
      // Щелчок после перетаскивания — не сортировка
      suppressClick.current = true
      const target = dropRef.current
      update(null)
      setDragKey(null)
      if (target) onAction({ type: 'reorder', key: col.key, ...target })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const renderHeader = (col: RenderColumn): ReactNode => {
    const { column } = col
    const sortIndex = sort.findIndex((item) => item.key === col.key)
    const sorted = sortIndex >= 0 ? sort[sortIndex] : undefined
    const canSort = sortable && !NOT_SORTABLE.has(column.type)
    const inSelection = col.index >= selLeft && col.index <= selRight
    const firstInRegion = col.pinned ? col.index === 0 : col.index === layout.pinnedCount
    const lastInRegion = col.pinned
      ? col.index === layout.pinnedCount - 1
      : col.index === layout.columns.length - 1
    const label = (
      <>
        <span className="truncate">{column.label}</span>
        {sorted ? (
          sorted.dir === 'asc' ? (
            <ArrowUp aria-hidden className="size-3 shrink-0" />
          ) : (
            <ArrowDown aria-hidden className="size-3 shrink-0" />
          )
        ) : null}
        {sorted && sort.length > 1 ? (
          <span className="tabular text-2xs">{sortIndex + 1}</span>
        ) : null}
      </>
    )

    let className = 'group/head flex items-center border-r text-xs font-medium select-none '
    className += col.pinned ? 'sticky z-1 shrink-0 ' : 'absolute inset-y-0 '
    className += col.lastPinned ? 'border-line-strong ' : 'border-line '
    className += inSelection || sorted ? 'bg-surface-3 text-fg ' : 'bg-surface-2 text-fg-secondary '
    if (dragKey === col.key) className += 'opacity-60 '

    return (
      <div
        key={col.key}
        role="columnheader"
        aria-colindex={col.index + 2}
        aria-sort={
          sortIndex === 0 ? (sorted?.dir === 'asc' ? 'ascending' : 'descending') : undefined
        }
        data-header-key={col.key}
        data-pinned={col.pinned}
        className={className}
        style={{ left: col.left, width: col.width }}
        onPointerDown={(event) => startDrag(col, event)}
      >
        {canSort ? (
          <button
            type="button"
            tabIndex={-1}
            // Фокус остаётся на таблице: навигация с клавиатуры продолжается после щелчка
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              if (suppressClick.current) {
                suppressClick.current = false
                return
              }
              onAction({ type: 'sort', key: col.key, multi: event.shiftKey })
            }}
            className={
              col.numeric
                ? 'flex h-full min-w-0 flex-1 items-center justify-end gap-1 px-3 outline-none hover:text-fg'
                : 'flex h-full min-w-0 flex-1 items-center gap-1 px-3 text-left outline-none hover:text-fg'
            }
          >
            {label}
          </button>
        ) : (
          <span
            className={
              col.numeric
                ? 'flex min-w-0 flex-1 items-center justify-end gap-1 px-3'
                : 'flex min-w-0 flex-1 items-center gap-1 px-3'
            }
          >
            {label}
          </span>
        )}
        {/* Немодальное: таблица под меню остаётся доступной (без aria-hidden на фокусируемой сетке) */}
        <DropdownMenu
          modal={false}
          open={menuKey === col.key}
          onOpenChange={(open) => onAction({ type: 'menu', key: open ? col.key : null })}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              tabIndex={-1}
              data-no-drag=""
              aria-label={t('ui.grid.menu', { name: column.label })}
              // Поверх конца подписи и только при наведении: подпись занимает всю ширину столбца
              className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-xs border border-line bg-surface text-fg-muted opacity-0 outline-none group-hover/head:opacity-100 hover:text-fg data-[state=open]:opacity-100"
            >
              <ChevronDown aria-hidden className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              onAction({ type: 'focus' })
            }}
          >
            {canSort ? (
              <>
                <DropdownMenuItem
                  icon={<ArrowUp className="size-3.5" />}
                  onSelect={() => onAction({ type: 'sortDir', key: col.key, dir: 'asc' })}
                >
                  {t('ui.grid.sortAsc')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  icon={<ArrowDown className="size-3.5" />}
                  onSelect={() => onAction({ type: 'sortDir', key: col.key, dir: 'desc' })}
                >
                  {t('ui.grid.sortDesc')}
                </DropdownMenuItem>
                {sorted ? (
                  <DropdownMenuItem
                    icon={<ArrowUpDown className="size-3.5" />}
                    onSelect={() => onAction({ type: 'sortDir', key: col.key, dir: null })}
                  >
                    {t('ui.grid.sortClear')}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
              </>
            ) : null}
            {filterable ? (
              <>
                <DropdownMenuItem
                  icon={<ListFilter className="size-3.5" />}
                  onSelect={() => onAction({ type: 'filter', key: col.key })}
                >
                  {t('ui.grid.filter')}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            <DropdownMenuItem
              icon={col.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              onSelect={() => onAction({ type: 'pin', key: col.key, pinned: !col.pinned })}
            >
              {col.pinned ? t('ui.grid.unpin') : t('ui.grid.pin')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<ArrowLeft className="size-3.5" />}
              disabled={firstInRegion}
              onSelect={() => onAction({ type: 'move', key: col.key, delta: -1 })}
            >
              {t('ui.grid.moveLeft')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<ArrowRight className="size-3.5" />}
              disabled={lastInRegion}
              onSelect={() => onAction({ type: 'move', key: col.key, delta: 1 })}
            >
              {t('ui.grid.moveRight')}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<MoveHorizontal className="size-3.5" />}
              onSelect={() => onAction({ type: 'autosize', key: col.key })}
            >
              {t('ui.grid.autosize')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              icon={<EyeOff className="size-3.5" />}
              disabled={layout.columns.length <= 1}
              onSelect={() => onAction({ type: 'hide', key: col.key })}
            >
              {t('ui.grid.hide')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Край для изменения ширины: мышью; с клавиатуры — «По ширине содержимого» в меню */}
        <div
          aria-hidden
          data-no-drag=""
          onMouseDown={(event) => {
            event.stopPropagation()
            onResizeStart(col.key, event)
          }}
          onTouchStart={(event) => {
            event.stopPropagation()
            onResizeStart(col.key, event)
          }}
          onDoubleClick={() => onAction({ type: 'autosize', key: col.key })}
          className={
            resizingKey === col.key
              ? 'absolute inset-y-0 right-0 w-1.5 cursor-col-resize bg-accent'
              : 'absolute inset-y-0 right-0 w-1.5 cursor-col-resize hover:bg-accent'
          }
        />
        {drop?.target === col.key ? (
          <span
            aria-hidden
            className={
              drop.after
                ? 'absolute inset-y-0 right-0 w-0.5 bg-accent'
                : 'absolute inset-y-0 left-0 w-0.5 bg-accent'
            }
          />
        ) : null}
      </div>
    )
  }

  const cells: ReactNode[] = []
  for (let i = 0; i < layout.pinnedCount; i++) {
    const col = layout.columns[i]
    if (col) cells.push(renderHeader(col))
  }
  for (let i = colStart; i <= colEnd; i++) {
    const col = layout.columns[i]
    if (col) cells.push(renderHeader(col))
  }

  return (
    <div
      role="row"
      aria-rowindex={1}
      className="sticky top-0 z-2 flex h-8 border-b border-line bg-surface-2"
      style={{ width: layout.totalWidth }}
    >
      <div
        role="columnheader"
        aria-colindex={1}
        aria-label={t('ui.grid.rowNumber')}
        onMouseDown={(event) => {
          event.preventDefault()
          onAction({ type: 'selectAll' })
        }}
        className="sticky left-0 z-1 shrink-0 border-r border-line bg-surface-2"
        style={{ width: layout.gutter }}
      />
      {cells}
    </div>
  )
})

/** Куда встанет перетаскиваемый столбец: соседний заголовок той же области (закреплённой или нет). */
function dropTarget(row: HTMLElement, x: number, dragged: RenderColumn): DropTarget | null {
  for (const element of row.querySelectorAll<HTMLElement>('[data-header-key]')) {
    const rect = element.getBoundingClientRect()
    if (x < rect.left || x > rect.right) continue
    const key = element.dataset.headerKey
    if (!key || key === dragged.key) return null
    if ((element.dataset.pinned === 'true') !== dragged.pinned) return null
    return { target: key, after: x > rect.left + rect.width / 2 }
  }
  return null
}
