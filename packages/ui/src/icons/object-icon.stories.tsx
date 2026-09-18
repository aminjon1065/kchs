import type { Meta, StoryObj } from '@storybook/react-vite'
import { OBJECT_ICONS, ObjectIcon } from './object-icon.js'

const meta = {
  title: 'Иконки/Типы объектов',
  id: 'icons-object-icon',
  component: ObjectIcon,
  args: { type: 'dataset' },
} satisfies Meta<typeof ObjectIcon>

export default meta
type Story = StoryObj<typeof meta>

export const Gallery: Story = {
  name: 'Все глифы',
  render: () => (
    <div className="grid max-w-[880px] grid-cols-6 gap-2">
      {Object.keys(OBJECT_ICONS).map((type) => (
        <div
          key={type}
          className="flex flex-col items-center gap-1.5 rounded-md border border-line bg-surface p-3"
        >
          <ObjectIcon type={type} className="size-5 text-fg-secondary" />
          <span className="font-mono text-2xs text-fg-muted">{type}</span>
        </div>
      ))}
    </div>
  ),
}

export const Sizes: Story = {
  name: 'Размеры и цвет',
  render: () => (
    <div className="flex items-center gap-4 text-fg">
      <ObjectIcon type="dataset" className="size-3.5" />
      <ObjectIcon type="dataset" className="size-4" />
      <ObjectIcon type="dataset" className="size-5 text-accent" />
      <ObjectIcon type="map" className="size-6 text-success" />
      <ObjectIcon type="unknown-type" className="size-6 text-fg-muted" />
    </div>
  ),
}
