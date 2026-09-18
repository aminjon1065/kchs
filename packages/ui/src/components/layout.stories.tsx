import type { Meta, StoryObj } from '@storybook/react-vite'
import { Filter, MoreHorizontal, Plus } from 'lucide-react'
import { Button, IconButton } from '../primitives/button.js'
import { Panel, PanelGroup, PanelToolbar, ResizeHandle, SectionHeader } from './layout.js'

const meta = {
  title: 'Компоненты/Раскладка',
  id: 'components-layout',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const SplitPanels: Story = {
  name: 'Разделённые панели',
  render: () => (
    <div className="h-[320px] overflow-hidden rounded-md border border-line">
      <PanelGroup direction="horizontal" id="story-split">
        <Panel defaultSize={35} minSize={20} id="left" order={1}>
          <div className="h-full bg-surface-2 p-3 text-sm text-fg-secondary">Навигатор</div>
        </Panel>
        <ResizeHandle />
        <Panel defaultSize={65} id="right" order={2}>
          <PanelGroup direction="vertical" id="story-split-vertical">
            <Panel defaultSize={60} id="top" order={1}>
              <div className="h-full bg-surface p-3 text-sm text-fg-secondary">Таблица</div>
            </Panel>
            <ResizeHandle direction="horizontal" />
            <Panel defaultSize={40} id="bottom" order={2}>
              <div className="h-full bg-surface p-3 text-sm text-fg-secondary">Профиль столбца</div>
            </Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  ),
}

export const Toolbar: Story = {
  name: 'Тулбар панели',
  render: () => (
    <div className="max-w-[720px] overflow-hidden rounded-md border border-line">
      <PanelToolbar
        left={
          <span className="truncate text-sm font-medium text-fg">
            Происшествия · 5 000 000 строк
          </span>
        }
        right={
          <>
            <Button size="sm" icon={<Filter className="size-3.5" />}>
              Фильтр
            </Button>
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />}>
              Строка
            </Button>
            <IconButton label="Ещё" size="sm">
              <MoreHorizontal className="size-4" />
            </IconButton>
          </>
        }
      />
      <div className="h-24 bg-surface" />
    </div>
  ),
}

export const Sections: Story = {
  name: 'Заголовок раздела',
  render: () => (
    <div className="flex max-w-[720px] flex-col gap-6">
      <SectionHeader
        title="Дашборды"
        description="Опубликованные дашборды пространства"
        action={<Button variant="primary">Создать</Button>}
      />
      <SectionHeader title="Раздел без описания и действия" />
    </div>
  ),
}
