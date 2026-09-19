import { type DragEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { useUiT } from '../../i18n/ui-locale.js'
import { cn } from '../../lib/cn.js'
import { type CalendarItemVariant, type CalendarTone, itemClasses, toneClasses } from './tones.js'

export interface MonthGridDay {
  /** Ключ дня (`ГГГГ-ММ-ДД`). */
  key: string
  /** Число месяца. */
  label: ReactNode
  ariaLabel: string
  /** День другого месяца — приглушён. */
  outside?: boolean
  today?: boolean
  muted?: boolean
  note?: string | null
}

export interface MonthGridItem {
  key: string
  /** Ключ дня, в котором показано событие. */
  day: string
  title: ReactNode
  /** Время начала («10:00»); у событий на весь день — нет. */
  time?: ReactNode
  tone: CalendarTone
  variant?: CalendarItemVariant
  /** На весь день — плашкой, иначе — точкой и временем. */
  allDay?: boolean
  /** Можно перенести на другой день. */
  movable?: boolean
  label: string
  icon?: ReactNode
}

export interface MonthGridProps {
  /** Недели по семь дней. */
  weeks: MonthGridDay[][]
  /** Подписи дней недели. */
  weekdays: string[]
  items: MonthGridItem[]
  /**
   * Не больше стольких событий в ячейке. По умолчанию — сколько помещается по
   * высоте недели; остальные — «ещё N».
   */
  maxPerDay?: number
  onOpen?: (key: string, anchor: HTMLElement) => void
  onCreate?: (day: string) => void
  onMore?: (day: string) => void
  onMove?: (key: string, day: string) => void
  'aria-label': string
  className?: string
}

/** Высота строки события (цель нажатия 24 px, WCAG 2.5.8) и зазор, rem (`h-6`, `gap-0.5`). */
const ITEM_REM = 1.5 + 0.125
/** Отступы ячейки и строка с числом, rem (`p-1`, `h-5`). */
const CELL_REM = 0.5 + 1.25
const FALLBACK_CAPACITY = 3

/**
 * Месяц календаря: недели строками, события дня — плашками (на весь день) и
 * строками с точкой цвета календаря; «ещё N» — переход к дню. Сколько событий
 * видно в ячейке, зависит от её высоты. Двойной щелчок по дню — новое событие;
 * перенос события на другой день — перетаскиванием (с клавиатуры — правкой
 * события, создание — кнопкой «Создать» экрана).
 */
export function MonthGrid({
  weeks,
  weekdays,
  items,
  maxPerDay,
  onOpen,
  onCreate,
  onMore,
  onMove,
  className,
  ...props
}: MonthGridProps) {
  const t = useUiT()
  const [over, setOver] = useState<string | null>(null)
  const [fit, setFit] = useState<number | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const weekCount = Math.max(1, weeks.length)

  // Вместимость ячейки — по высоте строки недели
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      const row = body.clientHeight / weekCount
      setFit(Math.max(1, Math.floor((row - CELL_REM * rem) / (ITEM_REM * rem))))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [weekCount])

  const capacity = Math.min(maxPerDay ?? Number.POSITIVE_INFINITY, fit ?? FALLBACK_CAPACITY)
  const byDay = new Map<string, MonthGridItem[]>()
  for (const item of items) {
    const list = byDay.get(item.day) ?? []
    list.push(item)
    byDay.set(item.day, list)
  }

  const drop = (event: DragEvent<HTMLElement>, day: string) => {
    event.preventDefault()
    setOver(null)
    const key = event.dataTransfer.getData('text/x-kchs-event')
    if (key) onMove?.(key, day)
  }

  return (
    <section
      aria-label={props['aria-label']}
      className={cn('flex h-full min-h-0 flex-col bg-surface', className)}
    >
      <div aria-hidden className="grid shrink-0 grid-cols-7 border-b border-line">
        {weekdays.map((name, index) => (
          <div
            key={`${name}-${index}`}
            className="border-l border-line px-2 py-1.5 text-xs font-medium text-fg-muted"
          >
            {name}
          </div>
        ))}
      </div>
      <div
        ref={bodyRef}
        className="grid min-h-0 flex-1"
        style={{ gridTemplateRows: `repeat(${weekCount}, minmax(0, 1fr))` }}
      >
        {weeks.map((week) => (
          <div key={week[0]?.key} className="grid min-h-0 grid-cols-7 border-b border-line">
            {week.map((day) => {
              const list = (byDay.get(day.key) ?? []).sort(
                (a, b) => Number(Boolean(b.allDay)) - Number(Boolean(a.allDay)),
              )
              // Строка «ещё N» занимает место одного события
              const visible =
                list.length > capacity ? list.slice(0, Math.max(0, capacity - 1)) : list
              const hidden = list.length - visible.length
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: двойной щелчок и сброс перетаскиванием дублируются кнопкой «Создать» и правкой события
                <div
                  key={day.key}
                  onDoubleClick={(event) => {
                    if (event.target === event.currentTarget) onCreate?.(day.key)
                  }}
                  onDragOver={(event) => {
                    if (!onMove) return
                    event.preventDefault()
                    setOver(day.key)
                  }}
                  onDragLeave={() => setOver((current) => (current === day.key ? null : current))}
                  onDrop={(event) => drop(event, day.key)}
                  className={cn(
                    'flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-l border-line p-1',
                    (day.muted || day.outside) && 'bg-surface-2',
                    over === day.key && 'bg-accent-subtle',
                  )}
                >
                  <span className="flex h-5 shrink-0 items-center gap-1">
                    <span
                      aria-hidden
                      className={cn(
                        'tabular inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs',
                        day.today
                          ? 'bg-accent font-semibold text-accent-fg'
                          : day.outside
                            ? 'text-fg-muted'
                            : 'text-fg',
                      )}
                    >
                      {day.label}
                    </span>
                    <span className="sr-only">{day.ariaLabel}</span>
                    {day.note ? (
                      <span className="truncate text-2xs text-danger" title={day.note}>
                        {day.note}
                      </span>
                    ) : null}
                  </span>
                  {visible.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      aria-label={item.label}
                      draggable={Boolean(item.movable && onMove)}
                      onDragStart={(event) => {
                        event.dataTransfer.setData('text/x-kchs-event', item.key)
                        event.dataTransfer.effectAllowed = 'move'
                      }}
                      onClick={(event) => onOpen?.(item.key, event.currentTarget)}
                      className={cn(
                        'flex h-6 min-w-0 shrink-0 items-center gap-1 rounded-xs px-1 text-left text-xs',
                        item.allDay
                          ? itemClasses(item.tone, item.variant)
                          : cn(
                              'text-fg hover:bg-surface-3',
                              item.variant === 'declined' && 'text-fg-muted line-through',
                              item.variant === 'busy' && 'text-fg-secondary',
                            ),
                      )}
                    >
                      {item.allDay ? null : (
                        <span
                          aria-hidden
                          className={cn(
                            'size-1.5 shrink-0 rounded-full',
                            item.variant === 'busy' ? 'bg-fg-muted' : toneClasses(item.tone).dot,
                          )}
                        />
                      )}
                      {item.time ? (
                        <span className="tabular shrink-0 text-fg-muted">{item.time}</span>
                      ) : null}
                      {item.icon}
                      <span className="truncate">{item.title}</span>
                    </button>
                  ))}
                  {hidden > 0 ? (
                    <button
                      type="button"
                      onClick={() => onMore?.(day.key)}
                      aria-label={`${day.ariaLabel}: ${t('ui.calendar.more', { count: hidden })}`}
                      className="h-6 shrink-0 self-start rounded-xs px-1 text-xs text-fg-secondary hover:bg-surface-3"
                    >
                      {t('ui.calendar.more', { count: hidden })}
                    </button>
                  ) : null}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </section>
  )
}
