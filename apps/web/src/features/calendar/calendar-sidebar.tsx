import type {
  CalendarKind,
  CalendarProjectionSource,
  CalendarRecord,
  CalendarSettings,
} from '@kchs/contracts'
import {
  Checkbox,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  MiniCalendar,
  Skeleton,
  toneClasses,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CalendarPlus,
  Eye,
  FileUp,
  Link2,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings2,
  Share2,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ShareDialog } from '~/features/access/share-dialog.js'
import { ApiError, http } from '~/shared/api/client.js'
import { useBusinessDays } from './business-days.js'
import {
  AddCalendarDialog,
  CalendarSettingsDialog,
  type CreatableKind,
  CreateCalendarDialog,
  FeedDialog,
  ImportDialog,
  MySettingsDialog,
} from './calendar-dialogs.js'
import { daysFor } from './model.js'
import {
  calendarKeys,
  calendarSettingsQuery,
  calendarsQuery,
  projectionSourcesQuery,
} from './queries.js'

const GROUPS: Array<{ kind: CalendarKind; labelKey: string }> = [
  { kind: 'personal', labelKey: 'calendar.sidebar.groups.personal' },
  { kind: 'team', labelKey: 'calendar.sidebar.groups.team' },
  { kind: 'project', labelKey: 'calendar.sidebar.groups.project' },
  { kind: 'resource', labelKey: 'calendar.sidebar.groups.resource' },
  { kind: 'subscription', labelKey: 'calendar.sidebar.groups.subscription' },
]

type Dialog =
  | { kind: 'create'; calendarKind: CreatableKind }
  | { kind: 'add' }
  | { kind: 'mine' }
  | { kind: 'settings'; calendar: CalendarRecord }
  | { kind: 'feed'; calendar: CalendarRecord }
  | { kind: 'import'; calendar: CalendarRecord }
  | { kind: 'share'; calendar: CalendarRecord }

/** Название календаря в списке: мой личный — «Мой календарь», чужой личный — по владельцу. */
export function calendarName(calendar: CalendarRecord, t: ReturnType<typeof useT>): string {
  if (calendar.mine) return t('calendar.sidebar.myCalendar')
  if (calendar.kind === 'personal' && calendar.owner) return calendar.owner.displayName
  return calendar.title
}

/**
 * Левая колонка календаря (03-ui/03-screens.md §17): мини-календарь, мои
 * календари по группам с флажками «показывать», сроки других модулей,
 * добавление календарей и действия с каждым.
 */
export function CalendarSidebar({
  anchor,
  today,
  range,
  busyDays,
  onSelectDay,
  className,
}: {
  anchor: string
  today: string
  range: { from: string; to: string }
  busyDays: ReadonlySet<string>
  onSelectDay: (day: string) => void
  className?: string
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const [miniMonth, setMiniMonth] = useState(anchor.slice(0, 7))
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const { data: calendars, isLoading } = useQuery(calendarsQuery({ scope: 'mine' }))
  const { data: settings } = useQuery(calendarSettingsQuery())
  const { data: sources = [] } = useQuery(projectionSourcesQuery())
  const { marks } = useBusinessDays(daysFor('month', `${miniMonth}-01`))

  useEffect(() => setMiniMonth(anchor.slice(0, 7)), [anchor])

  const listKey = calendarKeys.list({ scope: 'mine' })
  const saveSettings = useMutation({
    mutationFn: (patch: Partial<CalendarSettings>) =>
      http.put<CalendarSettings>('/calendar/settings', patch),
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: listKey })
      const previous = client.getQueryData<CalendarRecord[]>(listKey)
      if (patch.shown && previous) {
        const shown = patch.shown
        client.setQueryData<CalendarRecord[]>(
          listKey,
          previous.map((item) =>
            shown[item.id] === undefined ? item : { ...item, shown: shown[item.id] ?? item.shown },
          ),
        )
      }
      const previousSettings = client.getQueryData<CalendarSettings>(calendarKeys.settings)
      if (previousSettings) {
        client.setQueryData<CalendarSettings>(calendarKeys.settings, {
          ...previousSettings,
          ...patch,
        })
      }
      return { previous, previousSettings }
    },
    onError: (error, _patch, context) => {
      if (context?.previous) client.setQueryData(listKey, context.previous)
      if (context?.previousSettings)
        client.setQueryData(calendarKeys.settings, context.previousSettings)
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))
    },
    onSettled: () => void client.invalidateQueries({ queryKey: calendarKeys.all }),
  })

  const sync = useMutation({
    mutationFn: (id: string) => http.post(`/calendars/${id}/sync`),
    onSuccess: () => toast.show({ title: t('calendar.sidebar.syncQueued'), tone: 'info' }),
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })

  const shownMap = (patch: Record<string, boolean>) => ({ ...(settings?.shown ?? {}), ...patch })
  const toggle = (calendar: CalendarRecord, shown: boolean) =>
    saveSettings.mutate({ shown: shownMap({ [calendar.id]: shown }) })
  const only = (calendar: CalendarRecord) =>
    saveSettings.mutate({
      shown: shownMap(
        Object.fromEntries((calendars ?? []).map((item) => [item.id, item.id === calendar.id])),
      ),
    })
  const removeFromList = (calendar: CalendarRecord) =>
    saveSettings.mutate({
      addedCalendarIds: (settings?.addedCalendarIds ?? []).filter((id) => id !== calendar.id),
    })

  const enabledProjections = settings?.projections ?? sources.map((source) => source.key)
  const toggleProjection = (source: CalendarProjectionSource, on: boolean) =>
    saveSettings.mutate({
      projections: on
        ? [...new Set([...enabledProjections, source.key])]
        : enabledProjections.filter((key) => key !== source.key),
    })

  const openCalendar = (calendar: CalendarRecord) =>
    openTab({
      kind: 'object',
      objectId: calendar.id,
      objectType: 'calendar',
      title: calendarName(calendar, t),
      mode: 'permanent',
    })

  return (
    <aside
      aria-label={t('calendar.sidebar.label')}
      className={cn(
        'flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-surface p-3',
        className,
      )}
    >
      <MiniCalendar
        aria-label={t('calendar.sidebar.miniLabel')}
        month={miniMonth}
        onMonthChange={setMiniMonth}
        value={anchor}
        onSelect={onSelectDay}
        today={today}
        range={range}
        marks={marks}
        busy={busyDays}
      />

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-5 w-full" />
          ))}
        </div>
      ) : (
        GROUPS.map((group) => {
          const items = (calendars ?? []).filter((calendar) => calendar.kind === group.kind)
          if (items.length === 0) return null
          return (
            <section key={group.kind} aria-labelledby={`calendar-group-${group.kind}`}>
              <h3
                id={`calendar-group-${group.kind}`}
                className="mb-1 px-1 text-2xs font-medium uppercase tracking-wide text-fg-muted"
              >
                {t(group.labelKey)}
              </h3>
              <ul className="flex flex-col">
                {items.map((calendar) => {
                  const name = calendarName(calendar, t)
                  const failed = calendar.subscription?.status === 'error'
                  return (
                    <li
                      key={calendar.id}
                      className="group flex min-h-7 items-center gap-2 rounded-sm px-1 hover:bg-surface-3"
                    >
                      <Checkbox
                        checked={calendar.shown}
                        onCheckedChange={(checked) => toggle(calendar, checked === true)}
                        aria-label={t('calendar.sidebar.show', { name })}
                        className={toneClasses(calendar.color).check}
                      />
                      <button
                        type="button"
                        onClick={() => toggle(calendar, !calendar.shown)}
                        className="min-w-0 flex-1 truncate text-left text-sm text-fg"
                        title={calendar.resource?.location ?? calendar.description ?? name}
                        tabIndex={-1}
                      >
                        {name}
                      </button>
                      {failed ? (
                        <AlertTriangle
                          className="size-3.5 shrink-0 text-warning"
                          aria-label={t('calendar.sidebar.syncFailed', {
                            error: calendar.subscription?.error ?? '',
                          })}
                        />
                      ) : null}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton
                            size="sm"
                            label={t('calendar.sidebar.actions', { name })}
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                          >
                            <MoreHorizontal className="size-3.5" aria-hidden />
                          </IconButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem
                            icon={<Eye className="size-3.5" />}
                            onSelect={() => only(calendar)}
                          >
                            {t('calendar.sidebar.showOnly')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            icon={<SquareArrowOutUpRight className="size-3.5" />}
                            onSelect={() => openCalendar(calendar)}
                          >
                            {t('calendar.sidebar.open')}
                          </DropdownMenuItem>
                          {calendar.can.manage ? (
                            <DropdownMenuItem
                              icon={<Settings2 className="size-3.5" />}
                              onSelect={() => setDialog({ kind: 'settings', calendar })}
                            >
                              {t('calendar.sidebar.settings')}
                            </DropdownMenuItem>
                          ) : null}
                          {calendar.can.manage && calendar.kind !== 'personal' ? (
                            <DropdownMenuItem
                              icon={<Share2 className="size-3.5" />}
                              onSelect={() => setDialog({ kind: 'share', calendar })}
                            >
                              {t('calendar.sidebar.share')}
                            </DropdownMenuItem>
                          ) : null}
                          {calendar.can.feed ? (
                            <DropdownMenuItem
                              icon={<Link2 className="size-3.5" />}
                              onSelect={() => setDialog({ kind: 'feed', calendar })}
                            >
                              {t('calendar.sidebar.feed')}
                            </DropdownMenuItem>
                          ) : null}
                          {calendar.can.edit && calendar.kind !== 'subscription' ? (
                            <DropdownMenuItem
                              icon={<FileUp className="size-3.5" />}
                              onSelect={() => setDialog({ kind: 'import', calendar })}
                            >
                              {t('calendar.sidebar.import')}
                            </DropdownMenuItem>
                          ) : null}
                          {calendar.kind === 'subscription' && calendar.can.edit ? (
                            <DropdownMenuItem
                              icon={<RefreshCw className="size-3.5" />}
                              onSelect={() => sync.mutate(calendar.id)}
                            >
                              {t('calendar.sidebar.sync')}
                            </DropdownMenuItem>
                          ) : null}
                          {calendar.added ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                icon={<X className="size-3.5" />}
                                onSelect={() => removeFromList(calendar)}
                              >
                                {t('calendar.sidebar.remove')}
                              </DropdownMenuItem>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })
      )}

      {sources.length > 0 ? (
        <section aria-labelledby="calendar-group-projections">
          <h3
            id="calendar-group-projections"
            className="mb-1 px-1 text-2xs font-medium uppercase tracking-wide text-fg-muted"
          >
            {t('calendar.sidebar.groups.projections')}
          </h3>
          <ul className="flex flex-col gap-1 px-1">
            {sources.map((source) => (
              <li key={source.key}>
                <Checkbox
                  checked={enabledProjections.includes(source.key)}
                  onCheckedChange={(checked) => toggleProjection(source, checked === true)}
                  label={t(source.labelKey)}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-auto flex flex-col gap-1 border-t border-line pt-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-2 rounded-sm px-1 py-1 text-left text-sm text-fg-secondary hover:bg-surface-3 hover:text-fg"
            >
              <CalendarPlus className="size-4" aria-hidden />
              {t('calendar.sidebar.addCalendar')}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              icon={<Search className="size-3.5" />}
              onSelect={() => setDialog({ kind: 'add' })}
            >
              {t('calendar.sidebar.findCalendar')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {(['team', 'project', 'resource', 'subscription'] as const).map((kind) => (
              <DropdownMenuItem
                key={kind}
                onSelect={() => setDialog({ kind: 'create', calendarKind: kind })}
              >
                {t(`calendar.create.kinds.${kind}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={() => setDialog({ kind: 'mine' })}
          className="flex items-center gap-2 rounded-sm px-1 py-1 text-left text-sm text-fg-secondary hover:bg-surface-3 hover:text-fg"
        >
          <Settings2 className="size-4" aria-hidden />
          {t('calendar.settings.title')}
        </button>
      </div>

      {dialog?.kind === 'create' ? (
        <CreateCalendarDialog kind={dialog.calendarKind} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'add' ? <AddCalendarDialog onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'mine' ? <MySettingsDialog onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === 'settings' ? (
        <CalendarSettingsDialog calendar={dialog.calendar} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'feed' ? (
        <FeedDialog calendar={dialog.calendar} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'import' ? (
        <ImportDialog calendar={dialog.calendar} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'share' ? (
        <ShareDialog
          objectId={dialog.calendar.id}
          title={calendarName(dialog.calendar, t)}
          open
          onOpenChange={(open) => !open && setDialog(null)}
        />
      ) : null}
    </aside>
  )
}
