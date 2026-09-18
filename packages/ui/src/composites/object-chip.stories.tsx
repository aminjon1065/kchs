import type { Meta, StoryObj } from '@storybook/react-vite'
import { within } from 'storybook/test'
import { ObjectChip, type ObjectChipData, UserChip } from './object-chip.js'

const meta = {
  title: 'Композиты/Чипы объектов',
  id: 'composites-object-chip',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const DATASET: ObjectChipData = {
  id: 'ds-1',
  type: 'dataset',
  title: 'Уровни воды',
  subtitle: 'Гидрологические посты · 1 240 строк',
  spaceName: 'Паводок-2026',
  ownerName: 'Каримова Зарина',
}

const USER = {
  id: 'u-1',
  displayName: 'Каримова Зарина',
  position: 'Ведущий аналитик',
  unitName: 'Управление анализа рисков',
}

export const Chips: Story = {
  name: 'Чипы',
  render: () => (
    <div className="flex max-w-[640px] flex-col items-start gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ObjectChip object={DATASET} />
        <ObjectChip
          object={{ id: 'd-1', type: 'dashboard', title: 'Паводковая обстановка' }}
          size="sm"
        />
        <ObjectChip
          object={{ id: 'f-1', type: 'file', title: 'Сводка по паводку за 17 сентября.pdf' }}
        />
        <ObjectChip object={{ id: 'x-1', type: 'document', title: '', accessible: false }} />
      </div>
      <div className="w-[180px]">
        <ObjectChip
          object={{
            id: 'm-1',
            type: 'map',
            title: 'Карта зон подтопления с очень длинным названием',
          }}
        />
      </div>
      <div className="flex items-center gap-3">
        <UserChip user={USER} />
        <UserChip user={USER} size="md" />
        <UserChip user={USER} showName={false} />
      </div>
    </div>
  ),
}

export const ChipCard: Story = {
  name: 'Карточка объекта',
  render: () => (
    <div className="h-[240px]">
      <ObjectChip
        object={DATASET}
        onOpen={() => undefined}
        onOpenInSplit={() => undefined}
        details={[{ label: 'Версия', value: '12' }]}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    within(canvasElement).getByRole('button', { name: 'Уровни воды' }).focus()
    await within(document.body).findByText('Гидрологические посты · 1 240 строк')
  },
}

export const UserCard: Story = {
  name: 'Карточка сотрудника',
  render: () => (
    <div className="h-[200px]">
      <UserChip user={USER} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const trigger = canvasElement.querySelector<HTMLElement>('[data-state]')
    trigger?.focus()
    await within(document.body).findByText('Ведущий аналитик')
  },
}
