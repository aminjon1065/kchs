import type { Meta, StoryObj } from '@storybook/react-vite'
import { LayoutGrid, List, Table2 } from 'lucide-react'
import { useState } from 'react'
import {
  Checkbox,
  RadioGroup,
  RadioItem,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Switch,
} from './controls.js'

const meta = {
  title: 'Примитивы/Контролы',
  id: 'primitives-controls',
  component: Checkbox,
} satisfies Meta<typeof Checkbox>

export default meta
type Story = StoryObj<typeof meta>

export const Checkboxes: Story = {
  name: 'Флажки',
  render: () => (
    <div className="flex flex-col gap-3">
      <Checkbox label="Не отмечен" />
      <Checkbox label="Отмечен" defaultChecked />
      <Checkbox label="Частично" checked="indeterminate" />
      <Checkbox label="Недоступен" disabled />
      <Checkbox label="Отмечен и недоступен" defaultChecked disabled />
      <Checkbox aria-label="Без подписи" defaultChecked />
    </div>
  ),
}

export const Switches: Story = {
  name: 'Переключатели',
  render: () => (
    <div className="flex flex-col gap-3">
      <Switch label="Уведомления на почту" />
      <Switch label="Тихие часы" defaultChecked />
      <Switch label="Недоступно" disabled />
      <Switch label="Включено и недоступно" defaultChecked disabled />
    </div>
  ),
}

export const Radios: Story = {
  name: 'Радиокнопки',
  render: () => (
    <RadioGroup
      defaultValue="digest"
      aria-label="Доставка уведомлений"
      className="flex flex-col gap-3"
    >
      <RadioItem value="immediate" label="Сразу" />
      <RadioItem value="digest" label="Дайджестом раз в 15 минут" />
      <RadioItem value="off" label="Не присылать" disabled />
    </RadioGroup>
  ),
}

function SelectDemo({
  placeholder,
  defaultValue,
  invalid,
  disabled,
}: {
  placeholder?: string
  defaultValue?: string
  invalid?: boolean
  disabled?: boolean
}) {
  return (
    <Select defaultValue={defaultValue} disabled={disabled}>
      <SelectTrigger aria-label="Приоритет" invalid={invalid}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="low">Низкий</SelectItem>
        <SelectItem value="normal">Обычный</SelectItem>
        <SelectItem value="high">Высокий</SelectItem>
      </SelectContent>
    </Select>
  )
}

export const Selects: Story = {
  name: 'Выпадающий список',
  render: () => (
    <div className="flex max-w-[280px] flex-col gap-3">
      <SelectDemo placeholder="Выберите приоритет" />
      <SelectDemo defaultValue="high" />
      <SelectDemo defaultValue="normal" invalid />
      <SelectDemo defaultValue="low" disabled />
    </div>
  ),
}

export const SelectOpen: Story = {
  name: 'Выпадающий список — открыт',
  // Открытый Select (Radix) скрывает остальную страницу через aria-hidden, оставляя
  // триггер в порядке фокуса: axe видит это как aria-hidden-focus. Поведение
  // библиотеки на время открытия списка; закрытое состояние проверяется в «Выпадающий список».
  tags: ['no-axe'],
  render: () => (
    <div className="h-[320px] max-w-[280px]">
      <Select defaultValue="dushanbe" defaultOpen>
        <SelectTrigger aria-label="Территория">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectLabel>Города</SelectLabel>
          <SelectItem value="dushanbe">Душанбе</SelectItem>
          <SelectItem value="khujand">Худжанд</SelectItem>
          <SelectSeparator />
          <SelectLabel>Области</SelectLabel>
          <SelectItem value="sughd">Согдийская</SelectItem>
          <SelectItem value="khatlon">Хатлонская</SelectItem>
          <SelectItem value="gbao" disabled>
            ГБАО
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  ),
}

function SegmentedDemo({ size }: { size: 'sm' | 'md' }) {
  const [value, setValue] = useState<'table' | 'list' | 'board'>('table')
  return (
    <SegmentedControl
      aria-label="Режим представления"
      size={size}
      value={value}
      onValueChange={setValue}
      options={[
        { value: 'table', label: 'Таблица', icon: <Table2 className="size-3.5" /> },
        { value: 'list', label: 'Список', icon: <List className="size-3.5" /> },
        { value: 'board', label: 'Доска', icon: <LayoutGrid className="size-3.5" /> },
      ]}
    />
  )
}

function ThemeSegmentedDemo() {
  const [value, setValue] = useState<'light' | 'dark'>('light')
  return (
    <SegmentedControl
      aria-label="Тема"
      value={value}
      onValueChange={setValue}
      options={[
        { value: 'light', label: 'Светлая' },
        { value: 'dark', label: 'Тёмная' },
      ]}
    />
  )
}

export const Segmented: Story = {
  name: 'Сегменты',
  render: () => (
    <div className="flex flex-col items-start gap-3">
      <SegmentedDemo size="md" />
      <SegmentedDemo size="sm" />
      <ThemeSegmentedDemo />
    </div>
  ),
}
