import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { userEvent, within } from 'storybook/test'
import { TagInput, type TagItem } from './tag-input.js'

const meta = {
  title: 'Композиты/Теги',
  id: 'composites-tag-input',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** Словарь пространства «Паводок-2026»: цвета — ключи категориальной палитры. */
const DICTIONARY: TagItem[] = [
  { id: 't-1', name: 'паводок', color: 'chart-1' },
  { id: 't-2', name: 'срочно', color: 'chart-4' },
  { id: 't-3', name: 'Хатлонская область', color: null },
  { id: 't-4', name: 'сель', color: 'chart-3' },
  { id: 't-5', name: 'селевой поток', color: null },
  { id: 't-6', name: 'эвакуация', color: 'chart-5' },
  { id: 't-7', name: 'дамба', color: 'chart-6' },
  { id: 't-8', name: 'оползень', color: 'chart-10' },
]

function TagDemo({
  initial,
  readOnly,
  frame = 'max-w-[360px]',
}: {
  initial: string[]
  readOnly?: boolean
  frame?: string
}) {
  const [value, setValue] = useState<TagItem[]>(
    DICTIONARY.filter((tag) => initial.includes(tag.id)),
  )
  const [query, setQuery] = useState('')
  const suggestions = DICTIONARY.filter((tag) => tag.name.startsWith(query.toLowerCase()))
  return (
    <div className={frame}>
      <TagInput
        aria-label="Теги"
        value={value}
        suggestions={suggestions}
        onQueryChange={setQuery}
        onAdd={(name) =>
          setValue((current) => [
            ...current,
            DICTIONARY.find((tag) => tag.name === name) ?? { id: `new-${name}`, name, color: null },
          ])
        }
        onRemove={(tag) => setValue((current) => current.filter((item) => item.id !== tag.id))}
        readOnly={readOnly}
      />
    </div>
  )
}

export const Assigned: Story = {
  name: 'Теги объекта',
  render: () => <TagDemo initial={['t-1', 't-2', 't-3']} />,
}

export const Empty: Story = {
  name: 'Пусто',
  render: () => <TagDemo initial={[]} />,
}

export const ReadOnly: Story = {
  name: 'Только чтение',
  render: () => (
    <div className="flex flex-col gap-4">
      <TagDemo initial={['t-1', 't-2', 't-3', 't-6']} readOnly />
      <TagDemo initial={[]} readOnly />
    </div>
  ),
}

export const Suggestions: Story = {
  name: 'Подсказки и создание тега',
  render: () => <TagDemo initial={['t-1', 't-2', 't-3']} frame="h-[260px] max-w-[360px]" />,
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole('combobox', { name: 'Теги' })
    await userEvent.type(input, 'сел')
    await within(document.body).findByRole('option', { name: 'Создать тег «сел»' })
  },
}
