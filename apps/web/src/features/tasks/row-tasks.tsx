import { formatDate } from '@kchs/fields'
import { cn, EmptyState, Skeleton, StatusBadge } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { CheckSquare } from 'lucide-react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { rowTasksQuery } from './queries.js'
import { STATUS_TONE_KEY } from './task-status.js'

/**
 * Поручения и задачи по строке датасета — вкладка карточки строки. Только
 * видимые смотрящему: чужие поручения по той же строке не показываются.
 */
export function RowTasks({ datasetId, rowId }: { datasetId: string; rowId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const { data, isLoading } = useQuery(rowTasksQuery(datasetId, rowId))
  const items = data?.items ?? []

  if (isLoading) return <Skeleton className="h-16 w-full" />
  if (items.length === 0) {
    return (
      <EmptyState
        compact
        icon={<CheckSquare />}
        title={t('tasks.row.empty')}
        description={t('tasks.row.emptyHint')}
      />
    )
  }
  return (
    <ul className="flex flex-col gap-2">
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
            className="flex w-full flex-col gap-1.5 rounded-md border border-line p-3 text-left hover:bg-surface-2"
          >
            <span className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              <span className="font-mono">{item.key}</span>
              <StatusBadge
                status={STATUS_TONE_KEY[item.status]}
                label={t(`tasks.statuses.${item.status}`)}
              />
              {item.dueAt ? (
                <span className={cn(item.overdue && 'text-danger')}>
                  {t('inbox.dueIn', { date: formatDate(item.dueAt, { locale }) })}
                </span>
              ) : null}
            </span>
            <span className="text-sm text-fg">{item.title}</span>
            {item.assignee ? (
              <span className="text-xs text-fg-secondary">
                {t('tasks.row.assignee', { name: item.assignee.displayName })}
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  )
}
