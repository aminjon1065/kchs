import type { Meta, StoryObj } from '@storybook/react-vite'
import { Hash, Mail } from 'lucide-react'
import { useState } from 'react'
import { Field, Input, PasswordInput, SearchInput, Textarea } from './input.js'

const meta = {
  title: 'Примитивы/Поля ввода',
  id: 'primitives-input',
  component: Input,
} satisfies Meta<typeof Input>

export default meta
type Story = StoryObj<typeof meta>

export const States: Story = {
  name: 'Состояния',
  render: () => (
    <div className="flex max-w-[360px] flex-col gap-3">
      <Input aria-label="Пустое поле" placeholder="Введите название" />
      <Input aria-label="Заполненное поле" defaultValue="Сводка по паводку за сентябрь" />
      <Input aria-label="Ошибка" defaultValue="неверный формат" invalid />
      <Input aria-label="Недоступно" defaultValue="Недоступно для изменения" disabled />
      <Input aria-label="Только чтение" defaultValue="Только чтение" readOnly />
      <Input aria-label="Код" defaultValue="TJ-DSH-0042" mono />
    </div>
  ),
}

export const WithAffixes: Story = {
  name: 'С префиксом и суффиксом',
  render: () => (
    <div className="flex max-w-[360px] flex-col gap-3">
      <Input
        aria-label="Почта"
        prefix={<Mail className="size-4" />}
        defaultValue="ivanov@kchs.tj"
      />
      <Input
        aria-label="Номер"
        prefix={<Hash className="size-4" />}
        suffix="шт."
        defaultValue="12"
      />
      <Input
        aria-label="Ошибка"
        prefix={<Mail className="size-4" />}
        invalid
        defaultValue="ivanov@"
      />
      {/* Состояния обёртки берутся из внутреннего поля: без правки поле выглядит как обычное */}
      <Input
        aria-label="Почта только для чтения"
        prefix={<Mail className="size-4" />}
        readOnly
        defaultValue="ivanov@kchs.tj"
      />
      <Input
        aria-label="Номер недоступен"
        prefix={<Hash className="size-4" />}
        suffix="шт."
        disabled
        defaultValue="12"
      />
    </div>
  ),
}

export const Password: Story = {
  name: 'Пароль',
  render: () => (
    <div className="flex max-w-[360px] flex-col gap-3">
      <PasswordInput aria-label="Пароль" defaultValue="Kchs!Start-2026" />
      <PasswordInput aria-label="Пароль недоступен" defaultValue="Kchs!Start-2026" disabled />
    </div>
  ),
}

function SearchDemo({ initial, disabled }: { initial: string; disabled?: boolean }) {
  const [value, setValue] = useState(initial)
  return (
    <SearchInput
      aria-label={disabled ? 'Поиск недоступен' : 'Поиск'}
      value={value}
      onValueChange={setValue}
      disabled={disabled}
    />
  )
}

export const Search: Story = {
  name: 'Поиск',
  render: () => (
    <div className="flex max-w-[360px] flex-col gap-3">
      <SearchDemo initial="" />
      <SearchDemo initial="паводок" />
      <SearchDemo initial="сель" disabled />
    </div>
  ),
}

export const Multiline: Story = {
  name: 'Многострочное поле',
  render: () => (
    <div className="flex max-w-[420px] flex-col gap-3">
      <Textarea aria-label="Описание" placeholder="Опишите происшествие" />
      <Textarea
        aria-label="Заполненное описание"
        defaultValue={
          'Подтопление подвалов на улице Рудаки.\nЭвакуированы жители двух подъездов, организован пункт временного размещения.'
        }
      />
      <Textarea aria-label="Ошибка" invalid defaultValue="Слишком коротко" />
      <Textarea aria-label="Недоступно" disabled defaultValue="Недоступно для изменения" />
    </div>
  ),
}

export const Fields: Story = {
  name: 'Поле формы',
  render: () => (
    <div className="flex max-w-[360px] flex-col gap-4">
      <Field label="Название" htmlFor="field-title" hint="Видно всем участникам пространства">
        <Input id="field-title" defaultValue="Паводок-2026" />
      </Field>
      <Field label="Ответственный" htmlFor="field-owner" required>
        <Input id="field-owner" placeholder="Выберите сотрудника" />
      </Field>
      <Field label="Срок" htmlFor="field-due" error="Срок не может быть в прошлом">
        <Input id="field-due" defaultValue="01.01.2020" invalid />
      </Field>
    </div>
  ),
}
