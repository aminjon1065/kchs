import type { Meta, StoryObj } from '@storybook/react-vite'
import { Folder, Home, MoreHorizontal } from 'lucide-react'
import { IconButton } from '../primitives/button.js'
import {
  Avatar,
  AvatarGroup,
  Badge,
  Breadcrumbs,
  Card,
  KeyValueList,
  ScrollArea,
  Separator,
  Sparkline,
  STATUS_TONES,
  StatTile,
  StatusBadge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tag,
} from './data-display.js'

const meta = {
  title: 'Компоненты/Отображение данных',
  id: 'components-data-display',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const TONES = ['neutral', 'accent', 'success', 'warning', 'danger', 'purple', 'outline'] as const

export const Badges: Story = {
  name: 'Бейджи',
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {TONES.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {TONES.map((tone) => (
          <Badge key={tone} tone={tone} size="sm" dot>
            {tone}
          </Badge>
        ))}
      </div>
    </div>
  ),
}

export const StatusBadges: Story = {
  name: 'Статусы',
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      {Object.keys(STATUS_TONES).map((status) => (
        <StatusBadge key={status} status={status} />
      ))}
      <StatusBadge status="unknown" label="Неизвестный статус" />
    </div>
  ),
}

export const Tags: Story = {
  name: 'Теги',
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <Tag>паводок</Tag>
      <Tag color="chart-1">приоритет</Tag>
      <Tag color="chart-4" onRemove={() => undefined}>
        срочно
      </Tag>
      <Tag onRemove={() => undefined}>Хатлонская область</Tag>
    </div>
  ),
}

const PEOPLE = [
  { name: 'Иванов Иван' },
  { name: 'Каримова Зарина' },
  { name: 'Рахимов Фаррух' },
  { name: 'Петрова Анна' },
  { name: 'Шарипов Далер' },
  { name: 'Назарова Гулноза' },
  { name: 'Сидоров Олег' },
]

export const Avatars: Story = {
  name: 'Аватары',
  render: () => (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map((size) => (
          <Avatar key={size} name="Иванов Иван" size={size} />
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Avatar name="Каримова Зарина" status="online" />
        <Avatar name="Рахимов Фаррух" status="away" />
        <Avatar name="Петрова Анна" status="dnd" />
        <Avatar name="" />
      </div>
      <div className="flex items-center gap-4">
        <AvatarGroup people={PEOPLE.slice(0, 3)} />
        <AvatarGroup people={PEOPLE} max={4} />
        <AvatarGroup people={PEOPLE} max={3} size="md" />
      </div>
    </div>
  ),
}

export const Cards: Story = {
  name: 'Карточки',
  render: () => (
    <div className="grid max-w-[760px] grid-cols-2 gap-4">
      <Card
        title="Последние сводки"
        action={
          <IconButton label="Действия" size="sm">
            <MoreHorizontal className="size-4" />
          </IconButton>
        }
      >
        <p className="text-sm text-fg-secondary">Сводка за 17 сентября загружена в 08:15.</p>
      </Card>
      <Card>
        <p className="text-sm text-fg-secondary">Карточка без заголовка.</p>
      </Card>
      <Card title="Без внутренних отступов" padded={false}>
        <div className="border-b border-line px-4 py-2 text-sm">Первая строка</div>
        <div className="px-4 py-2 text-sm">Вторая строка</div>
      </Card>
      <Card title="Очень длинный заголовок карточки, который не помещается в одну строку">
        <p className="text-sm text-fg-secondary">Заголовок обрезается многоточием.</p>
      </Card>
    </div>
  ),
}

export const StatTiles: Story = {
  name: 'Показатели',
  render: () => (
    <div className="grid max-w-[900px] grid-cols-3 gap-4">
      <StatTile
        label="Происшествий за сутки"
        value="128"
        delta={{ value: 12.5, label: 'к прошлой неделе' }}
        spark={[4, 6, 5, 8, 7, 9, 12, 10, 14]}
      />
      <StatTile
        label="Среднее время реагирования"
        value="18"
        unit="мин"
        delta={{ value: 7.2, label: 'к прошлому месяцу', direction: 'lower_better' }}
      />
      <StatTile
        label="Пунктов размещения открыто"
        value="6"
        delta={{ value: -25, direction: 'higher_better' }}
        onClick={() => undefined}
      />
      <StatTile label="Без сравнения" value="1 204 350" />
    </div>
  ),
}

export const Sparklines: Story = {
  name: 'Искры',
  render: () => (
    <div className="flex max-w-[240px] flex-col gap-3">
      <Sparkline values={[1, 3, 2, 5, 4, 7, 6, 9]} />
      <Sparkline values={[9, 7, 8, 5, 6, 3, 4, 1]} className="text-danger" />
      <Sparkline values={[5, 5, 5, 5]} className="text-fg-muted" />
    </div>
  ),
}

export const KeyValues: Story = {
  name: 'Ключ — значение',
  render: () => (
    <div className="flex max-w-[640px] flex-col gap-6">
      <KeyValueList
        items={[
          { key: 'owner', label: 'Владелец', value: 'Иванов Иван' },
          { key: 'space', label: 'Пространство', value: 'Паводок-2026' },
          { key: 'updated', label: 'Изменён', value: '17.09.2026, 08:15' },
          { key: 'size', label: 'Размер', value: '2,4 МБ' },
        ]}
      />
      <KeyValueList
        columns={2}
        items={[
          { key: 'type', label: 'Тип', value: 'Датасет' },
          { key: 'rows', label: 'Строк', value: '5 000 000' },
          { key: 'version', label: 'Версия', value: '12' },
          { key: 'quality', label: 'Качество', value: 'Без замечаний' },
        ]}
      />
    </div>
  ),
}

export const TabsStory: Story = {
  name: 'Вкладки',
  render: () => (
    <Tabs defaultValue="table" className="max-w-[560px]">
      <TabsList>
        <TabsTrigger value="table">Таблица</TabsTrigger>
        <TabsTrigger value="schema" count={14}>
          Схема
        </TabsTrigger>
        <TabsTrigger value="versions" count={3}>
          Версии
        </TabsTrigger>
        <TabsTrigger value="access" disabled>
          Доступ
        </TabsTrigger>
      </TabsList>
      <TabsContent value="table" className="py-3 text-sm text-fg-secondary">
        Содержимое вкладки «Таблица».
      </TabsContent>
      <TabsContent value="schema" className="py-3 text-sm text-fg-secondary">
        Поля датасета.
      </TabsContent>
    </Tabs>
  ),
}

export const Separators: Story = {
  name: 'Разделители',
  render: () => (
    <div className="flex max-w-[360px] flex-col gap-3">
      <span className="text-sm">Над разделителем</span>
      <Separator />
      <div className="flex h-6 items-center gap-3 text-sm">
        <span>Слева</span>
        <Separator orientation="vertical" />
        <span>Справа</span>
      </div>
    </div>
  ),
}

export const Scroll: Story = {
  name: 'Прокрутка',
  render: () => (
    <ScrollArea className="h-40 max-w-[320px] rounded-md border border-line">
      <ul className="p-2 text-sm">
        {Array.from({ length: 20 }, (_, index) => (
          <li key={index} className="py-1">
            Строка {index + 1}
          </li>
        ))}
      </ul>
    </ScrollArea>
  ),
}

export const BreadcrumbsStory: Story = {
  name: 'Хлебные крошки',
  render: () => (
    <div className="flex max-w-[480px] flex-col gap-3">
      <Breadcrumbs
        items={[
          {
            id: 'home',
            label: 'Главная',
            icon: <Home className="size-3" />,
            onClick: () => undefined,
          },
          { id: 'space', label: 'Паводок-2026', onClick: () => undefined },
          { id: 'folder', label: 'Сводки', icon: <Folder className="size-3" /> },
        ]}
      />
      <Breadcrumbs
        className="max-w-[260px]"
        items={[
          { id: 'org', label: 'Комитет по чрезвычайным ситуациям', onClick: () => undefined },
          {
            id: 'unit',
            label: 'Управление анализа рисков и прогнозирования',
            onClick: () => undefined,
          },
          { id: 'doc', label: 'Регламент взаимодействия' },
        ]}
      />
    </div>
  ),
}
