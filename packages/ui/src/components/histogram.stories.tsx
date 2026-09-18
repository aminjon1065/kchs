import type { Meta, StoryObj } from '@storybook/react-vite'
import { Histogram } from './histogram.js'

const meta = {
  title: 'Компоненты/Гистограмма',
  id: 'components-histogram',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const NORMAL = [1, 2, 4, 7, 12, 18, 25, 31, 36, 38, 36, 31, 25, 18, 12, 7, 4, 2, 1, 1]
const SKEWED = [120, 64, 33, 18, 9, 5, 3, 2, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]

export const Distributions: Story = {
  name: 'Распределения',
  render: () => (
    <div className="flex max-w-[360px] flex-col gap-4">
      <Histogram values={NORMAL} label="Ущерб: колоколообразное распределение" />
      <Histogram values={SKEWED} label="Число пострадавших: длинный хвост" />
      <Histogram values={[42]} label="Одно значение" className="h-10" />
    </div>
  ),
}
