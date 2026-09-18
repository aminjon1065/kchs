import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { Avatar, Badge } from '../components/data-display.js'
import {
  formatAmount,
  INCIDENTS,
  type Incident,
  type IncidentStatus,
  KIND_LABELS,
  STATUS_LABELS,
} from '../stories/incidents.js'
import { KanbanBoard, type KanbanColumn } from './kanban-board.js'

const meta = {
  title: 'Композиты/Доска',
  id: 'composites-kanban-board',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const ORDER: IncidentStatus[] = ['todo', 'in_progress', 'on_approval', 'done']
const COLUMNS: KanbanColumn[] = ORDER.map((status) => ({
  key: status,
  title: STATUS_LABELS[status],
}))

function IncidentCard({ incident }: { incident: Incident }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-medium leading-snug text-fg">{incident.title}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge size="sm">{KIND_LABELS[incident.kind]}</Badge>
        <span className="text-xs text-fg-muted">{incident.district}</span>
      </span>
      <span className="flex items-center justify-between gap-2 text-xs text-fg-muted">
        <span className="tabular">{formatAmount(incident.damage)} тыс. сомони</span>
        <Avatar name={incident.owner} size="xs" />
      </span>
    </div>
  )
}

/** Закрытое происшествие не возвращается в работу — пример ограничения маршрута. */
const canMove = (incident: Incident, to: string) =>
  incident.status !== 'done' &&
  Math.abs(ORDER.indexOf(to as IncidentStatus) - ORDER.indexOf(incident.status)) === 1

function BoardDemo({ items: initial = INCIDENTS }: { items?: Incident[] }) {
  const [items, setItems] = useState(initial)
  return (
    <div className="h-[560px] rounded-md border border-line bg-surface">
      <KanbanBoard
        aria-label="Происшествия по статусу"
        columns={COLUMNS}
        items={items}
        getItemId={(item) => item.id}
        getColumnKey={(item) => item.status}
        renderCard={(item) => <IncidentCard incident={item} />}
        canMove={canMove}
        onMove={(item, to) =>
          setItems((current) =>
            current.map((it) => (it.id === item.id ? { ...it, status: to as IncidentStatus } : it)),
          )
        }
      />
    </div>
  )
}

export const ByStatus: Story = {
  name: 'Доска по статусу',
  render: () => <BoardDemo />,
  play: async ({ canvasElement }) => {
    // Колонки не помещаются: доска прокручивается, а не растягивается по содержимому
    const board = within(canvasElement).getByRole('group', { name: 'Происшествия по статусу' })
    await expect(board.scrollWidth).toBeGreaterThan(board.clientWidth)
  },
}

export const KeyboardMove: Story = {
  name: 'Перенос карточки с клавиатуры',
  render: () => <BoardDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = canvas.getByRole('button', { name: /Сход селя на автодороге/ })
    card.focus()
    // Alt+→ переносит карточку в соседнюю колонку «В работе»; фокус остаётся на ней
    await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}')
    const moved = await within(canvas.getByRole('region', { name: 'В работе' })).findByRole(
      'button',
      { name: /Сход селя на автодороге/ },
    )
    await waitFor(() => expect(moved).toHaveFocus())
  },
}

export const EmptyColumns: Story = {
  name: 'Пустые колонки',
  render: () => <BoardDemo items={INCIDENTS.filter((item) => item.status === 'in_progress')} />,
}
