import {
  type AnnouncementSeverity,
  INBOX_GROUPS,
  type InboxCounts,
  type InboxGroup,
  inboxGroupOf,
} from '@kchs/contracts'
import { formatRelativeTime } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  Card,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  ObjectIcon,
  SegmentedControl,
  Skeleton,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  CheckSquare,
  Clock,
  FileUp,
  History,
  Inbox as InboxIcon,
  LayoutGrid,
  LayoutPanelLeft,
  Megaphone,
  Plus,
  SlidersHorizontal,
  Star,
} from 'lucide-react'
import { type ReactNode, Suspense, useEffect, useState } from 'react'
import { LazyTodayWidget } from '~/features/calendar/index.js'
import {
  LazyIssuedWidget,
  LazyMyTasksWidget,
  LazyTeamWidget,
  teamQuery,
} from '~/features/tasks/index.js'
import { LazySituationWidget } from '~/features/warnings/index.js'
import {
  announcementsQuery,
  favoritesQuery,
  inboxCountsQuery,
  inboxQuery,
  meQuery,
  recentQuery,
  workspacesQuery,
} from '~/shared/api/queries.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { useOpenWorkspace } from '~/shared/workspace/open-workspace.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { actionHint } from './action-hint.js'
import { HomeSettingsDialog } from './home-settings-dialog.js'
import { HOME_WIDGETS_PREFERENCE, type HomeWidget, widgetsFor } from './widgets.js'

type OpenObject = (item: { id: string; type: string; title: string }) => void

/** Широкие виджеты занимают две колонки из трёх: Входящие — главное на экране. */
const WIDE: ReadonlySet<HomeWidget> = new Set(['inbox'])

/** Текущее время с шагом в минуту — для строки даты и времени. */
function useMinute(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const tick = () => {
      setNow(new Date())
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50)
    }
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50)
    return () => clearTimeout(timer)
  }, [])
  return now
}

/** Дела Входящих по группам — из счётчиков по видам. */
function countsByGroup(counts: Pick<InboxCounts, 'byKind'> | undefined) {
  const result: Record<InboxGroup, number> = {
    decide: 0,
    acknowledge: 0,
    instructions: 0,
    invites: 0,
    data: 0,
  }
  for (const [kind, count] of Object.entries(counts?.byKind ?? {})) {
    result[inboxGroupOf(kind)] += count
  }
  return result
}

/**
 * «Мой день» (P0-E15 S01, 12-calendar-notifications-home.md §4; облик — ADR-0230):
 * дата и время, приветствие и одна строка о главном, затем виджеты в порядке, который
 * выбрал пользователь, — или набором по его роли. Входящие — широким блоком.
 */
export function HomeScreen() {
  const t = useT()
  const locale = useLocale()
  const openTab = useWorkspace((s) => s.openTab)
  const openWorkspace = useOpenWorkspace()
  const [customizing, setCustomizing] = useState(false)
  const now = useMinute()

  const { data: me } = useQuery(meQuery())
  const { data: counts } = useQuery(inboxCountsQuery())
  const { data: workspaces = [] } = useQuery(workspacesQuery())
  const roles = me?.roles ?? []
  const hiddenScreens = new Set<string>(me?.hiddenScreens ?? [])
  const widgets = widgetsFor(me?.preferences[HOME_WIDGETS_PREFERENCE], roles)
  // «Команда» — только руководителям: у кого нет подчинённых, виджет не занимает место
  const { data: team } = useQuery({ ...teamQuery(), enabled: widgets.includes('team') })
  const shown = widgets.filter(
    (widget) =>
      (widget !== 'team' || team?.manager === true) &&
      // «Обстановка» — у кого экран предупреждений включён (15-admin-operations.md §1)
      (widget !== 'situation' || !hiddenScreens.has('warnings')),
  )

  const hour = now.getHours()
  const greetingKey =
    hour < 12 ? 'home.greeting.morning' : hour < 18 ? 'home.greeting.day' : 'home.greeting.evening'
  const firstName = me?.user.firstName ?? me?.user.displayName?.split(' ')[1] ?? ''
  const intl = locale === 'en' ? 'en-US' : 'ru-RU'
  const dateLine = new Intl.DateTimeFormat(intl, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now)
  const timeLine = new Intl.DateTimeFormat(intl, { hour: '2-digit', minute: '2-digit' }).format(now)

  // Одна строка о главном: решения, сроки сегодня, просрочки, замещение
  const decide = countsByGroup(counts).decide
  const summary = [
    { key: 'decide', count: decide, tone: 'text-fg' },
    { key: 'dueToday', count: counts?.dueToday ?? 0, tone: 'text-fg' },
    { key: 'overdue', count: counts?.overdue ?? 0, tone: 'text-danger' },
    { key: 'delegated', count: counts?.delegated ?? 0, tone: 'text-warning' },
  ].filter((part) => part.count > 0)

  const lastWorkspace = workspaces.reduce<(typeof workspaces)[number] | null>(
    (latest, item) => (!latest || item.updatedAt > latest.updatedAt ? item : latest),
    null,
  )

  const openObject: OpenObject = (item) => {
    openTab({
      kind: 'object',
      objectId: item.id,
      objectType: item.type,
      title: item.title,
      mode: 'permanent',
    })
  }
  const openInbox = () =>
    openTab({
      kind: 'screen',
      screen: 'inbox',
      title: t('inbox.title'),
      icon: 'inbox',
      mode: 'permanent',
    })

  const render: Record<HomeWidget, () => ReactNode> = {
    inbox: () => <InboxWidget openObject={openObject} openInbox={openInbox} />,
    today: () => (
      <Suspense fallback={null}>
        <LazyTodayWidget />
      </Suspense>
    ),
    situation: () => (
      <Suspense fallback={null}>
        <LazySituationWidget />
      </Suspense>
    ),
    tasks: () => (
      <Suspense fallback={null}>
        <LazyMyTasksWidget />
      </Suspense>
    ),
    assigned: () => (
      <Suspense fallback={null}>
        <LazyIssuedWidget />
      </Suspense>
    ),
    team: () => (
      <Suspense fallback={null}>
        <LazyTeamWidget />
      </Suspense>
    ),
    announcements: () => <AnnouncementsWidget />,
    continue: () => <ContinueWidget />,
    recent: () => <RecentWidget openObject={openObject} />,
    pinned: () => <PinnedWidget openObject={openObject} />,
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-6 px-8 py-7">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="tabular font-mono text-xs tracking-wider text-fg-muted uppercase">
              {`${dateLine} · ${timeLine}`}
            </p>
            <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-fg">
              {t(greetingKey, { name: firstName })}
            </h1>
            <p className="mt-1.5 text-base text-fg-secondary">
              {summary.length === 0
                ? t('home.summary.clear')
                : summary.map((part, index) => (
                    <span key={part.key}>
                      {index > 0 ? ' · ' : null}
                      <span className={part.tone}>
                        {t(`home.summary.${part.key}`, { count: part.count })}
                      </span>
                    </span>
                  ))}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {lastWorkspace ? (
              <Button
                variant="secondary"
                icon={<History className="size-4" />}
                onClick={() => void openWorkspace(lastWorkspace)}
                title={t('home.continueHint')}
              >
                {t('home.widgets.continue')}
                <span className="max-w-48 truncate font-normal text-fg-muted">
                  {lastWorkspace.title}
                </span>
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="primary" icon={<Plus className="size-4" />}>
                  {t('common.actions.create')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  icon={<FileUp className="size-4" />}
                  onSelect={() =>
                    openTab({
                      kind: 'screen',
                      screen: 'files',
                      title: t('shell.rail.files'),
                      icon: 'folder',
                      mode: 'permanent',
                    })
                  }
                >
                  {t('home.actions.uploadFile')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  icon={<LayoutGrid className="size-4" />}
                  onSelect={() =>
                    openTab({
                      kind: 'screen',
                      screen: 'spaces',
                      title: t('spaces.title'),
                      icon: 'space',
                      mode: 'permanent',
                    })
                  }
                >
                  {t('spaces.create.title')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <IconButton label={t('home.customize')} onClick={() => setCustomizing(true)}>
              <SlidersHorizontal className="size-4" />
            </IconButton>
          </div>
        </header>

        {shown.length === 0 ? (
          <EmptyState
            title={t('home.noWidgets')}
            action={
              <Button variant="secondary" onClick={() => setCustomizing(true)}>
                {t('home.customize')}
              </Button>
            }
          />
        ) : (
          // Колонки — по ширине рабочей области, а не окна: панели оболочки её сужают
          <div className="@container">
            <div className="grid grid-flow-row-dense grid-cols-1 items-start gap-4 @3xl:grid-cols-2 @6xl:grid-cols-3">
              {shown.map((widget) => (
                <div key={widget} className={cn('min-w-0', WIDE.has(widget) && '@3xl:col-span-2')}>
                  {render[widget]()}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <HomeSettingsDialog open={customizing} onOpenChange={setCustomizing} current={widgets} />
    </div>
  )
}

function WidgetTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      {icon}
      {children}
    </span>
  )
}

function ListSkeleton({ rows, height }: { rows: number; height: string }) {
  return (
    <div className="flex flex-col gap-2 p-4">
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className={cn(height, 'w-full')} />
      ))}
    </div>
  )
}

type InboxTab = 'all' | InboxGroup

/**
 * Входящие на «Мой день»: вкладки по группам дел со счётчиками, у каждого дела — кто и
 * откуда, срок и главное действие. Первое дело — основной кнопкой: с него начинают.
 */
function InboxWidget({ openObject, openInbox }: { openObject: OpenObject; openInbox: () => void }) {
  const t = useT()
  const locale = useLocale()
  const { data: counts } = useQuery(inboxCountsQuery())
  const byGroup = countsByGroup(counts)
  const [chosen, setChosen] = useState<InboxTab | null>(null)
  const tab: InboxTab = chosen ?? (byGroup.decide > 0 ? 'decide' : 'all')
  const tabs: InboxTab[] = [
    'all',
    ...INBOX_GROUPS.filter((group) => group === tab || byGroup[group] > 0),
  ]
  const { data: inbox, isLoading } = useQuery(
    inboxQuery(tab === 'all' ? { state: 'open' } : { state: 'open', group: tab }),
  )
  const now = Date.now()

  return (
    <Card
      title={
        <WidgetTitle icon={<InboxIcon className="size-4 text-fg-muted" aria-hidden />}>
          {t('home.widgets.inbox')}
        </WidgetTitle>
      }
      action={
        <Button
          variant="link"
          size="sm"
          iconRight={<ArrowRight className="size-3.5" />}
          onClick={openInbox}
        >
          {t('home.allInbox')}
        </Button>
      }
      padded={false}
    >
      {tabs.length > 2 ? (
        <div className="overflow-x-auto border-b border-line px-4 py-2">
          <SegmentedControl
            size="sm"
            aria-label={t('inbox.groupLabel')}
            value={tab}
            onValueChange={setChosen}
            className="whitespace-nowrap"
            options={tabs.map((value) => ({
              value,
              label: (
                <>
                  {value === 'all' ? t('home.inboxAll') : t(`inbox.groups.${value}`)}
                  <span className="tabular text-fg-muted">
                    {value === 'all' ? (counts?.total ?? 0) : byGroup[value]}
                  </span>
                </>
              ),
            }))}
          />
        </div>
      ) : null}
      {isLoading ? (
        <ListSkeleton rows={4} height="h-12" />
      ) : !inbox?.items.length ? (
        <EmptyState compact icon={<CheckSquare />} title={t('home.emptyInbox')} />
      ) : (
        <ul className="divide-y divide-line">
          {inbox.items.slice(0, 6).map((item, index) => {
            const overdue = item.dueAt ? Date.parse(item.dueAt) < now : false
            const open = () => item.object && openObject(item.object)
            return (
              <li key={item.id} className="flex items-center gap-4 px-4 py-3 hover:bg-surface-2">
                <ObjectIcon
                  type={item.object?.type ?? 'inbox'}
                  className="size-4 shrink-0 text-fg-muted"
                />
                <button type="button" onClick={open} className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-2 text-xs text-fg-muted">
                    {item.priority === 'urgent' || item.priority === 'high' ? (
                      <Badge tone="danger" size="sm">
                        {t('inbox.urgent')}
                      </Badge>
                    ) : null}
                    <span className="truncate">
                      {[
                        tab === 'all' ? t(`inbox.groups.${inboxGroupOf(item.kind)}`) : null,
                        item.actor?.displayName,
                        item.onBehalfOf ? item.onBehalfOf.displayName : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-sm font-medium text-fg">
                    {item.title}
                  </span>
                </button>
                {item.dueAt ? (
                  <span
                    className={cn(
                      'tabular shrink-0 font-mono text-xs',
                      overdue ? 'text-danger' : 'text-fg-secondary',
                    )}
                  >
                    {formatRelativeTime(item.dueAt, { locale })}
                  </span>
                ) : null}
                <Button
                  size="sm"
                  variant={index === 0 ? 'primary' : 'secondary'}
                  className="shrink-0"
                  onClick={open}
                  disabled={!item.object}
                >
                  {t(actionHint(item))}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

const ANNOUNCEMENT_TONES: Record<AnnouncementSeverity, 'info' | 'warning' | 'danger'> = {
  info: 'info',
  warning: 'warning',
  critical: 'danger',
}

function AnnouncementsWidget() {
  const t = useT()
  const locale = useLocale()
  const { data: announcements = [], isLoading } = useQuery(announcementsQuery())

  return (
    <Card
      title={
        <WidgetTitle icon={<Megaphone className="size-4 text-fg-muted" aria-hidden />}>
          {t('home.widgets.announcements')}
        </WidgetTitle>
      }
    >
      {isLoading ? (
        <ListSkeleton rows={2} height="h-14" />
      ) : announcements.length === 0 ? (
        <EmptyState compact title={t('home.emptyAnnouncements')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {announcements.map((item) => (
            <li key={item.id}>
              <Callout tone={ANNOUNCEMENT_TONES[item.severity]} title={item.title}>
                <span className="block whitespace-pre-line">{item.body}</span>
                <span className="mt-1 block text-xs text-fg-muted">
                  {t('home.announcementBy', {
                    name: item.createdBy?.displayName ?? '—',
                    date: formatRelativeTime(item.startsAt, { locale }),
                  })}
                </span>
              </Callout>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/** «Продолжить»: сохранённые рабочие пространства — открыть одним действием. */
function ContinueWidget() {
  const t = useT()
  const locale = useLocale()
  const open = useOpenWorkspace()
  const { data: workspaces = [], isLoading } = useQuery(workspacesQuery())

  return (
    <Card
      title={
        <WidgetTitle icon={<History className="size-4 text-fg-muted" aria-hidden />}>
          {t('home.widgets.continue')}
        </WidgetTitle>
      }
      padded={false}
    >
      {isLoading ? (
        <ListSkeleton rows={3} height="h-8" />
      ) : workspaces.length === 0 ? (
        <EmptyState
          compact
          title={t('home.emptyWorkspaces')}
          description={t('home.emptyWorkspacesHint')}
        />
      ) : (
        <ul className="divide-y divide-line">
          {workspaces.slice(0, 6).map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => void open(item)}
                className="flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-surface-2"
              >
                <LayoutPanelLeft className="size-4 shrink-0 text-fg-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{item.title}</span>
                <span className="shrink-0 text-2xs text-fg-muted">
                  {formatRelativeTime(item.updatedAt, { locale })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function RecentWidget({ openObject }: { openObject: OpenObject }) {
  const t = useT()
  const locale = useLocale()
  const { data: recent = [], isLoading } = useQuery(recentQuery())

  return (
    <Card
      title={
        <WidgetTitle icon={<Clock className="size-4 text-fg-muted" aria-hidden />}>
          {t('home.widgets.recent')}
        </WidgetTitle>
      }
      padded={false}
    >
      {isLoading ? (
        <ListSkeleton rows={3} height="h-8" />
      ) : recent.length === 0 ? (
        <EmptyState compact title={t('home.emptyRecent')} />
      ) : (
        <ul className="divide-y divide-line">
          {recent.slice(0, 6).map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => openObject(item)}
                className="flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-surface-2"
              >
                <ObjectIcon type={item.type} className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{item.title}</span>
                <span className="shrink-0 text-2xs text-fg-muted">
                  {formatRelativeTime(item.updatedAt, { locale })}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function PinnedWidget({ openObject }: { openObject: OpenObject }) {
  const t = useT()
  const { data: favorites = [] } = useQuery(favoritesQuery())

  return (
    <Card
      title={
        <WidgetTitle icon={<Star className="size-4 text-fg-muted" aria-hidden />}>
          {t('home.widgets.pinned')}
        </WidgetTitle>
      }
      padded={false}
    >
      {favorites.length === 0 ? (
        <EmptyState
          compact
          title={t('home.emptyFavorites')}
          description={t('home.emptyFavoritesHint')}
        />
      ) : (
        <ul className="divide-y divide-line">
          {favorites.slice(0, 5).map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => openObject(item)}
                className="flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-surface-2"
              >
                <ObjectIcon type={item.type} className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{item.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
