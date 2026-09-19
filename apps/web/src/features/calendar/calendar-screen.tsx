import type {
  CalendarProjectionItem,
  CalendarRange,
  CalendarRangeItem,
  EventEditScope,
  EventRecord,
} from '@kchs/contracts'
import {
  Badge,
  Button,
  Callout,
  ErrorState,
  IconButton,
  PanelToolbar,
  Popover,
  PopoverAnchor,
  PopoverContent,
  SegmentedControl,
  Skeleton,
  Tooltip,
  useHotkeys,
  useMediaQuery,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarSearch,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { meQuery } from '~/shared/api/queries.js'
import { useBusinessDays } from './business-days.js'
import { CalendarSidebar } from './calendar-sidebar.js'
import { type EventDraft, useCalendarUi } from './calendar-store.js'
import {
  AgendaView,
  MonthView,
  type TimeChange,
  TimeView,
  titleOf,
  type ViewHandlers,
} from './calendar-views.js'
import { EventDetails } from './event-details.js'
import { type EditorTarget, EventEditor } from './event-editor.js'
import { FindTimeSheet } from './find-time.js'
import { useCalendarFormat } from './format.js'
import { daysFor, daysOfItem, shiftAnchor, VIEW_MODES, type ViewMode } from './model.js'
import type { Invitee } from './people-picker.js'
import {
  calendarSettingsQuery,
  calendarsQuery,
  eventQuery,
  rangeQuery,
  useCalendarInvalidation,
} from './queries.js'
import { ScopeDialog } from './scope-dialog.js'
import { addDays, clockMinutes, daysBetween, instantAt, todayIn, wallOf } from './time.js'
import { useNow } from './use-now.js'

export interface CalendarScreenState {
  mode?: ViewMode
}

type Popup =
  | { kind: 'event'; item: CalendarRangeItem }
  | { kind: 'projection'; item: CalendarProjectionItem }

interface PendingMove {
  item: CalendarRangeItem
  change: TimeChange
}

interface Measurable {
  getBoundingClientRect: () => DOMRect
}

const iso = (instant: number) => new Date(instant).toISOString()

/**
 * Календарь (12-calendar-notifications-home.md §1, 03-ui/03-screens.md §17):
 * неделя по умолчанию, день, месяц и повестка; слева — мини-календарь и мои
 * календари с флажками, сроки других модулей; создание протягиванием, перенос
 * и растягивание мышью; поповер события с ответом на приглашение; «Найти время».
 */
export function CalendarScreen({
  tabId,
  savedState,
}: {
  tabId?: string
  savedState?: CalendarScreenState
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const format = useCalendarFormat()
  const tz = format.timezone
  const narrow = !useMediaQuery('(min-width: 900px)')
  const setTabState = useWorkspace((s) => s.setTabState)
  const active = useWorkspace((s) => (tabId ? s.activeTab()?.id === tabId : true))
  const invalidate = useCalendarInvalidation()
  const now = useNow()
  const today = todayIn(tz, now)

  const [mode, setMode] = useState<ViewMode>(savedState?.mode ?? 'week')
  const [anchor, setAnchor] = useState(today)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [popup, setPopup] = useState<Popup | null>(null)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [pending, setPending] = useState<PendingMove | null>(null)
  const [finder, setFinder] = useState<{ attendees: Invitee[]; resourceIds: string[] } | null>(null)
  const anchorElement = useRef<HTMLElement | null>(null)
  const virtualAnchor = useRef<Measurable>({
    getBoundingClientRect: () =>
      anchorElement.current?.getBoundingClientRect() ?? new DOMRect(0, 0, 0, 0),
  })

  useEffect(() => {
    if (tabId) setTabState(tabId, { mode })
  }, [tabId, mode, setTabState])

  const { data: me } = useQuery(meQuery())
  const { data: settings } = useQuery(calendarSettingsQuery())
  const { data: calendars = [] } = useQuery(calendarsQuery({ scope: 'mine' }))

  // Заготовка из палитры команд («Встреча завтра в 10 с Ивановым»)
  const draft = useCalendarUi((s) => s.draft)
  useEffect(() => {
    if (!draft) return
    const taken = useCalendarUi.getState().takeDraft()
    if (!taken) return
    const day = taken.date ?? (taken.start ? wallOf(taken.start, tz).date : null)
    if (day) setAnchor(day)
    setEditor({ mode: 'create', draft: taken })
  }, [draft, tz])

  const days = useMemo(() => daysFor(mode, anchor), [mode, anchor])
  const first = days[0] ?? anchor
  const last = days[days.length - 1] ?? anchor
  const params = {
    from: iso(instantAt(first, 0, tz)),
    to: iso(instantAt(addDays(last, 1), 0, tz)),
  }
  const { data: range, isLoading, error, refetch } = useQuery(rangeQuery(params))
  const items = range?.items ?? []
  const projections = range?.projections ?? []
  const { info: dayInfo } = useBusinessDays(days)

  const busyDays = useMemo(() => {
    const set = new Set<string>()
    for (const item of items) for (const day of daysOfItem(item, tz)) set.add(day)
    return set
  }, [items, tz])

  const workingHours = {
    start: clockMinutes(settings?.workingHours.start ?? '09:00'),
    end: clockMinutes(settings?.workingHours.end ?? '18:00'),
  }
  const defaultDuration = settings?.defaultDurationMinutes ?? 60
  const canCreate = calendars.some((calendar) => calendar.can.edit)

  const openEditorFor = (draft: EventDraft) => {
    setPopup(null)
    setEditor({ mode: 'create', draft })
  }

  const rangeKey = rangeQuery(params).queryKey
  const move = useMutation({
    mutationFn: async ({ item, change, scope }: PendingMove & { scope: EventEditScope }) => {
      if (!item.eventId) return
      const body: Record<string, unknown> = change.allDay
        ? { startDate: change.startDate, endDate: change.endDate }
        : { startsAt: iso(change.start), endsAt: iso(change.end) }
      if (item.recurring && item.recurrenceId) {
        if (scope === 'series') {
          // Вся серия сдвигается на то же смещение, что и перенесённый экземпляр
          const series = await client.fetchQuery(eventQuery(item.eventId))
          if (change.allDay) {
            const shift = daysBetween(item.startDate ?? change.startDate, change.startDate)
            const span = daysBetween(change.startDate, change.endDate)
            const startDate = addDays(series.startDate ?? change.startDate, shift)
            Object.assign(body, { startDate, endDate: addDays(startDate, span) })
          } else {
            const start = Date.parse(series.startsAt) + (change.start - Date.parse(item.startsAt))
            Object.assign(body, {
              startsAt: iso(start),
              endsAt: iso(start + (change.end - change.start)),
            })
          }
          body.scope = 'series'
        } else {
          Object.assign(body, { scope, recurrenceId: item.recurrenceId })
        }
      }
      await http.patch(`/events/${item.eventId}`, body)
    },
    onMutate: async ({ item, change, scope }) => {
      // Перенос виден сразу, не дожидаясь ответа
      if (item.recurring && scope !== 'occurrence') return
      await client.cancelQueries({ queryKey: rangeKey })
      client.setQueryData<CalendarRange>(rangeKey, (current) =>
        current
          ? {
              ...current,
              items: current.items.map((entry) =>
                entry.key !== item.key
                  ? entry
                  : change.allDay
                    ? { ...entry, startDate: change.startDate, endDate: change.endDate }
                    : { ...entry, startsAt: iso(change.start), endsAt: iso(change.end) },
              ),
            }
          : current,
      )
    },
    onSuccess: (_, { item }) => {
      toast.show({ title: t('calendar.event.moved'), tone: 'success' })
      if (item.eventId) invalidate(item.eventId)
    },
    onError: (failure) => {
      invalidate()
      const conflicts = (failure instanceof ApiError &&
        (failure.problem as { data?: { conflicts?: unknown[] } }).data?.conflicts) as
        | unknown[]
        | undefined
      toast.error(
        conflicts?.length
          ? t('calendar.event.resourceBusy')
          : failure instanceof ApiError
            ? failure.message
            : t('errors.unknown'),
      )
    },
    onSettled: () => setPending(null),
  })

  const handlers: ViewHandlers = {
    onOpenItem: (item, element) => {
      anchorElement.current = element
      setPopup({ kind: 'event', item })
    },
    onOpenProjection: (item, element) => {
      anchorElement.current = element
      setPopup({ kind: 'projection', item })
    },
    onCreate: (draft) => {
      if (!canCreate) return
      openEditorFor(draft)
    },
    onMove: (item, change) => {
      if (item.recurring) setPending({ item, change })
      else move.mutate({ item, change, scope: 'series' })
    },
    onDayClick: (day) => {
      setAnchor(day)
      setMode('day')
    },
  }

  const go = (direction: 1 | -1) => setAnchor((current) => shiftAnchor(mode, current, direction))
  useHotkeys([
    { combo: 't', handler: () => setAnchor(today), enabled: active },
    { combo: 'n', handler: () => go(1), enabled: active },
    { combo: 'p', handler: () => go(-1), enabled: active },
    { combo: 'd', handler: () => setMode('day'), enabled: active },
    { combo: 'w', handler: () => setMode('week'), enabled: active },
    { combo: 'm', handler: () => setMode('month'), enabled: active },
    { combo: 'c', handler: () => canCreate && openEditorFor({}), enabled: active },
  ])

  const title = format.rangeTitle(mode, days, anchor)
  const showSidebar = sidebarOpen && !narrow

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            {narrow ? null : (
              <IconButton
                size="sm"
                label={t(
                  sidebarOpen ? 'calendar.toolbar.hideSidebar' : 'calendar.toolbar.showSidebar',
                )}
                onClick={() => setSidebarOpen((open) => !open)}
              >
                {sidebarOpen ? (
                  <PanelLeftClose className="size-4" aria-hidden />
                ) : (
                  <PanelLeftOpen className="size-4" aria-hidden />
                )}
              </IconButton>
            )}
            <Button size="sm" variant="secondary" onClick={() => setAnchor(today)}>
              {t('calendar.toolbar.today')}
            </Button>
            <span className="flex items-center">
              <Tooltip content={t('calendar.toolbar.previous')} shortcut="P">
                <IconButton size="sm" label={t('calendar.toolbar.previous')} onClick={() => go(-1)}>
                  <ChevronLeft className="size-4" aria-hidden />
                </IconButton>
              </Tooltip>
              <Tooltip content={t('calendar.toolbar.next')} shortcut="N">
                <IconButton size="sm" label={t('calendar.toolbar.next')} onClick={() => go(1)}>
                  <ChevronRight className="size-4" aria-hidden />
                </IconButton>
              </Tooltip>
            </span>
            <h1 className="truncate text-sm font-semibold text-fg" aria-live="polite">
              {title}
            </h1>
          </>
        }
        right={
          <>
            <SegmentedControl
              size="sm"
              aria-label={t('calendar.toolbar.view')}
              value={mode}
              onValueChange={setMode}
              options={VIEW_MODES.map((value) => ({
                value,
                label: t(`calendar.views.${value}`),
              }))}
            />
            <Button
              size="sm"
              variant="ghost"
              icon={<CalendarSearch className="size-3.5" />}
              onClick={() => setFinder({ attendees: [], resourceIds: [] })}
            >
              {narrow ? null : t('calendar.findTime.title')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Plus className="size-3.5" />}
              disabled={!canCreate}
              onClick={() => openEditorFor({})}
            >
              {t('calendar.toolbar.create')}
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        {showSidebar ? (
          <CalendarSidebar
            anchor={anchor}
            today={today}
            range={{ from: first, to: last }}
            busyDays={busyDays}
            onSelectDay={(day) => setAnchor(day)}
          />
        ) : null}

        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {range?.truncated ? (
            <Callout tone="warning" className="m-2">
              {t('calendar.views.truncated')}
            </Callout>
          ) : null}
          {error ? (
            <ErrorState
              description={error instanceof ApiError ? error.message : t('errors.unknown')}
              onRetry={() => refetch()}
            />
          ) : isLoading ? (
            <div className="flex flex-col gap-2 p-4">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-96 w-full" />
            </div>
          ) : mode === 'month' ? (
            <MonthView
              days={days}
              anchor={anchor}
              items={items}
              projections={projections}
              today={today}
              dayInfo={dayInfo}
              handlers={handlers}
            />
          ) : mode === 'agenda' ? (
            <AgendaView
              days={days}
              items={items}
              projections={projections}
              today={today}
              dayInfo={dayInfo}
              handlers={handlers}
            />
          ) : (
            <TimeView
              days={days}
              items={items}
              projections={projections}
              today={today}
              dayInfo={dayInfo}
              handlers={handlers}
              now={now}
              workingHours={workingHours}
              defaultDuration={defaultDuration}
            />
          )}
        </main>
      </div>

      <Popover open={popup !== null} onOpenChange={(open) => !open && setPopup(null)}>
        <PopoverAnchor virtualRef={virtualAnchor} />
        <PopoverContent
          side="right"
          align="start"
          collisionPadding={12}
          className="max-h-[min(640px,calc(100vh-4rem))] w-[380px] max-w-[calc(100vw-2rem)] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            anchorElement.current?.focus()
          }}
        >
          {popup?.kind === 'event' ? (
            <EventPopover
              item={popup.item}
              onEdit={(record) => {
                setPopup(null)
                setEditor({ mode: 'edit', record, occurrence: record.occurrence })
              }}
              onClosed={() => setPopup(null)}
            />
          ) : popup?.kind === 'projection' ? (
            <ProjectionPopover item={popup.item} onOpened={() => setPopup(null)} />
          ) : null}
        </PopoverContent>
      </Popover>

      {editor ? (
        <EventEditor
          key={
            editor.mode === 'edit'
              ? `${editor.record.id}:${editor.occurrence?.recurrenceId ?? ''}`
              : 'new'
          }
          target={editor}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {pending ? (
        <ScopeDialog
          mode="edit"
          loading={move.isPending}
          onClose={() => setPending(null)}
          onConfirm={(scope) => move.mutate({ ...pending, scope })}
        />
      ) : null}
      {finder && me ? (
        <FindTimeSheet
          me={{ id: me.user.id, title: me.user.displayName, avatarUrl: me.user.avatarUrl }}
          attendees={finder.attendees}
          resources={finder.resourceIds.map((id) => ({
            id,
            title: calendars.find((item) => item.id === id)?.title ?? id,
          }))}
          resourceOptions={calendars
            .filter((item) => item.kind === 'resource')
            .map((item) => ({ id: item.id, title: item.title }))}
          onAttendeesChange={(attendees) => setFinder({ ...finder, attendees })}
          onResourcesChange={(resourceIds) => setFinder({ ...finder, resourceIds })}
          durationMinutes={defaultDuration}
          date={anchor < today ? today : anchor}
          selection={null}
          onClose={() => setFinder(null)}
          onPick={(start, end) => {
            const chosen = finder
            setFinder(null)
            if (!canCreate) return
            setAnchor(wallOf(start, tz).date)
            openEditorFor({
              start,
              end,
              attendees: chosen.attendees,
              resourceIds: chosen.resourceIds,
            })
          }}
        />
      ) : null}
    </div>
  )
}

/** Поповер события: детали загружаются по щелчку, пока — название и время из сетки. */
function EventPopover({
  item,
  onEdit,
  onClosed,
}: {
  item: CalendarRangeItem
  onEdit: (record: EventRecord) => void
  onClosed: () => void
}) {
  const t = useT()
  const format = useCalendarFormat()
  const {
    data: record,
    isLoading,
    error,
  } = useQuery({
    ...eventQuery(item.eventId ?? '', item.recurrenceId),
    enabled: Boolean(item.eventId) && !item.busy,
  })

  if (item.busy || !item.eventId) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Lock className="size-4 text-fg-muted" aria-hidden />
          <span className="font-semibold text-fg">{titleOf(item, t)}</span>
        </div>
        <p className="text-sm text-fg-secondary">{format.when(item)}</p>
        {item.organizer ? (
          <p className="text-xs text-fg-muted">
            {t('calendar.event.inCalendarOf', { name: item.organizer.displayName })}
          </p>
        ) : null}
        <p className="text-xs text-fg-muted">{t('calendar.event.busyHint')}</p>
      </div>
    )
  }
  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <span className="font-semibold text-fg">{titleOf(item, t)}</span>
        <span className="text-sm text-fg-secondary">{format.when(item)}</span>
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }
  if (error || !record) {
    return (
      <p className="text-sm text-danger">
        {error instanceof ApiError ? error.message : t('errors.unknown')}
      </p>
    )
  }
  return <EventDetails record={record} compact onEdit={() => onEdit(record)} onClosed={onClosed} />
}

/** Срок из другого модуля: задача или поручение, документ на контроле. */
function ProjectionPopover({
  item,
  onOpened,
}: {
  item: CalendarProjectionItem
  onOpened: () => void
}) {
  const t = useT()
  const format = useCalendarFormat()
  const openTab = useWorkspace((s) => s.openTab)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <CheckSquare className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-fg">{item.title}</h2>
          {item.subtitle ? <p className="text-xs text-fg-muted">{item.subtitle}</p> : null}
        </div>
      </div>
      <p className="text-sm text-fg-secondary">
        {t('calendar.projection.dueAt', {
          when: item.at
            ? `${format.dayTitle(item.date)}, ${format.time(Date.parse(item.at))}`
            : format.dayTitle(item.date),
        })}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Badge size="sm" tone="neutral">
          {t(`objects.types.${item.objectType}`)}
        </Badge>
        {item.done ? (
          <Badge size="sm" tone="success">
            {t('calendar.projection.done')}
          </Badge>
        ) : item.overdue ? (
          <Badge size="sm" tone="danger">
            {t('common.time.overdue')}
          </Badge>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="self-start"
        icon={<ExternalLink className="size-3.5" />}
        onClick={() => {
          openTab({
            kind: 'object',
            objectId: item.objectId,
            objectType: item.objectType,
            title: item.title,
            mode: 'permanent',
          })
          onOpened()
        }}
      >
        {t('common.actions.open')}
      </Button>
    </div>
  )
}
