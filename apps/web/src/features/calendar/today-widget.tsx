import type { CalendarProjectionItem, CalendarRangeItem } from '@kchs/contracts'
import { Badge, Button, Card, cn, EmptyState, Skeleton, toneClasses } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, CalendarDays, CheckSquare, Lock } from 'lucide-react'
import { Fragment } from 'react'
import { useT } from '~/shared/i18n.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { useCalendarFormat } from './format.js'
import { todayQuery } from './queries.js'
import { MINUTE_MS } from './time.js'
import { useNow } from './use-now.js'

/** Строка ленты дня: встреча или срок; `at` — время, `null` — весь день или без часа. */
type Entry =
  | { key: string; at: number | null; kind: 'event'; item: CalendarRangeItem }
  | { key: string; at: number | null; kind: 'projection'; item: CalendarProjectionItem }

/**
 * Лента дня: сначала то, что без часа (весь день, сроки без времени), затем по времени.
 * Линия «сейчас» встаёт перед первым, что ещё не началось.
 */
function timeline(
  items: readonly CalendarRangeItem[],
  projections: readonly CalendarProjectionItem[],
): Entry[] {
  const entries: Entry[] = [
    ...items.map((item) => ({
      key: item.key,
      at: item.allDay ? null : Date.parse(item.startsAt),
      kind: 'event' as const,
      item,
    })),
    ...projections.map((item) => ({
      key: item.key,
      at: item.at ? Date.parse(item.at) : null,
      kind: 'projection' as const,
      item,
    })),
  ]
  return entries.sort((a, b) => (a.at ?? -1) - (b.at ?? -1))
}

/**
 * «Сегодня» на «Мой день» (12-calendar-notifications-home.md §4; облик — ADR-0230):
 * лента дня с линией «сейчас» — прошедшее приглушено, идущая встреча выделена, у
 * ближайшей — «через N мин»; сроки задач и поручений на сегодня — на той же ленте.
 */
export function TodayWidget() {
  const t = useT()
  const format = useCalendarFormat()
  const now = useNow()
  const openTab = useWorkspace((s) => s.openTab)
  const setNavigatorModule = useWorkspace((s) => s.setNavigatorModule)
  const { data, isLoading } = useQuery(todayQuery())
  const entries = timeline(data?.items ?? [], data?.projections ?? [])
  const next = entries.find(
    (entry) => entry.kind === 'event' && entry.at !== null && entry.at > now,
  )
  const nowIndex = entries.findIndex((entry) => entry.at !== null && entry.at > now)
  const timed = entries.some((entry) => entry.at !== null)

  const openCalendar = () => {
    setNavigatorModule('calendar')
    openTab({
      kind: 'screen',
      screen: 'calendar',
      title: t('shell.rail.calendar'),
      icon: 'calendar',
      mode: 'permanent',
    })
  }

  const nowLine = (
    <li aria-hidden className="flex items-center gap-3 py-1">
      <span className="tabular w-12 shrink-0 font-mono text-xs font-semibold text-danger">
        {format.time(now)}
      </span>
      <span className="relative flex w-3 shrink-0 justify-center">
        <span className="size-1.5 rounded-full bg-danger" />
      </span>
      <span className="h-px flex-1 bg-danger" />
    </li>
  )

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <CalendarDays className="size-4 text-fg-muted" aria-hidden />
          {t('home.widgets.today')}
        </span>
      }
      action={
        <Button
          variant="link"
          size="sm"
          iconRight={<ArrowRight className="size-3.5" />}
          onClick={openCalendar}
        >
          {t('calendar.today.open')}
        </Button>
      }
      padded={false}
    >
      {isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState compact icon={<CalendarDays />} title={t('home.emptyToday')} />
      ) : (
        <ol className="px-4 py-2">
          {entries.map((entry, index) => {
            const marker = timed && index === nowIndex ? nowLine : null
            if (entry.kind === 'projection') {
              const item = entry.item
              return (
                <Fragment key={entry.key}>
                  {marker}
                  <li className="flex gap-3">
                    <span className="tabular w-12 shrink-0 py-2 font-mono text-xs text-fg-secondary">
                      {entry.at !== null
                        ? format.time(entry.at)
                        : t('calendar.projection.dueShort')}
                    </span>
                    <Rail tone={item.done ? 'done' : item.overdue ? 'overdue' : 'future'} />
                    <button
                      type="button"
                      onClick={() =>
                        openTab({
                          kind: 'object',
                          objectId: item.objectId,
                          objectType: item.objectType,
                          title: item.title,
                          mode: 'permanent',
                        })
                      }
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-2"
                    >
                      <CheckSquare
                        aria-hidden
                        className={cn(
                          'size-3.5 shrink-0',
                          item.overdue && !item.done ? 'text-danger' : 'text-fg-muted',
                        )}
                      />
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-sm',
                          item.done ? 'text-fg-muted line-through' : 'text-fg',
                        )}
                      >
                        {item.title}
                      </span>
                    </button>
                  </li>
                </Fragment>
              )
            }
            const item = entry.item
            const start = Date.parse(item.startsAt)
            const end = Date.parse(item.endsAt)
            const past = !item.allDay && end <= now
            const current = !item.allDay && start <= now && end > now
            const soon = entry === next ? Math.ceil((start - now) / MINUTE_MS) : null
            return (
              <Fragment key={entry.key}>
                {marker}
                <li className={cn('flex gap-3', past && 'opacity-60')}>
                  <span
                    className={cn(
                      'tabular w-12 shrink-0 py-2 font-mono text-xs',
                      current ? 'font-semibold text-fg' : 'text-fg-secondary',
                    )}
                  >
                    {item.allDay ? t('calendar.event.allDay') : format.time(start)}
                  </span>
                  <Rail tone={past ? 'done' : current ? 'current' : 'future'} />
                  <button
                    type="button"
                    disabled={!item.eventId}
                    onClick={() =>
                      item.eventId &&
                      openTab({
                        kind: 'object',
                        objectId: item.eventId,
                        objectType: 'event',
                        title: item.title ?? t('calendar.busy'),
                        mode: 'permanent',
                      })
                    }
                    className={cn(
                      'flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-2 text-left disabled:cursor-default',
                      current ? 'bg-accent-subtle' : 'hover:bg-surface-2',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        item.busy ? 'bg-fg-muted' : toneClasses(item.color).dot,
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'flex items-center gap-1 truncate text-sm font-medium',
                          item.myStatus === 'declined' ? 'text-fg-muted line-through' : 'text-fg',
                        )}
                      >
                        {item.busy ? <Lock className="size-3 shrink-0" aria-hidden /> : null}
                        <span className="truncate">
                          {item.busy ? t('calendar.busy') : item.title}
                        </span>
                      </span>
                      <span className="block truncate text-xs text-fg-muted">
                        {[
                          item.allDay ? null : format.timeRange(start, end),
                          item.busy ? null : item.location,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    {current ? (
                      <Badge size="sm" tone="success">
                        {t('calendar.today.now')}
                      </Badge>
                    ) : soon !== null && soon <= 120 ? (
                      <Badge size="sm" tone="accent">
                        {t('calendar.today.startsIn', { count: soon })}
                      </Badge>
                    ) : item.invitation && item.myStatus === 'needs_action' ? (
                      <Badge size="sm" tone="warning">
                        {t('calendar.status.needs_action')}
                      </Badge>
                    ) : null}
                  </button>
                </li>
              </Fragment>
            )
          })}
          {timed && nowIndex === -1 ? nowLine : null}
        </ol>
      )}
    </Card>
  )
}

// Полные строки классов: Tailwind собирает только то, что видит целиком
const RAIL_DOT = {
  done: 'bg-fg-muted',
  current: 'bg-accent ring-2 ring-accent-subtle',
  future: 'border border-line-strong bg-surface',
  overdue: 'bg-danger',
} as const

/** Отметка на оси ленты: точка состояния и линия к соседям. */
function Rail({ tone }: { tone: keyof typeof RAIL_DOT }) {
  return (
    <span aria-hidden className="relative flex w-3 shrink-0 justify-center">
      <span className="absolute inset-y-0 w-px bg-line" />
      <span className={cn('relative mt-3 size-2 rounded-full', RAIL_DOT[tone])} />
    </span>
  )
}
