import type { AnnouncementSeverity } from '@kchs/contracts'
import { formatRelativeTime } from '@kchs/fields'
import {
  Badge,
  Button,
  Callout,
  Card,
  cn,
  EmptyState,
  ObjectIcon,
  Skeleton,
  StatTile,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  CheckSquare,
  Clock,
  FileUp,
  History,
  Inbox as InboxIcon,
  LayoutPanelLeft,
  Megaphone,
  Plus,
  Settings2,
  Star,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { useOpenWorkspace } from '~/app/workspace/workspaces-menu.js'
import { MyTasksWidget } from '~/features/tasks/my-tasks-widget.js'
import {
  announcementsQuery,
  favoritesQuery,
  inboxCountsQuery,
  inboxQuery,
  meQuery,
  recentQuery,
  workspacesQuery,
} from '~/shared/api/queries.js'
import { HomeSettingsDialog } from './home-settings-dialog.js'
import { HOME_WIDGETS_PREFERENCE, type HomeWidget, widgetsFor } from './widgets.js'

type OpenObject = (item: { id: string; type: string; title: string }) => void

/**
 * «Мой день» (P0-E15 S01, 12-calendar-notifications-home.md §4): приветствие,
 * счётчики Входящих и виджеты в порядке, который выбрал пользователь, — или
 * набором по его роли.
 */
export function HomeScreen() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const [customizing, setCustomizing] = useState(false)

  const { data: me } = useQuery(meQuery())
  const { data: counts } = useQuery(inboxCountsQuery())
  const roles = me?.roles ?? []
  const widgets = widgetsFor(me?.preferences[HOME_WIDGETS_PREFERENCE], roles)

  const hour = new Date().getHours()
  const greetingKey =
    hour < 12 ? 'home.greeting.morning' : hour < 18 ? 'home.greeting.day' : 'home.greeting.evening'
  const firstName = me?.user.firstName ?? me?.user.displayName?.split(' ')[1] ?? ''

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
    tasks: () => <MyTasksWidget />,
    announcements: () => <AnnouncementsWidget />,
    continue: () => <ContinueWidget />,
    recent: () => <RecentWidget openObject={openObject} />,
    pinned: () => <PinnedWidget openObject={openObject} />,
  }

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-5 px-6 py-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-fg">
              {t(greetingKey, { name: firstName })}
            </h1>
            <p className="mt-1 text-sm text-fg-secondary">
              {new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'ru-RU', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              }).format(new Date())}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              icon={<FileUp className="size-4" />}
              onClick={() =>
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
            </Button>
            <Button
              variant="secondary"
              icon={<Plus className="size-4" />}
              onClick={() =>
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
            </Button>
            <Button
              variant="ghost"
              icon={<Settings2 className="size-4" />}
              onClick={() => setCustomizing(true)}
            >
              {t('home.customize')}
            </Button>
          </div>
        </header>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label={t('inbox.title')} value={counts?.total ?? 0} onClick={openInbox} />
          <StatTile label={t('common.time.overdue')} value={counts?.overdue ?? 0} />
          <StatTile label={t('common.time.today')} value={counts?.dueToday ?? 0} />
          <StatTile label={t('admin.delegation.title')} value={counts?.delegated ?? 0} />
        </div>

        {widgets.length === 0 ? (
          <EmptyState
            title={t('home.noWidgets')}
            action={
              <Button variant="secondary" onClick={() => setCustomizing(true)}>
                {t('home.customize')}
              </Button>
            }
          />
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-2">
            {widgets.map((widget) => (
              <div key={widget}>{render[widget]()}</div>
            ))}
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

function InboxWidget({ openObject, openInbox }: { openObject: OpenObject; openInbox: () => void }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const { data: inbox, isLoading } = useQuery(inboxQuery({ state: 'open' }))

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
          {t('home.inboxAll')}
        </Button>
      }
      padded={false}
    >
      {isLoading ? (
        <ListSkeleton rows={3} height="h-12" />
      ) : !inbox?.items.length ? (
        <EmptyState compact icon={<CheckSquare />} title={t('home.emptyInbox')} />
      ) : (
        <ul className="divide-y divide-line">
          {inbox.items.slice(0, 6).map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => item.object && openObject(item.object)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2"
              >
                <ObjectIcon
                  type={item.object?.type ?? 'inbox'}
                  className="size-4 shrink-0 text-fg-muted"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">{item.title}</span>
                  {item.dueAt ? (
                    <span
                      className={cn(
                        'block text-xs',
                        new Date(item.dueAt) < new Date() ? 'text-danger' : 'text-fg-muted',
                      )}
                    >
                      {t('inbox.dueIn', { date: formatRelativeTime(item.dueAt, { locale }) })}
                    </span>
                  ) : null}
                </span>
                <Badge tone={item.priority === 'urgent' ? 'danger' : 'neutral'} size="sm">
                  {t(`inbox.actions.${item.actions[0]?.key ?? 'open'}`)}
                </Badge>
              </button>
            </li>
          ))}
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
  const locale = useAppearance((s) => s.locale)
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
  const locale = useAppearance((s) => s.locale)
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
  const locale = useAppearance((s) => s.locale)
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
