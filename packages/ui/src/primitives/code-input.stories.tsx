import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { CodeInput } from './code-input.js'
import { Field } from './input.js'

const meta = {
  title: 'Примитивы/Код подтверждения',
  id: 'primitives-code-input',
  component: CodeInput,
  args: { value: '', onValueChange: () => undefined },
} satisfies Meta<typeof CodeInput>

export default meta
type Story = StoryObj<typeof meta>

function Controlled({
  initial,
  label,
  ...props
}: { initial: string; label: string } & Partial<Parameters<typeof CodeInput>[0]>) {
  const [value, setValue] = useState(initial)
  return (
    <Field label={label} htmlFor={label}>
      <CodeInput id={label} value={value} onValueChange={setValue} {...props} />
    </Field>
  )
}

export const States: Story = {
  name: 'Состояния',
  render: () => (
    <div className="flex max-w-[320px] flex-col gap-5">
      <Controlled label="Пустой" initial="" />
      <Controlled label="Набрано пять цифр" initial="48291" />
      <Controlled label="Набран полностью" initial="482917" />
      <Controlled label="Неверный код" initial="482917" invalid />
      <Controlled label="Недоступно" initial="4829" disabled />
    </div>
  ),
}

export const FourDigits: Story = {
  name: 'Четыре цифры',
  render: () => (
    <div className="max-w-[220px]">
      <Controlled label="ПИН-код" initial="07" length={4} />
    </div>
  ),
}
