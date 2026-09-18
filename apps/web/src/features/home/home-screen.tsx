import { formatRelativeTime } from '@kchs/fields'
import { Badge, Button, Card, cn, EmptyState, ObjectIcon, Skeleton, StatTile } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  CalendarClock,
  CheckSquare,
  Clock,
  FileUp,
  Inbox as InboxIcon,
  Megaphone,
  Plus,
  Star,
} from 'lucide-react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import {
  favoritesQuery,
  inboxCountsQuery,
  inboxQuery,
  meQuery,
  recentQuery,
} from '~/shared/api/queries.js'

export function HomeScreen() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)

  const { data: me } = useQuery(meQuery())
  const { data: counts } = useQuery(inboxCountsQuery())
  const { data: inbox, isLoading: inboxLoading } = useQuery(inboxQuery({ state: 'open' }))
  const { data: recent = [], isLoading: recentLoading } = useQuery(recentQuery())
  const { data: favorites = [] } = useQuery(favoritesQuery())

  const hour = new Date().getHours()
  const greetingKey =
    hour < 12 ? 'home.greeting.morning' : hour < 18 ? 'home.greeting.day' : 'home.greeting.evening'
  const firstName = me?.user.firstName ?? me?.user.displayName?.split(' ')[1] ?? ''

  const openObject = (item: { id: string; type: string; title: string }): void => {
    openTab({
      kind: 'object',
      objectId: item.id,
      objectType: item.type,
      title: item.title,
      mode: 'permanent',
    })
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
          </div>
        </header>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label={t('inbox.title')}
            value={counts?.total ?? 0}
            onClick={() =>
              openTab({
                kind: 'screen',
                screen: 'inbox',
                title: t('inbox.title'),
                icon: 'inbox',
                mode: 'permanent',
              })
            }
          />
          <StatTile label={t('common.time.overdue')} value={counts?.overdue ?? 0} />
          <StatTile label={t('common.time.today')} value={counts?.dueToday ?? 0} />
          <StatTile label={t('admin.delegation.title')} value={counts?.delegated ?? 0} />
        </div>

        <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          <Card
            title={
              <span className="flex items-center gap-2">
                <InboxIcon className="size-4 text-fg-muted" aria-hidden />
                {t('home.widgets.inbox')}
              </span>
            }
            action={
              <Button
                variant="link"
                size="sm"
                iconRight={<ArrowRight className="size-3.5" />}
                onClick={() =>
                  openTab({
                    kind: 'screen',
                    screen: 'inbox',
                    title: t('inbox.title'),
                    icon: 'inbox',
                    mode: 'permanent',
                  })
                }
              >
                {t('home.inboxAll')}
              </Button>
            }
            padded={false}
          >
            {inboxLoading ? (
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={index} className="h-12 w-full" />
                ))}
              </div>
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

          <div className="flex flex-col gap-4">
            <Card
              title={
                <span className="flex items-center gap-2">
                  <Clock className="size-4 text-fg-muted" aria-hidden />
                  {t('home.widgets.continue')}
                </span>
              }
              padded={false}
            >
              {recentLoading ? (
                <div className="flex flex-col gap-2 p-4">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <Skeleton key={index} className="h-8 w-full" />
                  ))}
                </div>
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
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">
                          {item.title}
                        </span>
                        <span className="shrink-0 text-2xs text-fg-muted">
                          {formatRelativeTime(item.updatedAt, { locale })}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title={
                <span className="flex items-center gap-2">
                  <Star className="size-4 text-fg-muted" aria-hidden />
                  {t('home.widgets.pinned')}
                </span>
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
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">
                          {item.title}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>

        <Card
          title={
            <span className="flex items-center gap-2">
              <Megaphone className="size-4 text-fg-muted" aria-hidden />
              {t('home.widgets.announcements')}
            </span>
          }
        >
          <div className="flex items-start gap-3 text-sm text-fg-secondary">
            <CalendarClock className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden />
            <p>{t('home.phaseAnnouncement')}</p>
          </div>
        </Card>
      </div>
    </div>
  )
}
