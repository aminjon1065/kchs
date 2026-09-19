import type { Meta, StoryObj } from '@storybook/react-vite'
import { Repeat, Video } from 'lucide-react'
import { useState } from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { Avatar } from '../../components/data-display.js'
import { AvailabilityGrid } from './availability-grid.js'
import { CalendarColorPicker } from './color-picker.js'
import { addDays, dayLabel, monthWeeks, weekdayNames } from './dates.js'
import { MiniCalendar } from './mini-calendar.js'
import { MonthGrid, type MonthGridItem } from './month-grid.js'
import { TimeGrid, type TimeGridEvent, type TimeGridRange } from './time-grid.js'

const meta = {
  title: 'Композиты/Календарь',
  id: 'composites-calendar',
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** Неделя 21–27 сентября 2026: понедельник — «сегодня». */
const MONDAY = '2026-09-21'
const WEEK = Array.from({ length: 7 }, (_, index) => addDays(MONDAY, index))
const WEEKDAYS = weekdayNames('ru', 1)

const label = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`

const INITIAL: TimeGridEvent[] = [
  {
    key: 'standup',
    day: 0,
    start: 9 * 60,
    end: 9 * 60 + 30,
    title: 'Планёрка штаба',
    meta: '09:00–09:30 · Зал 305',
    tone: 'blue',
    editable: true,
    label: 'Планёрка штаба, 09:00–09:30',
    icon: <Repeat className="size-3 shrink-0" aria-hidden />,
  },
  {
    key: 'review',
    day: 0,
    start: 10 * 60,
    end: 11 * 60 + 30,
    title: 'Разбор паводковой обстановки',
    meta: '10:00–11:30',
    tone: 'green',
    editable: true,
    label: 'Разбор паводковой обстановки, 10:00–11:30',
    icon: <Video className="size-3 shrink-0" aria-hidden />,
  },
  {
    key: 'call',
    day: 0,
    start: 10 * 60 + 30,
    end: 11 * 60,
    title: 'Созвон с районом',
    meta: '10:30–11:00',
    tone: 'orange',
    variant: 'pending',
    label: 'Созвон с районом, 10:30–11:00, приглашение без ответа',
  },
  {
    key: 'busy',
    day: 1,
    start: 13 * 60,
    end: 14 * 60,
    title: 'Занято',
    tone: 'slate',
    variant: 'busy',
    label: 'Занято, 13:00–14:00',
  },
  {
    key: 'maybe',
    day: 2,
    start: 15 * 60,
    end: 16 * 60,
    title: 'Учения',
    meta: '15:00–16:00',
    tone: 'purple',
    variant: 'tentative',
    label: 'Учения, 15:00–16:00, возможно',
  },
  {
    key: 'declined',
    day: 3,
    start: 11 * 60,
    end: 12 * 60,
    title: 'Семинар',
    meta: '11:00–12:00',
    tone: 'teal',
    variant: 'declined',
    label: 'Семинар, 11:00–12:00, отказ',
  },
]

function WeekDemo({ days = 7 }: { days?: number }) {
  const [events, setEvents] = useState(INITIAL.filter((event) => event.day < days))
  const [log, setLog] = useState('')
  const change = (key: string, next: TimeGridRange) => {
    setEvents((current) =>
      current.map((event) =>
        event.key === key
          ? { ...event, ...next, meta: `${label(next.start)}–${label(next.end)}` }
          : event,
      ),
    )
    setLog(`${key}: ${label(next.start)}–${label(next.end)}`)
  }
  return (
    <div className="flex h-[640px] flex-col rounded-md border border-line">
      <TimeGrid
        aria-label="Неделя"
        days={WEEK.slice(0, days).map((date, index) => ({
          key: date,
          label: `${WEEKDAYS[index]} ${Number(date.slice(8))}`,
          ariaLabel: dayLabel(date, 'ru'),
          today: index === 0,
          muted: index >= 5,
          note: index === 6 ? 'День города' : null,
        }))}
        events={events}
        allDay={[
          {
            key: 'trip',
            first: 1,
            last: Math.min(days - 1, 3),
            title: 'Командировка в Хатлон',
            tone: 'brown',
            label: 'Командировка в Хатлон, 22–24 сентября',
          },
          {
            key: 'due',
            first: 0,
            last: 0,
            title: 'Срок: сводка по паводку',
            tone: 'red',
            variant: 'free',
            label: 'Срок поручения: сводка по паводку',
          },
        ]}
        workingHours={{ start: 9 * 60, end: 18 * 60 }}
        now={{ day: 0, minute: 10 * 60 + 12 }}
        initialScrollMinute={8 * 60}
        onChange={change}
        onCreate={(range) => setLog(`создать: ${label(range.start)}–${label(range.end)}`)}
      />
      <output
        aria-label="Последнее действие"
        className="border-t border-line px-3 py-1 text-xs text-fg-muted"
      >
        {log || '—'}
      </output>
    </div>
  )
}

export const Week: Story = {
  name: 'Неделя',
  render: () => <WeekDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // Перенос с клавиатуры: Alt+↓ сдвигает планёрку на 15 минут
    const standup = canvas.getByRole('button', { name: /Планёрка штаба/ })
    standup.focus()
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await waitFor(() =>
      expect(canvas.getByLabelText('Последнее действие')).toHaveTextContent('standup: 09:15–09:45'),
    )
  },
}

export const Day: Story = {
  name: 'День',
  render: () => <WeekDemo days={1} />,
}

const MONTH_ITEMS: MonthGridItem[] = [
  {
    key: 'm1',
    day: '2026-09-21',
    title: 'Планёрка штаба',
    time: '09:00',
    tone: 'blue',
    label: 'Планёрка штаба, 21 сентября 09:00',
  },
  {
    key: 'm2',
    day: '2026-09-21',
    title: 'Разбор обстановки',
    time: '10:00',
    tone: 'green',
    label: 'Разбор обстановки, 21 сентября 10:00',
  },
  {
    key: 'm3',
    day: '2026-09-21',
    title: 'Созвон с районом',
    time: '10:30',
    tone: 'orange',
    variant: 'pending',
    label: 'Созвон с районом',
  },
  {
    key: 'm4',
    day: '2026-09-21',
    title: 'Совещание',
    time: '15:00',
    tone: 'purple',
    label: 'Совещание',
  },
  {
    key: 'm5',
    day: '2026-09-09',
    title: 'День независимости',
    tone: 'red',
    allDay: true,
    label: 'День независимости, весь день',
  },
  {
    key: 'm6',
    day: '2026-09-15',
    title: 'Занято',
    time: '13:00',
    tone: 'slate',
    variant: 'busy',
    label: 'Занято',
  },
]

export const Month: Story = {
  name: 'Месяц',
  render: () => (
    <div className="h-[640px] rounded-md border border-line">
      <MonthGrid
        aria-label="Сентябрь 2026"
        weekdays={WEEKDAYS}
        weeks={monthWeeks('2026-09').map((week) =>
          week.map((date) => ({
            key: date,
            label: Number(date.slice(8)),
            ariaLabel: dayLabel(date, 'ru'),
            outside: date.slice(0, 7) !== '2026-09',
            today: date === MONDAY,
            muted: [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()),
            note: date === '2026-09-09' ? 'Праздник' : null,
          })),
        )}
        items={MONTH_ITEMS}
      />
    </div>
  ),
}

function MiniDemo() {
  const [month, setMonth] = useState('2026-09')
  const [value, setValue] = useState<string | null>(MONDAY)
  return (
    <div className="w-64 rounded-md border border-line bg-surface p-2">
      <MiniCalendar
        aria-label="Выбор дня"
        month={month}
        onMonthChange={setMonth}
        value={value}
        onSelect={setValue}
        today={MONDAY}
        range={{ from: MONDAY, to: addDays(MONDAY, 6) }}
        marks={{ '2026-09-09': 'holiday', '2026-09-26': 'work' }}
        busy={new Set(['2026-09-21', '2026-09-23', '2026-09-24'])}
      />
    </div>
  )
}

export const Mini: Story = {
  name: 'Мини-календарь',
  render: () => <MiniDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /понедельник, 21 сентября 2026/ }))
    await userEvent.keyboard('{ArrowRight}')
    await waitFor(() =>
      expect(canvas.getByRole('button', { name: /вторник, 22 сентября 2026/ })).toHaveFocus(),
    )
  },
}

const DAY_START = Date.UTC(2026, 8, 21, 3)
const HOUR = 3_600_000

export const Availability: Story = {
  name: 'Занятость участников',
  render: () => (
    <div className="w-[760px] bg-surface">
      <AvailabilityGrid
        aria-label="Занятость 21 сентября"
        start={DAY_START}
        end={DAY_START + 11 * HOUR}
        ticks={Array.from({ length: 11 }, (_, index) => ({
          at: DAY_START + index * HOUR,
          label: `${String(8 + index).padStart(2, '0')}:00`,
        }))}
        formatRange={(from, to) =>
          `${label(((from - DAY_START) / 60_000 + 8 * 60) % 1440)}–${label(
            ((to - DAY_START) / 60_000 + 8 * 60) % 1440,
          )}`
        }
        selection={{ start: DAY_START + 3 * HOUR, end: DAY_START + 4 * HOUR }}
        suggestions={[
          { start: DAY_START + 3 * HOUR, end: DAY_START + 4 * HOUR },
          { start: DAY_START + 7 * HOUR, end: DAY_START + 8 * HOUR },
        ]}
        rows={[
          {
            key: 'me',
            label: 'Каримов Ф. А.',
            sublabel: 'Организатор',
            icon: <Avatar name="Каримов Ф. А." size="sm" />,
            working: [{ start: DAY_START + HOUR, end: DAY_START + 10 * HOUR }],
            busy: [
              { start: DAY_START + HOUR, end: DAY_START + 1.5 * HOUR, title: 'Планёрка' },
              { start: DAY_START + 2 * HOUR, end: DAY_START + 3 * HOUR },
            ],
          },
          {
            key: 'colleague',
            label: 'Рахимова М. С.',
            sublabel: 'Отдел мониторинга',
            icon: <Avatar name="Рахимова М. С." size="sm" />,
            working: [{ start: DAY_START + HOUR, end: DAY_START + 10 * HOUR }],
            busy: [
              {
                start: DAY_START + 4.5 * HOUR,
                end: DAY_START + 6 * HOUR,
                tentative: true,
              },
            ],
          },
          {
            key: 'room',
            label: 'Переговорная 305',
            sublabel: '12 мест',
            busy: [{ start: DAY_START + 6 * HOUR, end: DAY_START + 7 * HOUR }],
          },
        ]}
      />
    </div>
  ),
}

const COLOR_LABELS = {
  blue: 'Синий',
  orange: 'Оранжевый',
  green: 'Зелёный',
  red: 'Красный',
  purple: 'Фиолетовый',
  teal: 'Бирюзовый',
  gold: 'Золотой',
  pink: 'Розовый',
  slate: 'Серый',
  brown: 'Коричневый',
} as const

function ColorsDemo() {
  const [value, setValue] = useState<keyof typeof COLOR_LABELS | null>('green')
  return (
    <div className="flex flex-col gap-2 bg-surface p-3">
      <CalendarColorPicker
        aria-label="Цвет события"
        value={value}
        onChange={setValue}
        colors={Object.keys(COLOR_LABELS) as Array<keyof typeof COLOR_LABELS>}
        labels={COLOR_LABELS}
        defaultLabel="Цвет календаря"
      />
      <output aria-label="Выбранный цвет" className="text-xs text-fg-muted">
        {value ? COLOR_LABELS[value] : 'Цвет календаря'}
      </output>
    </div>
  )
}

export const Colors: Story = {
  name: 'Цвет календаря',
  render: () => <ColorsDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // Радиогруппа: стрелка вправо — следующий цвет
    // (клавиша отпускается после выбора: Radix выбирает цвет, пока стрелка нажата)
    canvas.getByRole('radio', { name: 'Зелёный' }).focus()
    await userEvent.keyboard('{ArrowRight>}')
    await waitFor(() =>
      expect(canvas.getByLabelText('Выбранный цвет')).toHaveTextContent('Красный'),
    )
    await userEvent.keyboard('{/ArrowRight}')
  },
}
