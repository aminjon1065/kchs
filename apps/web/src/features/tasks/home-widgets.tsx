import type { TaskListItem } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import { Avatar, Badge, Button, Card, cn, EmptyState, Skeleton, StatusBadge } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ClipboardList, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { issuedQuery, teamQuery } from './queries.js'
import { STATUS_TONE_KEY } from './task-status.js'

function useOpenTask() {
  const openTab = useWorkspace((s) => s.openTab)
  return (item: TaskListItem) =>
    openTab({
      kind: 'object',
      objectId: item.id,
      objectType: 'task',
      title: item.title,
      mode: 'permanent',
    })
}

/** Строка поручения в виджете: ключ, название, срок и статус. */
function TaskLine({ item, onOpen }: { item: TaskListItem; onOpen: () => void }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-fg">
          <span className="mr-1.5 font-mono text-xs text-fg-muted">{item.key}</span>
          {item.title}
        </span>
        <span className="flex items-center gap-2 text-xs text-fg-muted">
          {item.assignee ? <span className="truncate">{item.assignee.displayName}</span> : null}
          {item.dueAt ? (
            <span className={cn(item.overdue && 'text-danger')}>
              {t('inbox.dueIn', { date: formatDate(item.dueAt, { locale }) })}
            </span>
          ) : null}
        </span>
      </span>
      {item.can.decideExtension ? (
        <Badge tone="warning" size="sm">
          {t('home.issued.extension')}
        </Badge>
      ) : null}
      <StatusBadge
        status={STATUS_TONE_KEY[item.status]}
        label={t(`tasks.statuses.${item.status}`)}
      />
    </button>
  )
}

function Counter({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <span className="flex flex-col">
      <span className={cn('tabular text-lg font-semibold', value > 0 ? tone : 'text-fg-muted')}>
        {value}
      </span>
      <span className="text-2xs text-fg-muted">{label}</span>
    </span>
  )
}

function WidgetCard({
  icon,
  title,
  action,
  children,
}: {
  icon: ReactNode
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {icon}
          {title}
        </span>
      }
      action={action}
      padded={false}
    >
      {children}
    </Card>
  )
}

/**
 * «Выданные мной» (12-calendar-notifications-home.md §4, ADR-0082): поручения
 * на контроле у автора по статусам и то, что требует его внимания: отчёты,
 * запросы продления, просрочки.
 */
export function IssuedWidget() {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const openTask = useOpenTask()
  const { data, isLoading } = useQuery(issuedQuery())
  const openScreen = () =>
    openTab({
      kind: 'screen',
      screen: 'tasks',
      title: t('shell.rail.tasks'),
      icon: 'task',
      mode: 'permanent',
    })
  return (
    <WidgetCard
      icon={<ClipboardList className="size-4 text-fg-muted" aria-hidden />}
      title={t('home.widgets.assigned')}
      action={
        <Button
          variant="link"
          size="sm"
          iconRight={<ArrowRight className="size-3.5" />}
          onClick={openScreen}
        >
          {t('home.inboxAll')}
        </Button>
      }
    >
      {isLoading || !data ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 border-b border-line px-4 py-3 sm:grid-cols-6">
            <Counter label={t('home.issued.assigned')} value={data.assigned} />
            <Counter label={t('home.issued.inProgress')} value={data.inProgress + data.returned} />
            <Counter label={t('home.issued.reported')} value={data.reported} tone="text-accent" />
            <Counter
              label={t('home.issued.extensionRequests')}
              value={data.extensionRequests}
              tone="text-warning"
            />
            <Counter label={t('home.issued.dueToday')} value={data.dueToday} tone="text-accent" />
            <Counter label={t('home.issued.overdue')} value={data.overdue} tone="text-danger" />
          </div>
          {data.items.length === 0 ? (
            <EmptyState compact title={t('home.issued.empty')} />
          ) : (
            <ul aria-label={t('home.issued.attention')} className="divide-y divide-line">
              {data.items.map((item) => (
                <li key={item.id}>
                  <TaskLine item={item} onOpen={() => openTask(item)} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </WidgetCard>
  )
}

/**
 * «Команда» (12-calendar-notifications-home.md §4): просрочки и нагрузка
 * подчинённых руководителя; переход — к экрану «Нагрузка».
 */
export function TeamWidget() {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const openTask = useOpenTask()
  const { data, isLoading } = useQuery(teamQuery())
  const openWorkload = () =>
    openTab({
      kind: 'screen',
      screen: 'workload',
      title: t('tasks.workload.title'),
      icon: 'user',
      mode: 'permanent',
    })
  return (
    <WidgetCard
      icon={<Users className="size-4 text-fg-muted" aria-hidden />}
      title={t('home.widgets.team')}
      action={
        data?.manager ? (
          <Button
            variant="link"
            size="sm"
            iconRight={<ArrowRight className="size-3.5" />}
            onClick={openWorkload}
          >
            {t('home.team.workload')}
          </Button>
        ) : null
      }
    >
      {isLoading || !data ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !data.manager ? (
        <EmptyState compact title={t('home.team.notManager')} />
      ) : (
        <>
          {data.members.length === 0 ? (
            <EmptyState compact title={t('home.team.empty')} />
          ) : (
            <ul aria-label={t('home.widgets.team')} className="divide-y divide-line">
              {data.members.slice(0, 6).map((member) => (
                <li key={member.user.id} className="flex items-center gap-3 px-4 py-2">
                  <Avatar name={member.user.displayName} src={member.user.avatarUrl} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">
                    {member.user.displayName}
                  </span>
                  <span className="tabular text-xs text-fg-secondary">
                    {t('home.team.open', { count: member.open })}
                  </span>
                  <span className="tabular text-xs text-fg-secondary">
                    {t('home.team.week', { count: member.dueThisWeek })}
                  </span>
                  {member.overdue > 0 ? (
                    <Badge tone="danger" size="sm">
                      {t('home.team.overdue', { count: member.overdue })}
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {data.overdue.length > 0 ? (
            <div className="border-t border-line">
              <p className="px-4 pt-2 text-2xs font-semibold tracking-wide text-fg-muted uppercase">
                {t('home.team.overdueTitle')}
              </p>
              <ul aria-label={t('home.team.overdueTitle')} className="divide-y divide-line">
                {data.overdue.slice(0, 5).map((item) => (
                  <li key={item.id}>
                    <TaskLine item={item} onOpen={() => openTask(item)} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </WidgetCard>
  )
}
