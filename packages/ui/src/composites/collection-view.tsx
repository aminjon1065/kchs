import type { FilterNode, FilterOperator } from '@kchs/contracts'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDownUp, Columns3, Kanban, LayoutGrid, List, Table2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { useUiT } from '../i18n/ui-locale.js'
import { cn } from '../lib/cn.js'
import { Button } from '../primitives/button.js'
import { SegmentedControl } from '../primitives/controls.js'
import { SearchInput } from '../primitives/input.js'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../primitives/overlays.js'
import { DataTable, type DataTableColumn, type DataTableSort } from './data-table.js'
import { FilterBuilder, type FilterField, type ValueEditorProps } from './filter-builder.js'
import { KanbanBoard, type KanbanColumn } from './kanban-board.js'

export type CollectionMode = 'table' | 'list' | 'board' | 'gallery'

/** Состояние представления — совпадает с ViewDefinition контракта (без служебных полей). */
export interface CollectionState {
  mode: CollectionMode
  filter: FilterNode | null
  sort: DataTableSort[]
  search: string
  groupBy: string | null
  columns: Array<{ key: string; width?: number; hidden?: boolean }>
}

export interface CollectionViewProps<T> {
  rows: T[]
  getRowId: (row: T) => string
  state: CollectionState
  onStateChange: (state: CollectionState) => void
  /** Поля для фильтра и сортировки (подписи уже переведены). */
  fields: FilterField[]
  sortableFields?: string[]
  columns: Array<DataTableColumn<T>>
  modes?: CollectionMode[]
  renderListItem?: (row: T) => ReactNode
  renderTile?: (row: T) => ReactNode
  board?: {
    columns: KanbanColumn[]
    getColumnKey: (row: T) => string
    renderCard: (row: T) => ReactNode
    onMove?: (row: T, toColumn: string) => void
    canMove?: (row: T, toColumn: string) => boolean
  }
  total?: number
  loading?: boolean
  hasMore?: boolean
  onLoadMore?: () => void
  selection?: ReadonlySet<string>
  onSelectionChange?: (selection: Set<string>) => void
  bulkActions?: ReactNode
  onRowClick?: (row: T) => void
  onRowOpen?: (row: T) => void
  rowActions?: (row: T) => ReactNode
  /** Меню сохранённых представлений (данные — у приложения). */
  viewsMenu?: ReactNode
  toolbarExtra?: ReactNode
  empty?: ReactNode
  renderFilterValue?: (props: ValueEditorProps) => ReactNode | undefined
  describeFilterValue?: (
    field: FilterField,
    op: FilterOperator,
    value: unknown,
  ) => string | undefined
  'aria-label'?: string
  className?: string
}

/**
 * Единый список объектов любого типа (03-ui/04-interaction-patterns.md §2):
 * поиск, фильтр-чипы, сортировка, столбцы, режимы таблица/список/доска/плитки,
 * выделение с действиями и сохранённые представления. Данные и запросы —
 * у приложения; компонент управляемый (`state` ↔ ViewDefinition).
 */
export function CollectionView<T>({
  rows,
  getRowId,
  state,
  onStateChange,
  fields,
  sortableFields,
  columns,
  modes = ['table', 'list'],
  renderListItem,
  renderTile,
  board,
  total,
  loading,
  hasMore,
  onLoadMore,
  selection,
  onSelectionChange,
  bulkActions,
  onRowClick,
  onRowOpen,
  rowActions,
  viewsMenu,
  toolbarExtra,
  empty,
  renderFilterValue,
  describeFilterValue,
  className,
  ...props
}: CollectionViewProps<T>) {
  const t = useUiT()
  const set = (patch: Partial<CollectionState>) => onStateChange({ ...state, ...patch })

  const hidden = new Set(state.columns.filter((c) => c.hidden).map((c) => c.key))
  const order = state.columns.map((c) => c.key)
  const visibleColumns = [...columns]
    .sort((a, b) => {
      const ia = order.indexOf(a.key)
      const ib = order.indexOf(b.key)
      return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib)
    })
    .filter((column) => !hidden.has(column.key))
  const widths = Object.fromEntries(
    state.columns.filter((c) => c.width).map((c) => [c.key, c.width as number]),
  )
  const sortable = fields.filter((field) => !sortableFields || sortableFields.includes(field.key))

  const modeOptions = modes.map((mode) => ({
    value: mode,
    label: '',
    title: t(`ui.collection.mode.${mode}`),
    icon:
      mode === 'table' ? (
        <Table2 className="size-3.5" />
      ) : mode === 'list' ? (
        <List className="size-3.5" />
      ) : mode === 'board' ? (
        <Kanban className="size-3.5" />
      ) : (
        <LayoutGrid className="size-3.5" />
      ),
  }))

  const selectedCount = selection?.size ?? 0

  return (
    <section
      aria-label={props['aria-label']}
      className={cn('flex h-full min-h-0 flex-col', className)}
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <SearchInput
            value={state.search}
            onValueChange={(search) => set({ search })}
            onClear={() => set({ search: '' })}
            placeholder={t('ui.collection.search')}
            className="w-56"
          />
          <div className="ml-auto flex items-center gap-1.5">
            {sortable.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" icon={<ArrowDownUp className="size-3.5" />}>
                    {t('ui.collection.sort')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuRadioGroup
                    value={state.sort[0] ? `${state.sort[0].field}:${state.sort[0].direction}` : ''}
                    onValueChange={(value) => {
                      if (!value) return set({ sort: [] })
                      const [field = '', direction] = value.split(':')
                      set({ sort: [{ field, direction: direction === 'desc' ? 'desc' : 'asc' }] })
                    }}
                  >
                    <DropdownMenuRadioItem value="">
                      {t('ui.collection.sortNone')}
                    </DropdownMenuRadioItem>
                    <DropdownMenuSeparator />
                    {sortable.flatMap((field) => [
                      <DropdownMenuRadioItem key={`${field.key}:asc`} value={`${field.key}:asc`}>
                        {field.label} ↑
                      </DropdownMenuRadioItem>,
                      <DropdownMenuRadioItem key={`${field.key}:desc`} value={`${field.key}:desc`}>
                        {field.label} ↓
                      </DropdownMenuRadioItem>,
                    ])}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {state.mode === 'table' ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" icon={<Columns3 className="size-3.5" />}>
                    {t('ui.collection.columns')}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>{t('ui.collection.columns')}</DropdownMenuLabel>
                  {columns.map((column, index) => (
                    <DropdownMenuCheckboxItem
                      key={column.key}
                      checked={!hidden.has(column.key)}
                      // Первый столбец (название) скрыть нельзя
                      disabled={index === 0}
                      onSelect={(event) => event.preventDefault()}
                      onCheckedChange={(checked) => {
                        const rest = state.columns.filter((c) => c.key !== column.key)
                        const current = state.columns.find((c) => c.key === column.key)
                        set({
                          columns: [
                            ...rest,
                            { ...(current ?? { key: column.key }), hidden: !checked },
                          ],
                        })
                      }}
                    >
                      {column.header}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {modes.length > 1 ? (
              <SegmentedControl
                size="sm"
                aria-label={t('ui.collection.views')}
                value={state.mode}
                onValueChange={(mode) => set({ mode })}
                options={modeOptions}
              />
            ) : null}
            {viewsMenu}
            {toolbarExtra}
          </div>
        </div>
        <FilterBuilder
          fields={fields}
          value={state.filter}
          onChange={(filter) => set({ filter })}
          renderValue={renderFilterValue}
          describeValue={describeFilterValue}
        />
      </div>

      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 text-xs text-fg-muted">
        {selectedCount > 0 ? (
          <>
            <span className="font-medium text-fg">
              {t('ui.collection.selected', { count: selectedCount })}
            </span>
            {bulkActions}
          </>
        ) : (
          <span className="tabular">
            {t('ui.collection.found', { count: total ?? rows.length })}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {state.mode === 'table' ? (
          <DataTable
            rows={rows}
            getRowId={getRowId}
            columns={visibleColumns}
            widths={widths}
            onWidthsChange={(next) =>
              set({
                columns: mergeWidths(state.columns, next),
              })
            }
            sort={state.sort}
            onSortChange={(sort) => set({ sort })}
            selectable={Boolean(onSelectionChange)}
            selection={selection}
            onSelectionChange={onSelectionChange}
            onRowClick={onRowClick}
            onRowOpen={onRowOpen}
            rowActions={rowActions}
            onEndReached={hasMore ? onLoadMore : undefined}
            loading={loading}
            empty={empty}
            aria-label={props['aria-label']}
          />
        ) : state.mode === 'board' && board ? (
          <KanbanBoard
            columns={board.columns}
            items={rows}
            getItemId={getRowId}
            getColumnKey={board.getColumnKey}
            renderCard={board.renderCard}
            onCardOpen={onRowOpen}
            onMove={board.onMove}
            canMove={board.canMove}
            aria-label={props['aria-label']}
          />
        ) : state.mode === 'gallery' && renderTile ? (
          rows.length === 0 ? (
            <div className="py-10">{empty}</div>
          ) : (
            <div className="grid h-full grid-cols-[repeat(auto-fill,minmax(180px,1fr))] content-start gap-3 overflow-y-auto p-4">
              {rows.map((row) => (
                <div key={getRowId(row)}>{renderTile(row)}</div>
              ))}
              {hasMore ? (
                <Button variant="ghost" size="sm" onClick={onLoadMore} className="col-span-full">
                  {t('ui.collection.loadMore')}
                </Button>
              ) : null}
            </div>
          )
        ) : (
          <VirtualCardList
            rows={rows}
            getRowId={getRowId}
            render={renderListItem ?? ((row) => visibleColumns[0]?.cell(row))}
            onOpen={onRowOpen}
            onClick={onRowClick}
            onEndReached={hasMore ? onLoadMore : undefined}
            empty={empty}
          />
        )}
      </div>
    </section>
  )
}

function mergeWidths(
  columns: CollectionState['columns'],
  widths: Record<string, number>,
): CollectionState['columns'] {
  const byKey = new Map(columns.map((c) => [c.key, c]))
  for (const [key, width] of Object.entries(widths)) {
    byKey.set(key, { ...(byKey.get(key) ?? { key }), width })
  }
  return [...byKey.values()]
}

function VirtualCardList<T>({
  rows,
  getRowId,
  render,
  onOpen,
  onClick,
  onEndReached,
  empty,
}: {
  rows: T[]
  getRowId: (row: T) => string
  render: (row: T) => ReactNode
  onOpen?: (row: T) => void
  onClick?: (row: T) => void
  onEndReached?: () => void
  empty?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 56,
    overscan: 10,
  })
  const items = virtualizer.getVirtualItems()
  const last = items[items.length - 1]?.index ?? -1
  useEffect(() => {
    if (onEndReached && rows.length > 0 && last >= rows.length - 6) onEndReached()
  }, [last, rows.length, onEndReached])

  if (rows.length === 0) return <div className="py-10">{empty}</div>

  return (
    <div ref={ref} className="h-full overflow-y-auto">
      <ul className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const row = rows[item.index] as T
          return (
            <li
              key={getRowId(row)}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <button
                type="button"
                onClick={() => onClick?.(row)}
                onDoubleClick={() => onOpen?.(row)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && onOpen) {
                    event.preventDefault()
                    onOpen(row)
                  }
                }}
                className="flex min-h-(--list-row-h) w-full items-center gap-3 border-b border-line px-4 py-2 text-left hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
              >
                {render(row)}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
