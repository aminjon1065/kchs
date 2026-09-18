import type { ProjectRecord } from '@kchs/contracts'
import {
  Badge,
  EmptyState,
  ErrorState,
  InlineEdit,
  NoAccessState,
  ObjectIcon,
  PanelToolbar,
  Skeleton,
  UserChip,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError, http } from '~/shared/api/client.js'
import { objectQuery } from '~/shared/api/queries.js'
import { projectQuery, taskKeys } from './queries.js'
import { errorText } from './task-actions.js'
import { TasksScreen, type TasksScreenState } from './tasks-screen.js'

const STATUS_TONE = { active: 'accent', completed: 'success', archived: 'neutral' } as const

/**
 * Проект (10-tasks-projects.md §2): ключ, руководитель, счётчики и задачи
 * проекта — тот же экран задач со списком и доской, зафиксированный на проекте.
 */
export function ProjectView({
  objectId,
  tabId,
  savedState,
}: {
  objectId: string
  tabId: string
  savedState?: TasksScreenState
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const { data: object } = useQuery(objectQuery(objectId))
  const { data: project, error, isLoading, refetch } = useQuery(projectQuery(objectId))

  const rename = useMutation({
    mutationFn: (name: string) => http.patch<ProjectRecord>(`/projects/${objectId}`, { name }),
    onSuccess: (record) => {
      client.setQueryData(taskKeys.project(objectId), record)
      setTabTitle(tabId, record.name)
      void client.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (failure) => toast.error(errorText(failure, t('errors.unknown'))),
  })

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      return <NoAccessState />
    }
    return (
      <ErrorState description={errorText(error, t('errors.unknown'))} onRetry={() => refetch()} />
    )
  }
  if (!project) return <EmptyState title={t('common.states.notFound')} />

  const canManage = object ? ['manage', 'owner'].includes(object.level) : false
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ObjectIcon type="project" className="size-4 shrink-0 text-fg-muted" />
            <Badge tone="outline" size="sm">
              {project.key}
            </Badge>
            <InlineEdit
              value={project.name}
              disabled={!canManage}
              onSave={(next) => rename.mutate(next)}
              className="text-sm font-semibold text-fg"
              aria-label={t('tasks.projects.name')}
            />
            <Badge tone={STATUS_TONE[project.status]} size="sm">
              {t(`tasks.projects.statuses.${project.status}`)}
            </Badge>
          </>
        }
        right={
          <>
            <span className="tabular text-xs text-fg-muted">
              {t('tasks.projects.counts', {
                open: project.counts.open,
                overdue: project.counts.overdue,
                closed: project.counts.closed,
              })}
            </span>
            {project.lead ? <UserChip user={project.lead} /> : null}
            <PresenceAvatars objectId={objectId} />
          </>
        }
      />
      <div className="min-h-0 flex-1">
        <TasksScreen projectId={objectId} tabId={tabId} {...(savedState ? { savedState } : {})} />
      </div>
    </div>
  )
}
