import { formatDate } from '@kchs/fields'
import { Button, Card, cn, EmptyState, Skeleton, StatusBadge } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, CheckSquare } from 'lucide-react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { taskSummaryQuery, tasksQuery } from './queries.js'
import { STATUS_TONE_KEY } from './task-status.js'

/**
 * «Мои задачи» на «Мой день» (10-tasks-projects.md §6): открытые задачи и
 * поручения, где я исполнитель, — ближайшие по сроку; сводка просроченных и
 * ждущих моей приёмки.
 */
export function MyTasksWidget() {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const { data, isLoading } = useQuery(tasksQuery({ scope: 'mine', state: 'open', limit: 6 }))
  const { data: summary } = useQuery(taskSummaryQuery())
  const items = data?.items ?? []

  const openTasks = () =>
    openTab({
      kind: 'screen',
      screen: 'tasks',
      title: t('shell.rail.tasks'),
      icon: 'task',
      mode: 'permanent',
    })

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <CheckSquare className="size-4 text-fg-muted" aria-hidden />
          {t('home.widgets.tasks')}
        </span>
      }
      action={
        <Button
          variant="link"
          size="sm"
          iconRight={<ArrowRight className="size-3.5" />}
          onClick={openTasks}
        >
          {t('home.inboxAll')}
        </Button>
      }
      padded={false}
    >
      {summary ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-line px-4 py-2 text-xs text-fg-secondary">
          <span>{t('tasks.home.open', { count: summary.open })}</span>
          <span className={cn(summary.overdue > 0 && 'text-danger')}>
            {t('tasks.home.overdue', { count: summary.overdue })}
          </span>
          {summary.toAccept > 0 ? (
            <span>{t('tasks.home.toAccept', { count: summary.toAccept })}</span>
          ) : null}
        </div>
      ) : null}
      {isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState compact icon={<CheckSquare />} title={t('tasks.home.empty')} />
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() =>
                  openTab({
                    kind: 'object',
                    objectId: item.id,
                    objectType: 'task',
                    title: item.title,
                    mode: 'permanent',
                  })
                }
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-fg">
                    <span className="mr-1.5 font-mono text-xs text-fg-muted">{item.key}</span>
                    {item.title}
                  </span>
                  {item.dueAt ? (
                    <span
                      className={cn(
                        'block text-xs',
                        item.overdue ? 'text-danger' : 'text-fg-muted',
                      )}
                    >
                      {t('inbox.dueIn', { date: formatDate(item.dueAt, { locale }) })}
                    </span>
                  ) : null}
                </span>
                <StatusBadge
                  status={STATUS_TONE_KEY[item.status]}
                  label={t(`tasks.statuses.${item.status}`)}
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
