import type { Meta, StoryObj } from '@storybook/react-vite'
import { ArrowRight, Download, Pencil, Plus, Settings, Trash2 } from 'lucide-react'
import { Button, IconButton } from './button.js'

const meta = {
  title: 'Примитивы/Кнопки',
  id: 'primitives-button',
  component: Button,
  args: { children: 'Сохранить' },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

const VARIANTS = ['primary', 'secondary', 'ghost', 'danger', 'subtle', 'link'] as const

export const Variants: Story = {
  name: 'Варианты',
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      {VARIANTS.map((variant) => (
        <Button key={variant} variant={variant}>
          {variant}
        </Button>
      ))}
    </div>
  ),
}

export const Sizes: Story = {
  name: 'Размеры',
  render: () => (
    <div className="flex items-center gap-3">
      <Button size="sm">Маленькая</Button>
      <Button size="md">Средняя</Button>
      <Button size="lg">Большая</Button>
    </div>
  ),
}

export const WithIcons: Story = {
  name: 'С иконками',
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" icon={<Plus className="size-4" />}>
        Создать
      </Button>
      <Button icon={<Download className="size-4" />}>Скачать</Button>
      <Button variant="ghost" iconRight={<ArrowRight className="size-4" />}>
        Дальше
      </Button>
      <Button variant="danger" icon={<Trash2 className="size-4" />}>
        Удалить
      </Button>
    </div>
  ),
}

export const States: Story = {
  name: 'Состояния',
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" loading>
        Сохранение…
      </Button>
      <Button variant="primary" disabled>
        Недоступно
      </Button>
      <Button disabled>Недоступно</Button>
      <Button variant="danger" disabled>
        Удалить
      </Button>
    </div>
  ),
}

export const Block: Story = {
  name: 'На всю ширину',
  render: () => (
    <div className="flex max-w-[360px] flex-col gap-2">
      <Button variant="primary" block>
        Войти
      </Button>
      <Button block>Отмена</Button>
    </div>
  ),
}

export const AsLink: Story = {
  name: 'Как ссылка (asChild)',
  render: () => (
    <Button asChild variant="secondary" icon={<ArrowRight className="size-4" />}>
      <a href="#docs">Открыть документацию</a>
    </Button>
  ),
}

export const LongLabel: Story = {
  name: 'Длинная подпись',
  render: () => (
    <div className="flex max-w-[240px] flex-col gap-2">
      <Button variant="primary">Отправить на согласование руководителю управления</Button>
    </div>
  ),
}

export const IconButtons: Story = {
  name: 'Кнопки-иконки',
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        {(['ghost', 'secondary', 'primary', 'danger'] as const).map((variant) => (
          <IconButton key={variant} label={`Настройки: ${variant}`} variant={variant}>
            <Settings className="size-4" />
          </IconButton>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <IconButton label="Маленькая" size="sm">
          <Pencil className="size-3.5" />
        </IconButton>
        <IconButton label="Средняя" size="md">
          <Pencil className="size-4" />
        </IconButton>
        <IconButton label="Большая" size="lg">
          <Pencil className="size-4" />
        </IconButton>
        <IconButton label="Активная" active>
          <Pencil className="size-4" />
        </IconButton>
        <IconButton label="Недоступна" disabled>
          <Pencil className="size-4" />
        </IconButton>
      </div>
    </div>
  ),
}
