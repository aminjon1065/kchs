import { ChevronLeft, ChevronRight } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useUiLocale, useUiT } from '../../i18n/ui-locale.js'
import { cn } from '../../lib/cn.js'
import { IconButton } from '../../primitives/button.js'
import {
  addDays,
  addMonths,
  dayLabel,
  monthTitle,
  monthWeeks,
  startOfWeek,
  weekday,
  weekdayNames,
} from './dates.js'

/** Отметка дня производственного календаря. */
export type MiniCalendarMark = 'holiday' | 'weekend' | 'work' | 'short'

export interface MiniCalendarProps {
  /** Показанный месяц `ГГГГ-ММ`. */
  month: string
  onMonthChange: (month: string) => void
  /** Выбранный день. */
  value: string | null
  onSelect: (date: string) => void
  /** Сегодня (в поясе пользователя). */
  today: string
  /** Подсвеченный диапазон — видимая неделя или месяц основной сетки. */
  range?: { from: string; to: string } | null
  /** Праздники, перенесённые выходные, рабочие субботы. */
  marks?: Record<string, MiniCalendarMark>
  /** Дни с событиями — точка под числом. */
  busy?: ReadonlySet<string>
  weekStartsOn?: 0 | 1
  'aria-label': string
  className?: string
}

/**
 * Мини-календарь левой колонки: месяц, выбор дня, стрелки для перехода по
 * месяцам. Клавиатура: стрелки — по дням и неделям, PageUp/PageDown — по
 * месяцам, Home/End — начало и конец недели, Enter — выбрать.
 */
export function MiniCalendar({
  month,
  onMonthChange,
  value,
  onSelect,
  today,
  range = null,
  marks = {},
  busy,
  weekStartsOn = 1,
  className,
  ...props
}: MiniCalendarProps) {
  const t = useUiT()
  const locale = useUiLocale()
  const [focused, setFocused] = useState(value ?? today)
  const grid = useRef<HTMLTableElement>(null)
  const moving = useRef(false)
  const weeks = monthWeeks(month, weekStartsOn)
  const names = weekdayNames(locale, weekStartsOn, 'narrow')

  // Фокус следует за клавиатурой: после перехода на другой месяц — на новый день
  useEffect(() => {
    if (!moving.current) return
    moving.current = false
    grid.current?.querySelector<HTMLButtonElement>(`[data-date="${focused}"]`)?.focus()
  }, [focused])

  const move = (date: string) => {
    moving.current = true
    setFocused(date)
    if (date.slice(0, 7) !== month) onMonthChange(date.slice(0, 7))
  }

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, date: string) => {
    const step: Record<string, () => string> = {
      ArrowLeft: () => addDays(date, -1),
      ArrowRight: () => addDays(date, 1),
      ArrowUp: () => addDays(date, -7),
      ArrowDown: () => addDays(date, 7),
      PageUp: () => `${addMonths(date.slice(0, 7), -1)}${date.slice(7)}`,
      PageDown: () => `${addMonths(date.slice(0, 7), 1)}${date.slice(7)}`,
      Home: () => startOfWeek(date, weekStartsOn),
      End: () => addDays(startOfWeek(date, weekStartsOn), 6),
    }
    const next = step[event.key]
    if (!next) return
    event.preventDefault()
    const target = next()
    // Несуществующее число (31 → 30 ноября) — последний день месяца
    const valid = Number.isNaN(Date.parse(`${target}T00:00:00Z`))
      ? addDays(`${target.slice(0, 7)}-01`, -1)
      : target
    move(valid)
  }

  const inRange = (date: string) => Boolean(range && date >= range.from && date <= range.to)

  return (
    <div className={cn('flex w-full flex-col gap-1', className)}>
      <div className="flex items-center justify-between gap-1">
        <span className="px-1 text-sm font-semibold text-fg">{monthTitle(month, locale)}</span>
        <span className="flex items-center">
          <IconButton
            size="sm"
            label={t('ui.calendar.previousMonth')}
            onClick={() => onMonthChange(addMonths(month, -1))}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </IconButton>
          <IconButton
            size="sm"
            label={t('ui.calendar.nextMonth')}
            onClick={() => onMonthChange(addMonths(month, 1))}
          >
            <ChevronRight className="size-4" aria-hidden />
          </IconButton>
        </span>
      </div>
      <table ref={grid} aria-label={props['aria-label']} className="w-full table-fixed">
        <thead>
          <tr>
            {names.map((name, index) => (
              <th
                key={`${name}-${index}`}
                scope="col"
                className="py-0.5 text-center text-2xs font-normal text-fg-muted"
              >
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]}>
              {week.map((date) => {
                const mark = marks[date]
                const outside = date.slice(0, 7) !== month
                const dow = weekday(date)
                // Выходной: праздник, перенесённый выходной или суббота-воскресенье без отметки «рабочий»
                const holiday =
                  mark === 'holiday' ||
                  mark === 'weekend' ||
                  ((dow === 0 || dow === 6) && mark !== 'work')
                const selected = date === value
                const tabbable = date === (focused.slice(0, 7) === month ? focused : `${month}-01`)
                return (
                  <td key={date} className="p-0 text-center">
                    <button
                      type="button"
                      data-date={date}
                      tabIndex={tabbable ? 0 : -1}
                      aria-label={dayLabel(date, locale)}
                      aria-current={date === today ? 'date' : undefined}
                      aria-pressed={selected}
                      onClick={() => {
                        setFocused(date)
                        onSelect(date)
                      }}
                      onKeyDown={(event) => onKey(event, date)}
                      className={cn(
                        'tabular relative mx-auto flex size-7 items-center justify-center rounded-full text-xs',
                        'transition-colors duration-[var(--duration-fast)] hover:bg-surface-3',
                        inRange(date) && !selected && 'bg-accent-subtle',
                        outside ? 'text-fg-muted' : holiday ? 'text-danger' : 'text-fg',
                        date === today && 'font-semibold ring-1 ring-accent',
                        selected && 'bg-accent text-accent-fg hover:bg-accent-hover',
                      )}
                    >
                      {Number(date.slice(8))}
                      {busy?.has(date) && !selected ? (
                        <span
                          aria-hidden
                          className="absolute bottom-0.5 size-1 rounded-full bg-fg-muted"
                        />
                      ) : null}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
