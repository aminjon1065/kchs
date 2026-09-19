import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { Slider } from './slider.js'

const meta = {
  title: 'Примитивы/Ползунок',
  id: 'primitives-slider',
  component: Slider,
} satisfies Meta<typeof Slider>

export default meta
type Story = StoryObj<typeof meta>

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

function RangeDemo() {
  const [value, setValue] = useState([2, 5])
  return (
    <div className="flex w-80 flex-col gap-2">
      <Slider
        min={0}
        max={11}
        value={value}
        onValueChange={setValue}
        thumbLabels={['С', 'По']}
        valueText={(month) => MONTHS[month] ?? ''}
      />
      <p className="text-xs text-fg-secondary tabular">
        {MONTHS[value[0] ?? 0]} — {MONTHS[value[1] ?? 0]} 2026
      </p>
    </div>
  )
}

export const Single: Story = {
  name: 'Одно значение',
  render: () => (
    <div className="flex w-80 flex-col gap-4">
      <Slider aria-label="Прозрачность" defaultValue={[75]} max={100} step={5} />
      <Slider aria-label="Малый" defaultValue={[30]} max={100} size="sm" />
      <Slider aria-label="Недоступен" defaultValue={[50]} max={100} disabled />
    </div>
  ),
}

export const Range: Story = {
  name: 'Диапазон',
  render: () => <RangeDemo />,
}
