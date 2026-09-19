import type { Locale, TaskListItem } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import {
  Button,
  DataTable,
  type DataTableColumn,
  EmptyState,
  SegmentedControl,
  Skeleton,
  StatusBadge,
} from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { tasksQuery } from '../../tasks/queries.js'
import { CreateTaskDialog } from '../../tasks/task-dialogs.js'
import { STATUS_TONE_KEY } from '../../tasks/task-status.js'
import { TerritoryLink } from '../territory-link.js'

type State = 'open' | 'all'

/**
 * Вкладка «Поручения» паспорта: задачи и поручения с этой территорией и
 * вложенными единицами, видимые смотрящему; новое поручение — с территорией.
 */
export function PassportTasks({ territoryId }: { territoryId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale) as Locale
  const openTab = useWorkspace((s) => s.openTab)
  const [state, setState] = useState<State>('open')
  const [creating, setCreating] = useState(false)
  const { data, isLoading } = useQuery(tasksQuery({ scope: 'all', territoryId, state, limit: 200 }))

  const columns: Array<DataTableColumn<TaskListItem>> = [
    { key: 'key', header: t('tasks.fields.key'), width: 110, cell: (task) => task.key },
    { key: 'title', header: t('tasks.fields.title'), width: 320, cell: (task) => task.title },
    {
      key: 'status',
      header: t('tasks.fields.status'),
      width: 150,
      cell: (task) => (
        <StatusBadge
          status={STATUS_TONE_KEY[task.status]}
          label={t(`tasks.statuses.${task.status}`)}
        />
      ),
    },
    {
      key: 'assignee',
      header: t('tasks.fields.assignee'),
      width: 180,
      cell: (task) => task.assignee?.displayName ?? '—',
    },
    {
      key: 'due',
      header: t('tasks.fields.due'),
      width: 120,
      cell: (task) =>
        task.dueAt ? (
          <span className={task.overdue ? 'text-danger' : undefined}>
            {formatDate(task.dueAt, { locale })}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'territory',
      header: t('tasks.fields.territory'),
      width: 180,
      cell: (task) => <TerritoryLink id={task.territoryId} />,
    },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          aria-label={t('gis.passport.tasksState')}
          value={state}
          onValueChange={setState}
          options={[
            { value: 'open', label: t('gis.passport.tasksStates.open') },
            { value: 'all', label: t('gis.passport.tasksStates.all') },
          ]}
        />
        <Button
          size="sm"
          variant="primary"
          className="ml-auto"
          icon={<Plus className="size-3.5" />}
          onClick={() => setCreating(true)}
        >
          {t('gis.passport.newInstruction')}
        </Button>
      </div>
      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <DataTable
          rows={data?.items ?? []}
          getRowId={(task) => task.id}
          columns={columns}
          className="h-72"
          aria-label={t('gis.passport.tabs.tasks')}
          onRowOpen={(task) =>
            openTab({
              kind: 'object',
              objectId: task.id,
              objectType: 'task',
              title: task.title,
              mode: 'permanent',
            })
          }
          onRowClick={(task) =>
            openTab({
              kind: 'object',
              objectId: task.id,
              objectType: 'task',
              title: task.title,
              mode: 'preview',
            })
          }
          empty={<EmptyState compact title={t('gis.passport.noTasks')} />}
        />
      )}
      {creating ? (
        <CreateTaskDialog
          draft={{ kind: 'instruction', territoryId }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </div>
  )
}
