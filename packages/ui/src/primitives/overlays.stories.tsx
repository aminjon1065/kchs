import type { Meta, StoryObj } from '@storybook/react-vite'
import { Copy, FolderInput, Pencil, Share2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { userEvent, within } from 'storybook/test'
import { Button } from './button.js'
import { Field, Input } from './input.js'
import {
  AlertDialog,
  Dialog,
  DialogContent,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Kbd,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetContent,
  Tooltip,
} from './overlays.js'

const meta = {
  title: 'Примитивы/Всплывающие окна',
  id: 'primitives-overlays',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const TooltipOpen: Story = {
  name: 'Подсказка',
  render: () => (
    <div className="flex h-[140px] items-end">
      <Tooltip content="Сохранить изменения" shortcut="⌘S" delay={0}>
        <Button variant="primary">Сохранить</Button>
      </Tooltip>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.hover(canvas.getByRole('button', { name: 'Сохранить' }))
    await within(document.body).findByRole('tooltip')
  },
}

export const Keys: Story = {
  name: 'Клавиши',
  render: () => (
    <div className="flex items-center gap-2 text-sm text-fg-secondary">
      <Kbd>⌘</Kbd>
      <Kbd>K</Kbd>
      <span>— палитра команд,</span>
      <Kbd>Esc</Kbd>
      <span>— закрыть</span>
    </div>
  ),
}

export const PopoverOpen: Story = {
  name: 'Поповер',
  render: () => (
    <div className="h-[220px]">
      <Popover defaultOpen>
        <PopoverTrigger asChild>
          <Button>Фильтр</Button>
        </PopoverTrigger>
        <PopoverContent className="w-72">
          <Field label="Название содержит" htmlFor="popover-filter">
            <Input id="popover-filter" defaultValue="паводок" />
          </Field>
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm">Сбросить</Button>
            <Button size="sm" variant="primary">
              Применить
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  ),
}

function MenuDemo() {
  const [columns, setColumns] = useState(true)
  const [sort, setSort] = useState('updated')
  return (
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger asChild>
        <Button>Действия</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Объект</DropdownMenuLabel>
        <DropdownMenuItem icon={<Pencil className="size-4" />} shortcut="F2">
          Переименовать
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Copy className="size-4" />}>Копировать ссылку</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger icon={<Share2 className="size-4" />}>
            Поделиться
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>С сотрудником</DropdownMenuItem>
            <DropdownMenuItem>По ссылке</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem icon={<FolderInput className="size-4" />} disabled>
          Перенести
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Вид</DropdownMenuLabel>
        <DropdownMenuCheckboxItem checked={columns} onCheckedChange={setColumns}>
          Показывать столбцы
        </DropdownMenuCheckboxItem>
        <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
          <DropdownMenuRadioItem value="updated">По изменению</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="title">По названию</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<Trash2 className="size-4" />} danger shortcut="⌫">
          В корзину
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const MenuOpen: Story = {
  name: 'Меню',
  render: () => (
    <div className="h-[420px]">
      <MenuDemo />
    </div>
  ),
}

export const DialogOpen: Story = {
  name: 'Диалог',
  render: () => (
    <Dialog defaultOpen>
      <DialogContent
        title="Новое пространство"
        description="Пространство объединяет людей и объекты проекта"
        footer={
          <>
            <Button>Отмена</Button>
            <Button variant="primary">Создать</Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Название" htmlFor="dialog-name" required>
            <Input id="dialog-name" defaultValue="Паводок-2026" />
          </Field>
          <Field label="Ключ" htmlFor="dialog-key" hint="Латиница, цифры и дефис">
            <Input id="dialog-key" defaultValue="flood-2026" mono />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  ),
}

export const DialogSmallWithoutClose: Story = {
  name: 'Диалог — малый, без кнопки закрытия',
  render: () => (
    <Dialog defaultOpen>
      <DialogContent title="Сессия истекает" size="sm" hideClose>
        <p className="text-sm text-fg-secondary">
          Через 2 минуты сессия завершится. Продолжить работу?
        </p>
      </DialogContent>
    </Dialog>
  ),
}

export const SheetRight: Story = {
  name: 'Боковая панель',
  render: () => (
    <Sheet defaultOpen>
      <SheetContent
        title="Карточка задачи"
        description="Проверить уровень воды у поста Кофарнихон"
        footer={<Button variant="primary">Сохранить</Button>}
      >
        <Field label="Исполнитель" htmlFor="sheet-assignee">
          <Input id="sheet-assignee" defaultValue="Иванов Иван" />
        </Field>
      </SheetContent>
    </Sheet>
  ),
}

export const SheetBottom: Story = {
  name: 'Нижняя панель',
  render: () => (
    <Sheet defaultOpen>
      <SheetContent side="bottom" title="Фильтры">
        <p className="text-sm text-fg-secondary">Настройки фильтров для мобильной раскладки.</p>
      </SheetContent>
    </Sheet>
  ),
}

export const AlertDestructive: Story = {
  name: 'Подтверждение удаления',
  render: () => (
    <AlertDialog
      open
      onOpenChange={() => undefined}
      title="Удалить папку «Сводки»?"
      description="Папка и 12 файлов попадут в корзину на 30 дней."
      consequences="Используется в 2 дашбордах и 1 отчёте — они покажут «нет данных»."
      confirmLabel="В корзину"
      onConfirm={() => undefined}
    />
  ),
}

export const AlertNeutral: Story = {
  name: 'Подтверждение действия',
  render: () => (
    <AlertDialog
      open
      onOpenChange={() => undefined}
      title="Отправить на согласование?"
      description="Маршрут начнётся с юридического отдела."
      destructive={false}
      onConfirm={() => undefined}
    />
  ),
}
