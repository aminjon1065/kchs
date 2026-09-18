import type { Meta, StoryObj } from '@storybook/react-vite'
import { Inbox, Pencil, Share2 } from 'lucide-react'
import { useState } from 'react'
import { userEvent, within } from 'storybook/test'
import { StatusBadge } from '../components/data-display.js'
import { EmptyState } from '../components/feedback.js'
import { IconButton } from '../primitives/button.js'
import {
  formatAmount,
  INCIDENTS,
  type Incident,
  KIND_LABELS,
  STATUS_LABELS,
} from '../stories/incidents.js'
import { DataTable, type DataTableColumn, type DataTableSort } from './data-table.js'

const meta = {
  title: 'Композиты/Таблица',
  id: 'composites-data-table',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const COLUMNS: Array<DataTableColumn<Incident>> = [
  {
    key: 'title',
    header: 'Происшествие',
    cell: (row) => <span className="truncate font-medium">{row.title}</span>,
    minWidth: 220,
    sortable: true,
  },
  { key: 'district', header: 'Район', cell: (row) => row.district, width: 120, sortable: true },
  { key: 'kind', header: 'Вид', cell: (row) => KIND_LABELS[row.kind], width: 120 },
  {
    key: 'status',
    header: 'Статус',
    cell: (row) => <StatusBadge status={row.status} label={STATUS_LABELS[row.status]} />,
    width: 150,
  },
  {
    key: 'victims',
    header: 'Пострадавшие',
    cell: (row) => row.victims,
    width: 110,
    align: 'end',
    sortable: true,
  },
  {
    key: 'damage',
    header: 'Ущерб, тыс. сомони',
    cell: (row) => formatAmount(row.damage),
    width: 150,
    align: 'end',
    sortable: true,
  },
]

/** Сортировка на стороне приложения: таблица только сообщает порядок. */
function sortRows(rows: Incident[], sort: DataTableSort[]): Incident[] {
  return [...rows].sort((a, b) => {
    for (const { field, direction } of sort) {
      const left = a[field as keyof Incident]
      const right = b[field as keyof Incident]
      const order =
        typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left).localeCompare(String(right), 'ru')
      if (order !== 0) return direction === 'asc' ? order : -order
    }
    return 0
  })
}

function TableDemo({
  initialSort = [],
  initialSelection,
  rows = INCIDENTS,
  loading,
  actions,
}: {
  initialSort?: DataTableSort[]
  initialSelection?: string[]
  rows?: Incident[]
  loading?: boolean
  actions?: boolean
}) {
  const [sort, setSort] = useState(initialSort)
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [selection, setSelection] = useState<Set<string>>(new Set(initialSelection))
  return (
    <div className="h-[420px] overflow-hidden rounded-md border border-line bg-surface">
      <DataTable
        aria-label="Происшествия"
        rows={sortRows(rows, sort)}
        getRowId={(row) => row.id}
        columns={COLUMNS}
        sort={sort}
        onSortChange={setSort}
        widths={widths}
        onWidthsChange={setWidths}
        selectable={initialSelection !== undefined}
        selection={selection}
        onSelectionChange={setSelection}
        loading={loading}
        rowActions={
          actions
            ? () => (
                <>
                  <IconButton label="Изменить" size="sm">
                    <Pencil className="size-3.5" />
                  </IconButton>
                  <IconButton label="Поделиться" size="sm">
                    <Share2 className="size-3.5" />
                  </IconButton>
                </>
              )
            : undefined
        }
        empty={
          <EmptyState
            compact
            icon={<Inbox className="size-5" />}
            title="Происшествий нет"
            description="За выбранный период сообщений не поступало."
          />
        }
      />
    </div>
  )
}

export const Sorting: Story = {
  name: 'Сортировка по нескольким полям',
  render: () => (
    <TableDemo
      initialSort={[
        { field: 'district', direction: 'asc' },
        { field: 'damage', direction: 'desc' },
      ]}
    />
  ),
}

export const SingleSort: Story = {
  name: 'Сортировка по ущербу',
  render: () => <TableDemo initialSort={[{ field: 'damage', direction: 'desc' }]} />,
}

export const Selection: Story = {
  name: 'Выделение строк',
  render: () => <TableDemo initialSelection={['inc-02', 'inc-09']} />,
}

export const KeyboardNavigation: Story = {
  name: 'Навигация с клавиатуры и действия строки',
  render: () => <TableDemo actions />,
  play: async ({ canvasElement }) => {
    const grid = within(canvasElement).getByRole('grid', { name: 'Происшествия' })
    grid.focus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
  },
}

export const Empty: Story = {
  name: 'Пусто',
  render: () => <TableDemo rows={[]} />,
}

export const Loading: Story = {
  name: 'Загрузка',
  render: () => <TableDemo rows={[]} loading />,
}
