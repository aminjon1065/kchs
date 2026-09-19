import { Badge, Button, Card, cn, EmptyState, Skeleton, toneClasses } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, CalendarDays, CheckSquare, Lock } from 'lucide-react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { useCalendarFormat } from './format.js'
import { todayQuery } from './queries.js'
import { MINUTE_MS } from './time.js'
import { useNow } from './use-now.js'

/**
 * «Сегодня» на «Мой день» (12-calendar-notifications-home.md §4): встречи дня
 * по порядку — прошедшие приглушены, у ближайшей — «через N мин»; сроки задач
 * и поручений на сегодня.
 */
export function TodayWidget() {
  const t = useT()
  const format = useCalendarFormat()
  const now = useNow()
  const openTab = useWorkspace((s) => s.openTab)
  const setNavigatorModule = useWorkspace((s) => s.setNavigatorModule)
  const { data, isLoading } = useQuery(todayQuery())
  const items = [...(data?.items ?? [])].sort(
    (a, b) => Number(b.allDay) - Number(a.allDay) || a.startsAt.localeCompare(b.startsAt),
  )
  const projections = data?.projections ?? []
  const next = items.find((item) => !item.allDay && Date.parse(item.endsAt) > now)

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
      ) : items.length === 0 && projections.length === 0 ? (
        <EmptyState compact icon={<CalendarDays />} title={t('home.emptyToday')} />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => {
            const start = Date.parse(item.startsAt)
            const end = Date.parse(item.endsAt)
            const past = !item.allDay && end <= now
            const current = !item.allDay && start <= now && end > now
            const soon = item === next && !current ? Math.ceil((start - now) / MINUTE_MS) : null
            return (
              <li key={item.key}>
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
                    'flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-3 disabled:cursor-default',
                    past && 'opacity-60',
                  )}
                >
                  <span className="tabular w-24 shrink-0 text-xs text-fg-secondary">
                    {item.allDay ? t('calendar.event.allDay') : format.timeRange(start, end)}
                  </span>
                  <span
                    aria-hidden
                    className={cn(
                      'size-2 shrink-0 rounded-full',
                      item.busy ? 'bg-fg-muted' : toneClasses(item.color).dot,
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'flex items-center gap-1 truncate text-sm',
                        item.myStatus === 'declined' ? 'text-fg-muted line-through' : 'text-fg',
                      )}
                    >
                      {item.busy ? <Lock className="size-3 shrink-0" aria-hidden /> : null}
                      <span className="truncate">
                        {item.busy ? t('calendar.busy') : item.title}
                      </span>
                    </span>
                    {item.location && !item.busy ? (
                      <span className="block truncate text-xs text-fg-muted">{item.location}</span>
                    ) : null}
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
            )
          })}
          {projections.map((item) => (
            <li key={item.key}>
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
                className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-3"
              >
                <span className="tabular w-24 shrink-0 text-xs text-fg-secondary">
                  {item.at ? format.time(Date.parse(item.at)) : t('calendar.projection.dueShort')}
                </span>
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
          ))}
        </ul>
      )}
    </Card>
  )
}
