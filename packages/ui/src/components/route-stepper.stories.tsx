import type { Meta, StoryObj } from '@storybook/react-vite'
import { RouteStepper } from './route-stepper.js'

const meta = {
  title: 'Компоненты/Маршрут шагами',
  id: 'components-route-stepper',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const Current: Story = {
  name: 'Текущий шаг — ваш',
  render: () => (
    <div className="max-w-[880px] rounded-lg border border-line bg-surface p-4">
      <RouteStepper
        aria-label="Маршрут"
        steps={[
          {
            key: 'register',
            title: 'Регистрация',
            people: 'Дежурная смена · 13:05',
            meta: 'за 34 мин · норма 1 ч',
            metaTone: 'success',
            state: 'done',
          },
          {
            key: 'resolve',
            title: 'Резолюция',
            people: 'Саидов Б. · вы',
            meta: 'до 17:05',
            metaTone: 'accent',
            state: 'current',
          },
          { key: 'execute', title: 'Исполнение', people: 'по резолюции', state: 'upcoming' },
          {
            key: 'control',
            title: 'Контроль',
            people: 'Оперативное управление',
            state: 'upcoming',
          },
        ]}
      />
    </div>
  ),
}

export const Finished: Story = {
  name: 'Пройден, просрочка и отклонение',
  render: () => (
    <div className="flex max-w-[880px] flex-col gap-4 rounded-lg border border-line bg-surface p-4">
      <RouteStepper
        aria-label="Маршрут согласования"
        steps={[
          {
            key: 'approve',
            title: 'Согласование',
            people: 'Назаров Р.',
            meta: 'за 2 ч 10 мин',
            metaTone: 'success',
            state: 'done',
          },
          {
            key: 'sign',
            title: 'Подпись',
            people: 'Саидов Б.',
            meta: 'просрочено на 25 мин',
            metaTone: 'danger',
            state: 'current',
          },
          { key: 'register', title: 'Регистрация', people: 'Канцелярия', state: 'upcoming' },
        ]}
      />
      <RouteStepper
        aria-label="Отклонённый маршрут"
        steps={[
          { key: 'approve', title: 'Согласование', people: 'Назаров Р.', state: 'done' },
          {
            key: 'sign',
            title: 'Подпись',
            people: 'Саидов Б.',
            meta: 'отклонено 04.11 15:20',
            metaTone: 'danger',
            state: 'rejected',
          },
        ]}
      />
    </div>
  ),
}
