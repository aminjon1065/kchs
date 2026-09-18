import type { FilterNode } from '@kchs/contracts'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { userEvent, within } from 'storybook/test'
import { cn } from '../lib/cn.js'
import { KIND_LABELS } from '../stories/incidents.js'
import { FilterBuilder, type FilterField } from './filter-builder.js'

const meta = {
  title: 'Композиты/Конструктор фильтра',
  id: 'composites-filter-builder',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const DISTRICTS = ['Айни', 'Бохтар', 'Варзоб', 'Вахдат', 'Гиссар', 'Кулоб', 'Рудаки', 'Файзабад']

const FIELDS: FilterField[] = [
  { key: 'title', label: 'Происшествие', type: 'text' },
  {
    key: 'district',
    label: 'Район',
    type: 'select',
    options: DISTRICTS.map((district) => ({ value: district, label: district })),
  },
  {
    key: 'kind',
    label: 'Вид',
    type: 'select',
    options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
  },
  { key: 'victims', label: 'Пострадавшие', type: 'integer' },
  { key: 'damage', label: 'Ущерб, тыс. сомони', type: 'number' },
  { key: 'reported_at', label: 'Сообщено', type: 'datetime' },
  { key: 'confirmed', label: 'Подтверждено на месте', type: 'boolean' },
]

const CONDITIONS: FilterNode = {
  and: [
    { field: 'kind', op: 'in', value: ['flood', 'mudflow'] },
    { field: 'damage', op: 'gt', value: 1000 },
    { field: 'reported_at', op: 'relative', value: { unit: 'day', from: -6, to: 0 } },
    { field: 'confirmed', op: 'is_true' },
  ],
}

const WITH_GROUP: FilterNode = {
  and: [
    { field: 'kind', op: 'eq', value: 'flood' },
    {
      or: [
        { field: 'district', op: 'eq', value: 'Рудаки' },
        { field: 'district', op: 'eq', value: 'Вахдат' },
      ],
    },
    { field: 'victims', op: 'between', value: [1, 10] },
  ],
}

/** `className` — высота рамки: открытый поповер должен попасть в снимок. */
function FilterDemo({ initial, className }: { initial: FilterNode | null; className?: string }) {
  const [value, setValue] = useState<FilterNode | null>(initial)
  return (
    <div className={cn('max-w-[880px]', className)}>
      <FilterBuilder fields={FIELDS} value={value} onChange={setValue} />
    </div>
  )
}

export const Chips: Story = {
  name: 'Чипы условий',
  render: () => <FilterDemo initial={CONDITIONS} />,
}

export const Empty: Story = {
  name: 'Без условий',
  render: () => <FilterDemo initial={null} />,
}

export const AddCondition: Story = {
  name: 'Добавление условия',
  render: () => <FilterDemo initial={null} className="h-[400px]" />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Фильтр' }))
    await within(document.body).findByRole('textbox', { name: 'Найти поле' })
  },
}

export const EditCondition: Story = {
  name: 'Правка условия',
  render: () => <FilterDemo initial={CONDITIONS} className="h-[320px]" />,
  play: async ({ canvasElement }) => {
    const [first] = within(canvasElement).getAllByRole('button', { name: 'Изменить условие' })
    if (first) await userEvent.click(first)
    await within(document.body).findByRole('button', { name: 'Применить' })
  },
}

export const Advanced: Story = {
  name: 'Расширенный режим: группы «или»',
  render: () => <FilterDemo initial={WITH_GROUP} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Расширенный режим' }))
    await canvas.findByRole('button', { name: 'Простой режим' })
  },
}
