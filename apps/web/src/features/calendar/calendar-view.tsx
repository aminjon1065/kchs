import type { CalendarSettings } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import {
  Badge,
  Button,
  Card,
  cn,
  EmptyState,
  ErrorState,
  KeyValueList,
  NoAccessState,
  PanelToolbar,
  Skeleton,
  toneClasses,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Link2, Settings2, Share2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { ApiError, http } from '~/shared/api/client.js'
import { CalendarSettingsDialog, FeedDialog } from './calendar-dialogs.js'
import { calendarName } from './calendar-sidebar.js'
import { useCalendarFormat } from './format.js'
import { calendarKeys, calendarQuery, calendarSettingsQuery, rangeQuery } from './queries.js'
import { addDays, instantAt, todayIn } from './time.js'

/**
 * Календарь во вкладке (объект реестра): описание, ресурс или подписка,
 * ближайшие события; «Показать в моём календаре», настройки, доступ, ссылка ICS.
 */
export function CalendarView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const locale = useAppearance((s) => s.locale)
  const format = useCalendarFormat()
  const tz = format.timezone
  const openTab = useWorkspace((s) => s.openTab)
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const [dialog, setDialog] = useState<'settings' | 'share' | 'feed' | null>(null)
  const { data: calendar, isLoading, error, refetch } = useQuery(calendarQuery(objectId))
  const { data: settings } = useQuery(calendarSettingsQuery())
  const today = todayIn(tz)
  const { data: upcoming } = useQuery({
    ...rangeQuery({
      from: new Date(instantAt(today, 0, tz)).toISOString(),
      to: new Date(instantAt(addDays(today, 14), 0, tz)).toISOString(),
      calendarIds: [objectId],
      // Сроки других модулей здесь не нужны: несуществующий поставщик — ни одного
      projections: ['none'],
    }),
    enabled: Boolean(calendar),
  })

  useEffect(() => {
    if (calendar) setTabTitle(tabId, calendarName(calendar, t))
  }, [calendar, tabId, setTabTitle, t])

  const show = useMutation({
    mutationFn: () =>
      http.put<CalendarSettings>('/calendar/settings', {
        ...(calendar?.mine
          ? {}
          : { addedCalendarIds: [...new Set([...(settings?.addedCalendarIds ?? []), objectId])] }),
        shown: { ...(settings?.shown ?? {}), [objectId]: true },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: calendarKeys.all })
      void client.invalidateQueries({ queryKey: ['object', objectId] })
      openTab({
        kind: 'screen',
        screen: 'calendar',
        title: t('shell.rail.calendar'),
        icon: 'calendar',
        mode: 'permanent',
      })
    },
    onError: (failure) =>
      toast.error(failure instanceof ApiError ? failure.message : t('errors.unknown')),
  })

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return <NoAccessState />
    }
    return (
      <ErrorState
        description={error instanceof ApiError ? error.message : t('errors.unknown')}
        onRetry={() => refetch()}
      />
    )
  }
  if (!calendar) return <EmptyState title={t('common.states.notFound')} />

  const name = calendarName(calendar, t)
  const details = [
    { label: t('calendar.view.kind'), value: t(`calendar.kinds.${calendar.kind}`) },
    ...(calendar.spaceName ? [{ label: t('calendar.view.space'), value: calendar.spaceName }] : []),
    ...(calendar.owner
      ? [{ label: t('calendar.view.owner'), value: calendar.owner.displayName }]
      : []),
    { label: t('calendar.settings.timezone'), value: calendar.timezone },
    ...(calendar.resource
      ? [
          {
            label: t('calendar.resource.kind'),
            value: t(`calendar.resource.kinds.${calendar.resource.kind}`),
          },
          ...(calendar.resource.location
            ? [{ label: t('calendar.resource.location'), value: calendar.resource.location }]
            : []),
          ...(calendar.resource.capacity
            ? [
                {
                  label: t('calendar.resource.capacity'),
                  value: String(calendar.resource.capacity),
                },
              ]
            : []),
        ]
      : []),
    ...(calendar.subscription
      ? [
          { label: t('calendar.view.source'), value: calendar.subscription.host },
          {
            label: t('calendar.view.synced'),
            value: calendar.subscription.syncedAt
              ? formatDateTime(calendar.subscription.syncedAt, { locale })
              : t(`calendar.view.syncStatus.${calendar.subscription.status}`),
          },
        ]
      : []),
  ]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <span
              aria-hidden
              className={cn('size-3 shrink-0 rounded-sm', toneClasses(calendar.color).dot)}
            />
            <span className="truncate text-sm font-semibold text-fg">{name}</span>
            <Badge size="sm" tone="neutral">
              {t(`calendar.kinds.${calendar.kind}`)}
            </Badge>
          </>
        }
        right={
          <>
            {calendar.can.feed ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Link2 className="size-3.5" />}
                onClick={() => setDialog('feed')}
              >
                {t('calendar.sidebar.feed')}
              </Button>
            ) : null}
            {calendar.can.manage && calendar.kind !== 'personal' ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Share2 className="size-3.5" />}
                onClick={() => setDialog('share')}
              >
                {t('calendar.sidebar.share')}
              </Button>
            ) : null}
            {calendar.can.manage ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Settings2 className="size-3.5" />}
                onClick={() => setDialog('settings')}
              >
                {t('calendar.sidebar.settings')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="primary"
              icon={<CalendarDays className="size-3.5" />}
              loading={show.isPending}
              onClick={() => show.mutate()}
            >
              {t('calendar.view.showInCalendar')}
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
        <div className="mx-auto flex max-w-[860px] flex-col gap-4 p-6">
          {calendar.description ? (
            <p className="whitespace-pre-line text-sm text-fg-secondary">{calendar.description}</p>
          ) : null}
          {calendar.subscription?.status === 'error' && calendar.subscription.error ? (
            <p className="text-sm text-danger">
              {t('calendar.sidebar.syncFailed', { error: calendar.subscription.error })}
            </p>
          ) : null}
          <Card>
            <KeyValueList items={details.map((item) => ({ key: item.label, ...item }))} />
          </Card>
          <Card title={t('calendar.view.upcoming')} padded={false}>
            {!upcoming ? (
              <div className="p-4">
                <Skeleton className="h-16 w-full" />
              </div>
            ) : upcoming.items.length === 0 ? (
              <EmptyState compact icon={<CalendarDays />} title={t('calendar.view.noUpcoming')} />
            ) : (
              <ul className="divide-y divide-line">
                {upcoming.items.slice(0, 20).map((item) => (
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
                      className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-3 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <span className="tabular w-56 shrink-0 text-sm text-fg-secondary">
                        {format.when(item)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">
                        {item.busy ? t('calendar.busy') : item.title}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      {dialog === 'settings' ? (
        <CalendarSettingsDialog calendar={calendar} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'feed' ? (
        <FeedDialog calendar={calendar} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'share' ? (
        <ShareDialog
          objectId={objectId}
          title={name}
          open
          onOpenChange={(open) => !open && setDialog(null)}
        />
      ) : null}
    </div>
  )
}
