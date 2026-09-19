import type { CalendarProjectionItem, CalendarRangeItem } from '@kchs/contracts'
import {
  Badge,
  type CalendarTone,
  cn,
  EmptyState,
  MonthGrid,
  type MonthGridItem,
  TimeGrid,
  type TimeGridAllDayItem,
  type TimeGridEvent,
  toneClasses,
} from '@kchs/ui'
import { CalendarDays, CheckSquare, Lock, Repeat, Video } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { useT } from '~/app/i18n.js'
import type { DayInfo } from './business-days.js'
import type { EventDraft } from './calendar-store.js'
import { type CalendarFormat, useCalendarFormat } from './format.js'
import { daysOfItem, placeAllDay, placeTimed, projectionsByDay, variantOf } from './model.js'
import { addDays, clockText, daysBetween, instantAt, wallOf } from './time.js'

/** Новое время события после переноса мышью или клавиатурой. */
export type TimeChange =
  | { allDay: false; start: number; end: number }
  | { allDay: true; startDate: string; endDate: string }

export interface ViewHandlers {
  onOpenItem: (item: CalendarRangeItem, anchor: HTMLElement) => void
  onOpenProjection: (item: CalendarProjectionItem, anchor: HTMLElement) => void
  onCreate: (draft: EventDraft) => void
  onMove: (item: CalendarRangeItem, change: TimeChange) => void
  /** Переход к дню (заголовок колонки, «ещё N»). */
  onDayClick: (day: string) => void
}

interface ViewProps {
  days: string[]
  items: CalendarRangeItem[]
  projections: CalendarProjectionItem[]
  today: string
  dayInfo: (day: string) => DayInfo
  handlers: ViewHandlers
}

type Translate = ReturnType<typeof useT>

const PROJECTION_PREFIX = 'projection:'

export function titleOf(item: CalendarRangeItem, t: Translate): string {
  return item.busy ? t('calendar.busy') : item.title || t('calendar.event.untitled')
}

function toneOf(item: CalendarRangeItem): CalendarTone {
  return item.busy ? 'slate' : item.color
}

/** Подпись для скринридера: название, время, мой ответ. */
export function labelOf(item: CalendarRangeItem, t: Translate, format: CalendarFormat): string {
  const parts = [titleOf(item, t), format.when(item)]
  if (item.location && !item.busy) parts.push(item.location)
  if (item.invitation && item.myStatus) parts.push(t(`calendar.status.${item.myStatus}`))
  if (item.recurring) parts.push(t('calendar.event.recurring'))
  return parts.join(', ')
}

function iconOf(item: CalendarRangeItem): ReactNode {
  if (item.busy) return <Lock className="size-3 shrink-0" aria-hidden />
  if (item.hasMeeting) return <Video className="size-3 shrink-0" aria-hidden />
  if (item.recurring) return <Repeat className="size-3 shrink-0" aria-hidden />
  return null
}

function projectionTitle(item: CalendarProjectionItem, format: CalendarFormat): string {
  return item.at ? `${format.time(Date.parse(item.at))} ${item.title}` : item.title
}

function projectionLabel(
  item: CalendarProjectionItem,
  t: Translate,
  format: CalendarFormat,
): string {
  return [
    t('calendar.projection.due', { title: item.title }),
    format.dayTitle(item.date),
    item.overdue ? t('common.time.overdue') : null,
  ]
    .filter(Boolean)
    .join(', ')
}

function projectionTone(item: CalendarProjectionItem): CalendarTone {
  if (item.done) return 'slate'
  return item.overdue ? 'red' : 'gold'
}

/**
 * День и неделя: сетка времени с событиями по поясу пользователя, полоса
 * событий на весь день и сроков (проекции), выходные и праздники приглушены.
 */
export function TimeView({
  days,
  items,
  projections,
  today,
  dayInfo,
  handlers,
  now,
  workingHours,
  defaultDuration,
}: ViewProps & {
  now: number
  workingHours: { start: number; end: number }
  defaultDuration: number
}) {
  const t = useT()
  const format = useCalendarFormat()
  const tz = format.timezone
  const placements = useMemo(() => placeTimed(items, days, tz), [items, days, tz])
  const allDayPlacements = useMemo(() => placeAllDay(items, days), [items, days])
  const timedByKey = new Map(placements.map((placement) => [placement.key, placement]))
  const allDayByKey = new Map(allDayPlacements.map((placement) => [placement.key, placement]))
  const projectionByKey = new Map(
    projections.map((item) => [`${PROJECTION_PREFIX}${item.key}`, item]),
  )

  const events: TimeGridEvent[] = placements.map((placement) => {
    const { item } = placement
    const start = Date.parse(item.startsAt)
    const end = Date.parse(item.endsAt)
    return {
      key: placement.key,
      day: placement.day,
      start: placement.start,
      end: placement.end,
      title: titleOf(item, t),
      meta:
        item.location && !item.busy
          ? `${format.timeRange(start, end)} · ${item.location}`
          : format.timeRange(start, end),
      tone: toneOf(item),
      variant: variantOf(item),
      editable: item.canEdit && !placement.partial && !item.busy && Boolean(item.eventId),
      label: labelOf(item, t, format),
      icon: iconOf(item),
    }
  })

  const allDay: TimeGridAllDayItem[] = [
    ...allDayPlacements.map((placement) => ({
      key: placement.key,
      first: placement.first,
      last: placement.last,
      title: titleOf(placement.item, t),
      tone: toneOf(placement.item),
      variant: variantOf(placement.item),
      label: labelOf(placement.item, t, format),
      icon: iconOf(placement.item),
    })),
    ...projections.flatMap((item) => {
      const index = days.indexOf(item.date)
      if (index < 0) return []
      return [
        {
          key: `${PROJECTION_PREFIX}${item.key}`,
          first: index,
          last: index,
          title: projectionTitle(item, format),
          tone: projectionTone(item),
          variant: item.done ? ('declined' as const) : ('free' as const),
          label: projectionLabel(item, t, format),
          icon: <CheckSquare className="size-3 shrink-0" aria-hidden />,
        },
      ]
    }),
  ]

  const todayIndex = days.indexOf(today)
  const nowMark = todayIndex >= 0 ? { day: todayIndex, minute: wallOf(now, tz).minute } : null
  const dayAt = (index: number) => days[index] ?? days[0] ?? today

  return (
    <TimeGrid
      aria-label={t('calendar.views.gridLabel', {
        range: format.rangeTitle(days.length === 1 ? 'day' : 'week', days, dayAt(0)),
      })}
      days={days.map((key) => {
        const info = dayInfo(key)
        return {
          key,
          label: `${format.weekday(key)} ${Number(key.slice(8))}`,
          ariaLabel: format.dayTitle(key),
          today: key === today,
          muted: info.muted,
          note: info.note,
        }
      })}
      events={events}
      allDay={allDay}
      hourHeight={48}
      snap={15}
      clickDuration={defaultDuration}
      workingHours={workingHours}
      now={nowMark}
      initialScrollMinute={Math.max(0, workingHours.start - 60)}
      formatMinute={clockText}
      onCreate={(range) =>
        handlers.onCreate({
          start: instantAt(dayAt(range.day), range.start, tz),
          end: instantAt(dayAt(range.day), range.end, tz),
        })
      }
      onCreateAllDay={(day) => handlers.onCreate({ allDay: true, date: dayAt(day) })}
      onChange={(key, next) => {
        const placement = timedByKey.get(key)
        if (!placement) return
        handlers.onMove(placement.item, {
          allDay: false,
          start: instantAt(dayAt(next.day), next.start, tz),
          end: instantAt(dayAt(next.day), next.end, tz),
        })
      }}
      onOpen={(key, anchor) => {
        const placement = timedByKey.get(key)
        if (placement) handlers.onOpenItem(placement.item, anchor)
      }}
      onOpenAllDay={(key, anchor) => {
        const projection = projectionByKey.get(key)
        if (projection) {
          handlers.onOpenProjection(projection, anchor)
          return
        }
        const placement = allDayByKey.get(key)
        if (placement) handlers.onOpenItem(placement.item, anchor)
      }}
      onDayClick={days.length > 1 ? (index) => handlers.onDayClick(dayAt(index)) : undefined}
    />
  )
}

/** Месяц: шесть недель, события дня строками, сроки — плашками. */
export function MonthView({
  days,
  anchor,
  items,
  projections,
  today,
  dayInfo,
  handlers,
}: ViewProps & { anchor: string }) {
  const t = useT()
  const format = useCalendarFormat()
  const tz = format.timezone
  const month = anchor.slice(0, 7)

  const { entries, itemByKey, projectionByKey } = useMemo(() => {
    const visible = new Set(days)
    const entries: MonthGridItem[] = []
    const itemByKey = new Map<string, CalendarRangeItem>()
    const projectionByKey = new Map<string, CalendarProjectionItem>()
    for (const item of items) {
      const itemDays = daysOfItem(item, tz)
      for (const [index, day] of itemDays.entries()) {
        if (!visible.has(day)) continue
        const key = `${item.key}@${day}`
        itemByKey.set(key, item)
        entries.push({
          key,
          day,
          title: titleOf(item, t),
          ...(item.allDay || index > 0 ? {} : { time: format.time(Date.parse(item.startsAt)) }),
          tone: toneOf(item),
          variant: variantOf(item),
          allDay: item.allDay || itemDays.length > 1,
          movable:
            item.canEdit &&
            !item.busy &&
            Boolean(item.eventId) &&
            (item.allDay || itemDays.length === 1),
          label: labelOf(item, t, format),
          icon: iconOf(item),
        })
      }
    }
    for (const item of projections) {
      if (!visible.has(item.date)) continue
      const key = `${PROJECTION_PREFIX}${item.key}`
      projectionByKey.set(key, item)
      entries.push({
        key,
        day: item.date,
        title: projectionTitle(item, format),
        tone: projectionTone(item),
        variant: item.done ? 'declined' : 'free',
        allDay: true,
        label: projectionLabel(item, t, format),
        icon: <CheckSquare className="size-3 shrink-0" aria-hidden />,
      })
    }
    return { entries, itemByKey, projectionByKey }
  }, [days, items, projections, tz, t, format])

  const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, week) =>
    days.slice(week * 7, week * 7 + 7).map((key) => {
      const info = dayInfo(key)
      return {
        key,
        label: Number(key.slice(8)),
        ariaLabel: format.dayTitle(key),
        outside: key.slice(0, 7) !== month,
        today: key === today,
        muted: info.muted,
        note: info.note,
      }
    }),
  )

  return (
    <MonthGrid
      aria-label={t('calendar.views.gridLabel', {
        range: format.rangeTitle('month', days, anchor),
      })}
      weeks={weeks}
      weekdays={days.slice(0, 7).map((day) => format.weekday(day))}
      items={entries}
      onOpen={(key, element) => {
        const projection = projectionByKey.get(key)
        if (projection) {
          handlers.onOpenProjection(projection, element)
          return
        }
        const item = itemByKey.get(key)
        if (item) handlers.onOpenItem(item, element)
      }}
      onCreate={(day) => handlers.onCreate({ allDay: true, date: day })}
      onMore={(day) => handlers.onDayClick(day)}
      onMove={(key, day) => {
        const item = itemByKey.get(key)
        if (!item) return
        const from = key.slice(key.lastIndexOf('@') + 1)
        const shift = daysBetween(from, day)
        if (shift === 0) return
        if (item.allDay && item.startDate) {
          handlers.onMove(item, {
            allDay: true,
            startDate: addDays(item.startDate, shift),
            endDate: addDays(item.endDate ?? item.startDate, shift),
          })
          return
        }
        const start = Date.parse(item.startsAt)
        const wall = wallOf(start, tz)
        const next = instantAt(addDays(wall.date, shift), wall.minute, tz)
        handlers.onMove(item, {
          allDay: false,
          start: next,
          end: next + (Date.parse(item.endsAt) - start),
        })
      }}
    />
  )
}

/** Повестка: дни со встречами и сроками списком — удобно на узком экране. */
export function AgendaView({ days, items, projections, today, dayInfo, handlers }: ViewProps) {
  const t = useT()
  const format = useCalendarFormat()
  const tz = format.timezone
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarRangeItem[]>()
    for (const item of items) {
      for (const day of daysOfItem(item, tz)) {
        const list = map.get(day) ?? []
        list.push(item)
        map.set(day, list)
      }
    }
    return map
  }, [items, tz])
  const projectionDays = useMemo(() => projectionsByDay(projections), [projections])
  const groups = days
    .map((day) => ({
      day,
      items: (byDay.get(day) ?? []).sort(
        (a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt.localeCompare(b.startsAt),
      ),
      projections: projectionDays.get(day) ?? [],
    }))
    .filter((group) => group.items.length > 0 || group.projections.length > 0)

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<CalendarDays />}
        title={t('calendar.views.agendaEmpty')}
        description={t('calendar.views.agendaEmptyHint')}
      />
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="mx-auto flex max-w-[860px] flex-col px-4 py-3">
        {groups.map((group) => {
          const info = dayInfo(group.day)
          return (
            <section
              key={group.day}
              aria-label={format.dayTitle(group.day)}
              className="flex gap-4 border-b border-line py-3 last:border-b-0"
            >
              <button
                type="button"
                onClick={() => handlers.onDayClick(group.day)}
                className="flex w-24 shrink-0 flex-col items-start rounded-sm px-1 text-left hover:bg-surface-3"
              >
                <span
                  className={cn(
                    'tabular text-xl font-semibold',
                    group.day === today ? 'text-accent' : info.muted ? 'text-fg-muted' : 'text-fg',
                  )}
                >
                  {Number(group.day.slice(8))}
                </span>
                <span className="text-xs text-fg-muted">{format.weekday(group.day)}</span>
                {info.note ? <span className="text-2xs text-danger">{info.note}</span> : null}
              </button>
              <ul className="flex min-w-0 flex-1 flex-col gap-0.5">
                {group.items.map((item) => (
                  <li key={`${item.key}@${group.day}`}>
                    <button
                      type="button"
                      aria-label={labelOf(item, t, format)}
                      onClick={(event) => handlers.onOpenItem(item, event.currentTarget)}
                      className="flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left hover:bg-surface-3"
                    >
                      <span className="tabular w-28 shrink-0 text-sm text-fg-secondary">
                        {item.allDay
                          ? t('calendar.event.allDay')
                          : format.timeRange(Date.parse(item.startsAt), Date.parse(item.endsAt))}
                      </span>
                      <span
                        aria-hidden
                        className={cn(
                          'size-2.5 shrink-0 rounded-full',
                          item.busy ? 'bg-fg-muted' : toneClasses(item.color).dot,
                        )}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span
                          className={cn(
                            'flex items-center gap-1.5 truncate text-sm',
                            item.myStatus === 'declined' ? 'text-fg-muted line-through' : 'text-fg',
                          )}
                        >
                          {iconOf(item)}
                          <span className="truncate">{titleOf(item, t)}</span>
                        </span>
                        {item.location && !item.busy ? (
                          <span className="truncate text-xs text-fg-muted">{item.location}</span>
                        ) : null}
                      </span>
                      {item.invitation && item.myStatus === 'needs_action' ? (
                        <Badge size="sm" tone="accent">
                          {t('calendar.status.needs_action')}
                        </Badge>
                      ) : item.invitation && item.myStatus === 'tentative' ? (
                        <Badge size="sm" tone="warning">
                          {t('calendar.status.tentative')}
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                ))}
                {group.projections.map((item) => (
                  <li key={item.key}>
                    <button
                      type="button"
                      aria-label={projectionLabel(item, t, format)}
                      onClick={(event) => handlers.onOpenProjection(item, event.currentTarget)}
                      className="flex w-full items-center gap-3 rounded-sm px-2 py-1.5 text-left hover:bg-surface-3"
                    >
                      <span className="tabular w-28 shrink-0 text-sm text-fg-secondary">
                        {item.at
                          ? format.time(Date.parse(item.at))
                          : t('calendar.projection.dueShort')}
                      </span>
                      <CheckSquare
                        aria-hidden
                        className={cn(
                          'size-3.5 shrink-0',
                          item.overdue && !item.done ? 'text-danger' : 'text-fg-muted',
                        )}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span
                          className={cn(
                            'truncate text-sm',
                            item.done ? 'text-fg-muted line-through' : 'text-fg',
                          )}
                        >
                          {item.title}
                        </span>
                        {item.subtitle ? (
                          <span className="truncate text-xs text-fg-muted">{item.subtitle}</span>
                        ) : null}
                      </span>
                      {item.overdue && !item.done ? (
                        <Badge size="sm" tone="danger">
                          {t('common.time.overdue')}
                        </Badge>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
