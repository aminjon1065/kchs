import type { FilterNode } from '@kchs/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Inbox, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { Avatar, Badge, StatusBadge } from '../components/data-display.js'
import { EmptyState } from '../components/feedback.js'
import { Button } from '../primitives/button.js'
import {
  formatAmount,
  INCIDENTS,
  type Incident,
  type IncidentStatus,
  KIND_LABELS,
  STATUS_LABELS,
} from '../stories/incidents.js'
import { type CollectionMode, type CollectionState, CollectionView } from './collection-view.js'
import type { DataTableColumn } from './data-table.js'
import type { FilterField } from './filter-builder.js'

const meta = {
  title: 'Композиты/Коллекция',
  id: 'composites-collection-view',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const ORDER: IncidentStatus[] = ['todo', 'in_progress', 'on_approval', 'done']

const FIELDS: FilterField[] = [
  { key: 'title', label: 'Происшествие', type: 'text' },
  {
    key: 'kind',
    label: 'Вид',
    type: 'select',
    options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
  },
  {
    key: 'status',
    label: 'Статус',
    type: 'select',
    options: ORDER.map((status) => ({ value: status, label: STATUS_LABELS[status] })),
  },
  { key: 'victims', label: 'Пострадавшие', type: 'integer' },
  { key: 'damage', label: 'Ущерб, тыс. сомони', type: 'number' },
]

const COLUMNS: Array<DataTableColumn<Incident>> = [
  {
    key: 'title',
    header: 'Происшествие',
    cell: (row) => <span className="truncate font-medium">{row.title}</span>,
    minWidth: 260,
    sortable: true,
  },
  { key: 'district', header: 'Район', cell: (row) => row.district, width: 130 },
  { key: 'kind', header: 'Вид', cell: (row) => KIND_LABELS[row.kind], width: 130 },
  {
    key: 'status',
    header: 'Статус',
    cell: (row) => <StatusBadge status={row.status} label={STATUS_LABELS[row.status]} />,
    width: 160,
  },
  {
    key: 'damage',
    header: 'Ущерб, тыс. сомони',
    cell: (row) => formatAmount(row.damage),
    width: 170,
    align: 'end',
    sortable: true,
  },
]

/** Упрощённое вычисление фильтра для демонстрации: данные и запросы — у приложения. */
function matches(row: Incident, node: FilterNode | null): boolean {
  if (!node) return true
  if ('and' in node) return node.and.every((child) => matches(row, child))
  if ('or' in node) return node.or.some((child) => matches(row, child))
  if (!('field' in node)) return true
  const actual = row[node.field as keyof Incident]
  const value = node.value
  switch (node.op) {
    case 'eq':
      return actual === value
    case 'neq':
      return actual !== value
    case 'in':
      return Array.isArray(value) && value.includes(actual)
    case 'not_in':
      return Array.isArray(value) && !value.includes(actual)
    case 'gt':
      return Number(actual) > Number(value)
    case 'lt':
      return Number(actual) < Number(value)
    case 'contains':
      return String(actual).toLowerCase().includes(String(value).toLowerCase())
    default:
      return true
  }
}

function visibleRows(state: CollectionState): Incident[] {
  const query = state.search.trim().toLowerCase()
  const rows = INCIDENTS.filter(
    (row) => matches(row, state.filter) && (!query || row.title.toLowerCase().includes(query)),
  )
  const [sort] = state.sort
  if (!sort) return rows
  return [...rows].sort((a, b) => {
    const left = a[sort.field as keyof Incident]
    const right = b[sort.field as keyof Incident]
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), 'ru')
    return sort.direction === 'asc' ? order : -order
  })
}

function IncidentCard({ incident }: { incident: Incident }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium leading-snug text-fg">{incident.title}</span>
      <span className="flex items-center justify-between gap-2 text-xs text-fg-muted">
        <span>{incident.district}</span>
        <Avatar name={incident.owner} size="xs" />
      </span>
    </div>
  )
}

function IncidentTile({ incident }: { incident: Incident }) {
  return (
    <div className="flex h-full flex-col gap-2 rounded-md border border-line bg-surface p-3 shadow-xs">
      <span className="flex flex-wrap items-center justify-between gap-1.5">
        <Badge size="sm">{KIND_LABELS[incident.kind]}</Badge>
        <StatusBadge status={incident.status} label={STATUS_LABELS[incident.status]} />
      </span>
      <span className="text-sm font-medium leading-snug text-fg">{incident.title}</span>
      <span className="mt-auto flex items-center justify-between text-xs text-fg-muted">
        <span>{incident.district}</span>
        <span className="tabular">{formatAmount(incident.damage)}</span>
      </span>
    </div>
  )
}

const INITIAL: CollectionState = {
  mode: 'table',
  filter: null,
  sort: [],
  search: '',
  groupBy: null,
  columns: [],
}

function CollectionDemo({
  initial,
  selectable,
  empty,
}: {
  initial: Partial<CollectionState>
  selectable?: string[]
  empty?: boolean
}) {
  const [state, setState] = useState<CollectionState>({ ...INITIAL, ...initial })
  const [selection, setSelection] = useState<Set<string>>(new Set(selectable))
  const [statuses, setStatuses] = useState<Record<string, IncidentStatus>>({})
  const rows = empty
    ? []
    : visibleRows(state).map((row) => ({ ...row, status: statuses[row.id] ?? row.status }))
  const modes: CollectionMode[] = ['table', 'list', 'board', 'gallery']
  return (
    <div className="h-[560px] overflow-hidden rounded-md border border-line bg-surface">
      <CollectionView
        aria-label="Происшествия"
        rows={rows}
        getRowId={(row) => row.id}
        state={state}
        onStateChange={setState}
        fields={FIELDS}
        sortableFields={['title', 'damage', 'victims']}
        columns={COLUMNS}
        modes={modes}
        total={rows.length}
        selection={selectable ? selection : undefined}
        onSelectionChange={selectable ? setSelection : undefined}
        bulkActions={
          <Button variant="ghost" size="sm" icon={<UserPlus className="size-3.5" />}>
            Назначить ответственного
          </Button>
        }
        renderListItem={(row) => (
          <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
            <span className="min-w-0">
              <span className="block truncate font-medium text-fg">{row.title}</span>
              <span className="block text-xs text-fg-muted">
                {row.district} · {KIND_LABELS[row.kind]}
              </span>
            </span>
            <StatusBadge status={row.status} label={STATUS_LABELS[row.status]} />
          </span>
        )}
        renderTile={(row) => <IncidentTile incident={row} />}
        board={{
          columns: ORDER.map((status) => ({ key: status, title: STATUS_LABELS[status] })),
          getColumnKey: (row) => row.status,
          renderCard: (row) => <IncidentCard incident={row} />,
          onMove: (row, to) =>
            setStatuses((current) => ({ ...current, [row.id]: to as IncidentStatus })),
        }}
        empty={
          <EmptyState
            compact
            icon={<Inbox className="size-5" />}
            title="Ничего не найдено"
            description="Измените условия фильтра или строку поиска."
          />
        }
      />
    </div>
  )
}

export const Table: Story = {
  name: 'Таблица с фильтром и сортировкой',
  render: () => (
    <CollectionDemo
      initial={{
        filter: { field: 'kind', op: 'in', value: ['flood', 'mudflow'] },
        sort: [{ field: 'damage', direction: 'desc' }],
      }}
    />
  ),
}

export const Selection: Story = {
  name: 'Выделение и действия',
  render: () => <CollectionDemo initial={{}} selectable={['inc-01', 'inc-04']} />,
}

export const List: Story = {
  name: 'Список',
  render: () => <CollectionDemo initial={{ mode: 'list' }} />,
}

export const Board: Story = {
  name: 'Доска',
  render: () => <CollectionDemo initial={{ mode: 'board' }} />,
}

export const Gallery: Story = {
  name: 'Плитки',
  render: () => <CollectionDemo initial={{ mode: 'gallery' }} />,
}

export const Empty: Story = {
  name: 'Ничего не найдено',
  render: () => <CollectionDemo initial={{ search: 'лавина в Хороге' }} empty />,
}
