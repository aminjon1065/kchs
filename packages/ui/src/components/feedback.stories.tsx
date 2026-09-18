import type { Meta, StoryObj } from '@storybook/react-vite'
import { FolderOpen } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { Button } from '../primitives/button.js'
import {
  Callout,
  EmptyState,
  ErrorState,
  NoAccessState,
  ProgressBar,
  Skeleton,
  Spinner,
  TableSkeleton,
  useToast,
} from './feedback.js'

const meta = {
  title: 'Компоненты/Обратная связь',
  id: 'components-feedback',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Loading: Story = {
  name: 'Загрузка',
  render: () => (
    <div className="flex max-w-[640px] flex-col gap-4">
      <div className="flex items-center gap-3">
        <Spinner />
        <Spinner className="size-6" label="Загрузка списка" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="size-8 rounded-full" />
      </div>
      <TableSkeleton rows={5} columns={4} />
    </div>
  ),
}

export const Progress: Story = {
  name: 'Прогресс',
  render: () => (
    <div className="flex max-w-[360px] flex-col gap-3">
      <ProgressBar value={0} label="Импорт не начат" showValue />
      <ProgressBar value={0.45} label="Импорт" showValue />
      <ProgressBar value={1} label="Импорт завершён" showValue />
      <ProgressBar value={37} max={120} label="Загружено файлов" />
    </div>
  ),
}

export const Callouts: Story = {
  name: 'Сообщения',
  render: () => (
    <div className="flex max-w-[560px] flex-col gap-3">
      <Callout tone="info" title="Импорт выполняется в фоне">
        Можно продолжать работу — результат придёт уведомлением.
      </Callout>
      <Callout tone="success">Файл загружен и доступен участникам пространства.</Callout>
      <Callout
        tone="warning"
        title="Доступ к данным ограничен"
        action={
          <Button size="sm" variant="secondary">
            Запросить доступ
          </Button>
        }
      >
        Плитка использует датасет, к которому у вас нет прав.
      </Callout>
      <Callout tone="danger" title="Не удалось сохранить" onDismiss={() => undefined}>
        Объект изменён другим пользователем. Обновите страницу.
      </Callout>
      <Callout tone="neutral">Нейтральное сообщение без заголовка.</Callout>
    </div>
  ),
}

export const Empty: Story = {
  name: 'Пустое состояние',
  render: () => (
    <div className="grid max-w-[900px] grid-cols-2 gap-4">
      <EmptyState
        icon={<FolderOpen />}
        title="Папка пуста"
        description="Перетащите файлы сюда или нажмите «Загрузить»."
        action={<Button variant="primary">Загрузить</Button>}
      />
      <EmptyState compact title="Ничего не найдено" description="Измените условия поиска." />
    </div>
  ),
}

export const Errors: Story = {
  name: 'Ошибка и нет доступа',
  render: () => (
    <div className="grid max-w-[900px] grid-cols-2 gap-4">
      <ErrorState onRetry={() => undefined} />
      <NoAccessState onRequest={() => undefined} />
    </div>
  ),
}

function ToastsDemo() {
  const toast = useToast()
  const shown = useRef(false)
  useEffect(() => {
    // Строгий режим React вызывает эффект дважды — уведомления показываем один раз
    if (shown.current) return
    shown.current = true
    toast.show({ id: 'saved', title: 'Изменения сохранены', tone: 'success', duration: 0 })
    toast.show({
      id: 'trashed',
      title: 'Папка перемещена в корзину',
      description: 'Её можно восстановить в течение 30 дней',
      action: { label: 'Отменить', onClick: () => undefined },
      duration: 0,
    })
    toast.show({
      id: 'failed',
      title: 'Не удалось загрузить файл',
      description: 'Превышен размер 5 ГБ',
      tone: 'danger',
      duration: 0,
    })
  }, [toast])
  return <div className="h-[320px]" />
}

export const Toasts: Story = {
  name: 'Всплывающие уведомления',
  render: () => <ToastsDemo />,
}
