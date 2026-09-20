import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useUiT } from '../../i18n/ui-locale.js'
import { cn } from '../../lib/cn.js'
import { layoutLanes, layoutRows, snapMinutes } from './layout.js'
import { type CalendarItemVariant, type CalendarTone, itemClasses, toneClasses } from './tones.js'

const DAY_MINUTES = 24 * 60
/** Движение указателя меньше порога — щелчок, а не перетаскивание. */
const DRAG_THRESHOLD_PX = 4
/** Строка полосы «весь день»: плашка 24 px — минимальная цель нажатия (WCAG 2.5.8). */
const ALL_DAY_ROW_PX = 28
/** Сколько рядов «весь день» видно без раскрытия: иначе сетка уезжает вниз. */
const ALL_DAY_ROWS_VISIBLE = 3

export interface TimeGridDay {
  /** Ключ дня (`ГГГГ-ММ-ДД`). */
  key: string
  label: ReactNode
  /** Подпись колонки для скринридера («понедельник, 21 сентября»). */
  ariaLabel: string
  today?: boolean
  /** Нерабочий день (выходной, праздник) — фон приглушён. */
  muted?: boolean
  /** Подпись дня: праздник, перенесённый выходной. */
  note?: string | null
}

export interface TimeGridEvent {
  key: string
  /** Номер колонки дня. */
  day: number
  /** Минуты от начала дня; за пределами дня обрезаются. */
  start: number
  end: number
  title: ReactNode
  /** Время («10:00–11:00») и место — вторая строка. */
  meta?: ReactNode
  tone: CalendarTone
  variant?: CalendarItemVariant
  /** Можно переносить и растягивать. */
  editable?: boolean
  /** Текст для скринридера. */
  label: string
  /** Значок перед названием (повтор, встреча). */
  icon?: ReactNode
}

export interface TimeGridAllDayItem {
  key: string
  /** Первый и последний день (включительно). */
  first: number
  last: number
  title: ReactNode
  tone: CalendarTone
  variant?: CalendarItemVariant
  label: string
  icon?: ReactNode
}

export interface TimeGridRange {
  day: number
  start: number
  end: number
}

export interface TimeGridProps {
  days: TimeGridDay[]
  events: TimeGridEvent[]
  allDay?: TimeGridAllDayItem[]
  /** Высота часа, px. */
  hourHeight?: number
  /** Шаг привязки при перетаскивании, минуты. */
  snap?: number
  /** Длительность события, созданного щелчком, минуты. */
  clickDuration?: number
  /** Рабочие часы — вне их фон приглушён. */
  workingHours?: { start: number; end: number } | null
  /** Текущий момент — линия «сейчас». */
  now?: { day: number; minute: number } | null
  /** Прокрутка при открытии: к началу рабочего дня. */
  initialScrollMinute?: number
  onCreate?: (range: TimeGridRange) => void
  onCreateAllDay?: (day: number) => void
  onChange?: (key: string, next: TimeGridRange) => void
  onOpen?: (key: string, anchor: HTMLElement) => void
  onOpenAllDay?: (key: string, anchor: HTMLElement) => void
  onDayClick?: (day: number) => void
  /** Подпись минут («09:30»); по умолчанию — 24-часовой формат. */
  formatMinute?: (minute: number) => string
  'aria-label': string
  className?: string
}

type Drag =
  | {
      kind: 'create'
      day: number
      anchor: number
      current: number
      x: number
      y: number
      moved: boolean
    }
  | {
      kind: 'move'
      key: string
      day: number
      start: number
      duration: number
      offset: number
      x: number
      y: number
      moved: boolean
      element: HTMLElement
    }
  | {
      kind: 'resize'
      key: string
      day: number
      start: number
      end: number
      y: number
      moved: boolean
    }

const pad = (value: number) => String(value).padStart(2, '0')
const defaultFormat = (minute: number) =>
  `${pad(Math.floor(minute / 60) % 24)}:${pad(Math.round(minute % 60))}`

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * Сетка времени — день или неделя календаря (03-ui/03-screens.md §17):
 * колонки дней, шкала часов, события с цветом календаря, дорожки для
 * пересечений, полоса событий на весь день, линия «сейчас». Создание —
 * протягиванием по пустому месту (щелчок — событие на `clickDuration`),
 * перенос и растягивание — мышью или с клавиатуры: Alt+↑/↓ — на шаг,
 * Alt+←/→ — на день, Alt+Shift+↑/↓ — длительность.
 */
export function TimeGrid({
  days,
  events,
  allDay = [],
  hourHeight = 44,
  snap = 15,
  clickDuration = 60,
  workingHours = null,
  now = null,
  initialScrollMinute = 8 * 60,
  onCreate,
  onCreateAllDay,
  onChange,
  onOpen,
  onOpenAllDay,
  onDayClick,
  formatMinute = defaultFormat,
  className,
  ...props
}: TimeGridProps) {
  const t = useUiT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const columnsRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const count = Math.max(1, days.length)
  const height = 24 * hourHeight

  // Прокрутка — только при открытии: смена недели не сбрасывает положение
  // biome-ignore lint/correctness/useExhaustiveDependencies: намеренно один раз
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller) scroller.scrollTop = (initialScrollMinute / 60) * hourHeight
  }, [])

  // Esc отменяет перетаскивание
  useEffect(() => {
    if (!drag) return
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setDrag(null)
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [drag])

  const lanes = useMemo(() => {
    const result = new Map<string, { lane: number; lanes: number }>()
    for (let day = 0; day < count; day++) {
      const boxes = layoutLanes(
        events
          .filter((event) => event.day === day)
          .map((event) => ({
            key: event.key,
            start: clamp(event.start, 0, DAY_MINUTES),
            end: clamp(event.end, 0, DAY_MINUTES),
          })),
      )
      for (const [key, box] of boxes) result.set(key, box)
    }
    return result
  }, [events, count])

  // События на весь день обрезаются видом; целиком вне его — не показываются
  const visibleAllDay = useMemo(
    () =>
      allDay.flatMap((item) => {
        const first = Math.max(0, item.first)
        const last = Math.min(count - 1, item.last)
        return first > last ? [] : [{ ...item, first, last }]
      }),
    [allDay, count],
  )
  const rows = useMemo(
    () =>
      layoutRows(
        visibleAllDay.map((item) => ({ key: item.key, first: item.first, last: item.last })),
      ),
    [visibleAllDay],
  )
  const allDayRows = Math.max(1, ...[...rows.values()].map((row) => row + 1))
  const [allDayExpanded, setAllDayExpanded] = useState(false)
  // Сроков на день бывает много (проекции задач и документов): показываем
  // первые ряды, остальное — по кнопке, иначе сетка часов уходит с экрана
  const shownAllDayRows = allDayExpanded ? allDayRows : Math.min(allDayRows, ALL_DAY_ROWS_VISIBLE)
  const hiddenAllDay = visibleAllDay.filter(
    (item) => (rows.get(item.key) ?? 0) >= shownAllDayRows,
  ).length
  const allDayToggle = hiddenAllDay > 0 || allDayExpanded

  /** Колонка и минута под указателем. */
  const pointAt = (clientX: number, clientY: number) => {
    const rect = columnsRef.current?.getBoundingClientRect()
    if (!rect) return { day: 0, minute: 0 }
    const day = clamp(Math.floor(((clientX - rect.left) / rect.width) * count), 0, count - 1)
    const minute = clamp(((clientY - rect.top) / hourHeight) * 60, 0, DAY_MINUTES)
    return { day, minute }
  }

  const startCreate = (event: PointerEvent<HTMLDivElement>) => {
    if (!onCreate || event.button !== 0 || event.target !== event.currentTarget) return
    const { day, minute } = pointAt(event.clientX, event.clientY)
    const anchor = Math.floor(minute / snap) * snap
    if (event.pointerType !== 'touch') event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({
      kind: 'create',
      day,
      anchor,
      current: anchor,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    })
  }

  const startMove = (event: PointerEvent<HTMLElement>, item: TimeGridEvent) => {
    if (event.button !== 0) return
    event.stopPropagation()
    const { minute } = pointAt(event.clientX, event.clientY)
    const start = clamp(item.start, 0, DAY_MINUTES)
    if (item.editable && onChange && event.pointerType !== 'touch') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
    setDrag({
      kind: 'move',
      key: item.key,
      day: item.day,
      start,
      duration: Math.max(snap, item.end - item.start),
      offset: minute - start,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      element: event.currentTarget,
    })
  }

  const startResize = (event: PointerEvent<HTMLElement>, item: TimeGridEvent) => {
    if (event.button !== 0 || !onChange) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({
      kind: 'resize',
      key: item.key,
      day: item.day,
      start: clamp(item.start, 0, DAY_MINUTES),
      end: clamp(item.end, 0, DAY_MINUTES),
      y: event.clientY,
      moved: false,
    })
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag) return
    const { day, minute } = pointAt(event.clientX, event.clientY)
    const far = (x: number, y: number) =>
      Math.abs(event.clientX - x) > DRAG_THRESHOLD_PX ||
      Math.abs(event.clientY - y) > DRAG_THRESHOLD_PX
    if (drag.kind === 'create') {
      if (event.pointerType === 'touch') return
      setDrag({
        ...drag,
        current: snapMinutes(minute, snap),
        moved: drag.moved || far(drag.x, drag.y),
      })
      return
    }
    if (drag.kind === 'move') {
      const item = events.find((candidate) => candidate.key === drag.key)
      if (!item?.editable || !onChange || event.pointerType === 'touch') return
      const start = clamp(snapMinutes(minute - drag.offset, snap), 0, DAY_MINUTES - drag.duration)
      setDrag({ ...drag, day, start, moved: drag.moved || far(drag.x, drag.y) })
      return
    }
    const end = clamp(snapMinutes(minute, snap), drag.start + snap, DAY_MINUTES)
    setDrag({
      ...drag,
      end,
      moved: drag.moved || Math.abs(event.clientY - drag.y) > DRAG_THRESHOLD_PX,
    })
  }

  const onPointerUp = () => {
    if (!drag) return
    const current = drag
    setDrag(null)
    if (current.kind === 'create') {
      if (!onCreate) return
      if (!current.moved) {
        onCreate({
          day: current.day,
          start: current.anchor,
          end: Math.min(DAY_MINUTES, current.anchor + clickDuration),
        })
        return
      }
      const from = Math.min(current.anchor, current.current)
      const to = Math.max(current.anchor, current.current)
      onCreate({ day: current.day, start: from, end: Math.max(to, from + snap) })
      return
    }
    if (current.kind === 'move') {
      const item = events.find((candidate) => candidate.key === current.key)
      if (!current.moved || !item) {
        onOpen?.(current.key, current.element)
        return
      }
      if (current.day !== item.day || current.start !== clamp(item.start, 0, DAY_MINUTES)) {
        onChange?.(current.key, {
          day: current.day,
          start: current.start,
          end: current.start + current.duration,
        })
      }
      return
    }
    const item = events.find((candidate) => candidate.key === current.key)
    if (current.moved && item && current.end !== item.end) {
      onChange?.(current.key, { day: current.day, start: current.start, end: current.end })
    }
  }

  const onItemKey = (event: KeyboardEvent<HTMLElement>, item: TimeGridEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpen?.(item.key, event.currentTarget)
      return
    }
    if (!event.altKey || !item.editable || !onChange) return
    const start = clamp(item.start, 0, DAY_MINUTES)
    const end = clamp(item.end, 0, DAY_MINUTES)
    const next: TimeGridRange | null = (() => {
      switch (event.key) {
        case 'ArrowUp':
          return event.shiftKey
            ? { day: item.day, start, end: Math.max(start + snap, end - snap) }
            : { day: item.day, start: Math.max(0, start - snap), end: end - (start > 0 ? snap : 0) }
        case 'ArrowDown':
          return event.shiftKey
            ? { day: item.day, start, end: Math.min(DAY_MINUTES, end + snap) }
            : end + snap <= DAY_MINUTES
              ? { day: item.day, start: start + snap, end: end + snap }
              : null
        case 'ArrowLeft':
          return item.day > 0 ? { day: item.day - 1, start, end } : null
        case 'ArrowRight':
          return item.day < count - 1 ? { day: item.day + 1, start, end } : null
        default:
          return null
      }
    })()
    if (!next) return
    event.preventDefault()
    onChange(item.key, next)
  }

  const ghost = (() => {
    if (!drag) return null
    if (drag.kind === 'create') {
      if (!drag.moved) return null
      const from = Math.min(drag.anchor, drag.current)
      const to = Math.max(Math.max(drag.anchor, drag.current), from + snap)
      return { day: drag.day, start: from, end: to, tone: null as CalendarTone | null }
    }
    if (!drag.moved) return null
    const item = events.find((candidate) => candidate.key === drag.key)
    if (!item) return null
    return drag.kind === 'move'
      ? { day: drag.day, start: drag.start, end: drag.start + drag.duration, tone: item.tone }
      : { day: drag.day, start: drag.start, end: drag.end, tone: item.tone }
  })()

  const top = (minute: number) => (clamp(minute, 0, DAY_MINUTES) / 60) * hourHeight
  const columnWidth = 100 / count

  return (
    <section
      aria-label={props['aria-label']}
      className={cn('flex h-full min-h-0 flex-col bg-surface', className)}
    >
      {/* Заголовки дней */}
      <div className="flex shrink-0 border-b border-line">
        <div className="w-14 shrink-0" aria-hidden />
        <div
          className="grid flex-1"
          style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
        >
          {days.map((day, index) => (
            <div
              key={day.key}
              className={cn(
                'flex min-w-0 flex-col items-center gap-0.5 border-l border-line px-1 py-1.5',
                day.muted && 'bg-surface-2',
              )}
            >
              {onDayClick ? (
                <button
                  type="button"
                  onClick={() => onDayClick(index)}
                  aria-label={day.ariaLabel}
                  className={cn(
                    'rounded-sm px-1.5 text-sm font-medium hover:bg-surface-3',
                    day.today ? 'bg-accent text-accent-fg hover:bg-accent-hover' : 'text-fg',
                  )}
                >
                  {day.label}
                </button>
              ) : (
                <span
                  className={cn(
                    'rounded-sm px-1.5 text-sm font-medium',
                    day.today ? 'bg-accent text-accent-fg' : 'text-fg',
                  )}
                >
                  {day.label}
                </span>
              )}
              {day.note ? (
                <span className="max-w-full truncate text-2xs text-danger" title={day.note}>
                  {day.note}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {/* События на весь день */}
      <div className="flex shrink-0 border-b border-line">
        <div className="flex w-14 shrink-0 items-start justify-end px-1.5 pt-1 text-2xs text-fg-muted">
          {t('ui.calendar.allDay')}
        </div>
        <div
          className="relative flex-1"
          style={{ height: shownAllDayRows * ALL_DAY_ROW_PX + 4 + (allDayToggle ? 16 : 0) }}
        >
          <div
            className="absolute inset-0 grid"
            style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
          >
            {days.map((day, index) => (
              <button
                key={day.key}
                type="button"
                tabIndex={-1}
                aria-label={t('ui.calendar.createAllDay', { day: day.ariaLabel })}
                onDoubleClick={() => onCreateAllDay?.(index)}
                className={cn('border-l border-line', day.muted && 'bg-surface-2')}
              />
            ))}
          </div>
          {visibleAllDay.map((item) => {
            const row = rows.get(item.key) ?? 0
            if (row >= shownAllDayRows) return null
            return (
              <button
                key={item.key}
                type="button"
                aria-label={item.label}
                onClick={(event) => onOpenAllDay?.(item.key, event.currentTarget)}
                className={cn(
                  'absolute flex items-center gap-1 overflow-hidden rounded-xs px-1.5 text-left text-xs',
                  itemClasses(item.tone, item.variant),
                )}
                style={{
                  top: row * ALL_DAY_ROW_PX + 2,
                  height: ALL_DAY_ROW_PX - 4,
                  left: `calc(${item.first * columnWidth}% + 2px)`,
                  width: `calc(${(item.last - item.first + 1) * columnWidth}% - 4px)`,
                }}
              >
                {item.icon}
                <span className="truncate">{item.title}</span>
              </button>
            )
          })}
          {allDayToggle ? (
            <button
              type="button"
              className="absolute bottom-0 right-1 rounded-xs px-1.5 text-2xs text-fg-secondary hover:bg-surface-3"
              onClick={() => setAllDayExpanded((current) => !current)}
            >
              {allDayExpanded
                ? t('ui.calendar.allDayLess')
                : t('ui.calendar.allDayMore', { count: hiddenAllDay })}
            </button>
          ) : null}
        </div>
      </div>

      {/* Шкала времени */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="relative flex" style={{ height }}>
          <div className="relative w-14 shrink-0" aria-hidden>
            {Array.from({ length: 23 }, (_, index) => index + 1).map((hour) => (
              <span
                key={hour}
                className="tabular absolute right-1.5 -translate-y-1/2 text-2xs text-fg-muted"
                style={{ top: hour * hourHeight }}
              >
                {formatMinute(hour * 60)}
              </span>
            ))}
          </div>
          <div
            ref={columnsRef}
            className={cn('relative flex-1 select-none', drag ? 'cursor-grabbing' : 'cursor-cell')}
            onPointerDown={startCreate}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setDrag(null)}
          >
            {/* Фон: нерабочие часы и дни, часовые линии */}
            {days.map((day, index) => (
              <div
                key={day.key}
                aria-hidden
                className="pointer-events-none absolute inset-y-0 border-l border-line"
                style={{ left: `${index * columnWidth}%`, width: `${columnWidth}%` }}
              >
                {day.muted ? (
                  <div className="absolute inset-0 bg-surface-2" />
                ) : workingHours ? (
                  <>
                    <div
                      className="absolute inset-x-0 top-0 bg-surface-2"
                      style={{ height: top(workingHours.start) }}
                    />
                    <div
                      className="absolute inset-x-0 bottom-0 bg-surface-2"
                      style={{ top: top(workingHours.end) }}
                    />
                  </>
                ) : null}
              </div>
            ))}
            {Array.from({ length: 23 }, (_, index) => index + 1).map((hour) => (
              <div
                key={hour}
                aria-hidden
                className="pointer-events-none absolute inset-x-0 border-t border-line"
                style={{ top: hour * hourHeight }}
              />
            ))}

            {events.map((item) => {
              const box = lanes.get(item.key) ?? { lane: 0, lanes: 1 }
              const start = clamp(item.start, 0, DAY_MINUTES)
              const end = Math.max(clamp(item.end, 0, DAY_MINUTES), start + 15)
              const dragged = drag && drag.kind !== 'create' && drag.key === item.key && drag.moved
              const tall = ((end - start) / 60) * hourHeight >= 36
              return (
                <div
                  key={item.key}
                  className="absolute px-px"
                  style={{
                    top: top(start),
                    height: Math.max(((end - start) / 60) * hourHeight - 1, 14),
                    left: `${(item.day + box.lane / box.lanes) * columnWidth}%`,
                    width: `${columnWidth / box.lanes}%`,
                  }}
                >
                  <button
                    type="button"
                    aria-label={item.label}
                    onPointerDown={(event) => startMove(event, item)}
                    onKeyDown={(event) => onItemKey(event, item)}
                    className={cn(
                      'relative flex h-full w-full flex-col overflow-hidden rounded-xs px-1.5 py-0.5 text-left',
                      'text-xs leading-tight focus-visible:outline-2 focus-visible:outline-accent',
                      itemClasses(item.tone, item.variant),
                      item.editable && onChange ? 'cursor-grab' : 'cursor-pointer',
                      dragged && 'opacity-40',
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-1 font-medium">
                      {item.icon}
                      <span className="truncate">{item.title}</span>
                    </span>
                    {tall && item.meta ? (
                      <span className="truncate text-2xs text-fg-secondary">{item.meta}</span>
                    ) : null}
                    {item.editable && onChange ? (
                      <span
                        aria-hidden
                        onPointerDown={(event) => startResize(event, item)}
                        className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
                      />
                    ) : null}
                  </button>
                </div>
              )
            })}

            {ghost ? (
              <div
                aria-hidden
                className={cn(
                  'pointer-events-none absolute rounded-xs border-2 border-dashed px-1.5 py-0.5 text-2xs font-medium',
                  ghost.tone
                    ? `${toneClasses(ghost.tone).dashed} ${toneClasses(ghost.tone).fill} text-fg`
                    : 'border-accent bg-accent-subtle text-accent',
                )}
                style={{
                  top: top(ghost.start),
                  height: Math.max(((ghost.end - ghost.start) / 60) * hourHeight - 1, 14),
                  left: `calc(${ghost.day * columnWidth}% + 2px)`,
                  width: `calc(${columnWidth}% - 4px)`,
                }}
              >
                {formatMinute(ghost.start)}–{formatMinute(ghost.end)}
              </div>
            ) : null}

            {now && now.day >= 0 && now.day < count ? (
              <div
                aria-hidden
                className="pointer-events-none absolute h-0.5 bg-danger"
                style={{
                  top: top(now.minute),
                  left: `${now.day * columnWidth}%`,
                  width: `${columnWidth}%`,
                }}
              >
                <span className="absolute -left-1 -top-[3px] size-2 rounded-full bg-danger" />
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  )
}
