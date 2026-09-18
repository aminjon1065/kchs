import type { Meta, StoryObj } from '@storybook/react-vite'
import { FileText, Folder, LayoutDashboard, Plus, Table2 } from 'lucide-react'
import { useState } from 'react'
import { userEvent, within } from 'storybook/test'
import { Kbd } from '../primitives/overlays.js'
import { Badge } from './data-display.js'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandGroupHeading,
  CommandItem,
  CommandSeparator,
  InlineEdit,
  Tree,
  type TreeNode,
  VirtualList,
} from './navigation.js'

const meta = {
  title: 'Компоненты/Навигация',
  id: 'components-navigation',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Collapsibles: Story = {
  name: 'Сворачиваемый раздел',
  render: () => (
    <div className="flex max-w-[280px] flex-col gap-2">
      <Collapsible defaultOpen>
        <CollapsibleTrigger>Пространства</CollapsibleTrigger>
        <CollapsibleContent className="px-6 py-1 text-sm text-fg-secondary">
          Паводок-2026
        </CollapsibleContent>
      </Collapsible>
      <Collapsible>
        <CollapsibleTrigger>Избранное</CollapsibleTrigger>
        <CollapsibleContent className="px-6 py-1 text-sm text-fg-secondary">
          Скрыто
        </CollapsibleContent>
      </Collapsible>
    </div>
  ),
}

const NODES: TreeNode[] = [
  {
    id: 'flood',
    label: 'Паводок-2026',
    icon: <Folder />,
    children: [
      {
        id: 'reports',
        label: 'Сводки',
        icon: <Folder />,
        badge: <Badge size="sm">12</Badge>,
        children: [
          { id: 'r1', label: 'Сводка за 17 сентября', icon: <FileText /> },
          { id: 'r2', label: 'Сводка за 16 сентября', icon: <FileText /> },
        ],
      },
      { id: 'dash', label: 'Паводковая обстановка', icon: <LayoutDashboard /> },
      { id: 'data', label: 'Уровни воды', icon: <Table2 />, hasChildren: true },
    ],
  },
  {
    id: 'regs',
    label: 'Регламенты с очень длинным названием раздела',
    icon: <Folder />,
    hasChildren: true,
  },
]

function TreeDemo({ nodes }: { nodes: TreeNode[] }) {
  const [expanded, setExpanded] = useState(new Set(['flood', 'reports']))
  const [selected, setSelected] = useState<string | null>('r1')
  return (
    <div className="w-[280px] rounded-md border border-line bg-surface p-1">
      <Tree
        nodes={nodes}
        expandedIds={expanded}
        selectedId={selected}
        onSelect={(node) => setSelected(node.id)}
        onToggle={(id) =>
          setExpanded((current) => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
      />
    </div>
  )
}

export const TreeStory: Story = {
  name: 'Дерево',
  render: () => (
    <div className="flex gap-4">
      <TreeDemo nodes={NODES} />
      <TreeDemo nodes={[]} />
    </div>
  ),
}

const ROWS = Array.from({ length: 1000 }, (_, index) => `Строка датасета № ${index + 1}`)

export const VirtualListStory: Story = {
  name: 'Виртуальный список',
  render: () => (
    <div className="h-[240px] w-[320px] rounded-md border border-line bg-surface">
      <VirtualList
        items={ROWS}
        rowHeight={32}
        getKey={(row) => row}
        renderRow={(row, index) => (
          <div className="flex h-8 items-center justify-between border-b border-line px-3 text-sm">
            <span className="truncate">{row}</span>
            <span className="tabular text-xs text-fg-muted">{index + 1}</span>
          </div>
        )}
      />
    </div>
  ),
}

function CommandDemo({ mode }: { mode: 'results' | 'loading' | 'empty' }) {
  const [query, setQuery] = useState(mode === 'empty' ? 'нет такого' : 'паводок')
  return (
    <div className="h-[480px]">
      <CommandDialog
        open
        onOpenChange={() => undefined}
        value={query}
        onValueChange={setQuery}
        firstValue={mode === 'results' ? 'dataset-1' : ''}
        loading={mode === 'loading'}
        footer={
          <>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> открыть
            </span>
            <span className="flex items-center gap-1">
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd> в новой вкладке
            </span>
          </>
        }
      >
        {mode === 'empty' ? (
          <CommandEmpty className="px-3 py-6 text-center text-sm text-fg-muted">
            Ничего не найдено
          </CommandEmpty>
        ) : (
          <>
            <CommandGroup heading={<CommandGroupHeading>Объекты</CommandGroupHeading>}>
              <CommandItem value="dataset-1" icon={<Table2 />} hint="Паводок-2026">
                Уровни воды
              </CommandItem>
              <CommandItem value="dash-1" icon={<LayoutDashboard />} hint="Паводок-2026">
                Паводковая обстановка
              </CommandItem>
              <CommandItem value="file-1" icon={<FileText />} hint="Сводки">
                Сводка по паводку за 17 сентября
              </CommandItem>
            </CommandGroup>
            <CommandSeparator className="my-1 h-px bg-line" />
            <CommandGroup heading={<CommandGroupHeading>Команды</CommandGroupHeading>}>
              <CommandItem value="cmd-new" icon={<Plus />} shortcut="⌘N">
                Создать…
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandDialog>
    </div>
  )
}

export const CommandPalette: Story = {
  name: 'Палитра команд',
  render: () => <CommandDemo mode="results" />,
}

export const CommandPaletteLoading: Story = {
  name: 'Палитра команд — поиск',
  render: () => <CommandDemo mode="loading" />,
}

export const CommandPaletteEmpty: Story = {
  name: 'Палитра команд — пусто',
  // Пустой список cmdk — listbox без option: axe требует дочерние option
  // (aria-required-children). Ограничение библиотеки; палитра с результатами проверяется.
  tags: ['no-axe'],
  render: () => <CommandDemo mode="empty" />,
}

function InlineEditDemo({ initial, disabled }: { initial: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <InlineEdit
      aria-label="Название"
      value={value}
      onSave={setValue}
      disabled={disabled}
      className="text-lg font-semibold"
    />
  )
}

export const InlineEditing: Story = {
  name: 'Правка на месте',
  render: () => (
    <div className="flex max-w-[360px] flex-col items-start gap-3">
      <InlineEditDemo initial="Паводок-2026" />
      <InlineEditDemo initial="" />
      <InlineEditDemo initial="Только чтение" disabled />
    </div>
  ),
}

export const InlineEditingActive: Story = {
  name: 'Правка на месте — редактирование',
  render: () => (
    <div className="max-w-[360px]">
      <InlineEditDemo initial="Паводок-2026" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Название' }))
    await canvas.findByRole('textbox', { name: 'Название' })
  },
}
