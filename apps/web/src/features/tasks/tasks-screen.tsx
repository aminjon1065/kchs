import {
  TASK_STATUS_CATEGORY,
  type TaskList,
  type TaskListItem,
  type TaskListQuery,
  type TaskScope,
  type TaskStatus,
  type TaskStatusCategory,
} from '@kchs/contracts'
import { formatDate, formatPercent } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  cn,
  DataTable,
  type DataTableColumn,
  EmptyState,
  KanbanBoard,
  PanelToolbar,
  SearchInput,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatTile,
  StatusBadge,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckSquare,
  ClipboardCheck,
  FolderKanban,
  LayoutList,
  Plus,
  Repeat,
  SquareKanban,
  Users,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { projectsQuery, taskKeys, taskSummaryQuery, tasksQuery } from './queries.js'
import { errorText, postTaskStep, type TaskStep, useTaskInvalidation } from './task-actions.js'
import { ProgressMark } from './task-checklist.js'
import {
  CreateProjectDialog,
  CreateTaskDialog,
  ReportDialog,
  type TaskDraft,
} from './task-dialogs.js'
import { SeriesDialog } from './task-series.js'
import { ACTION_STATUS, BOARD_COLUMNS, boardMove, STATUS_TONE_KEY } from './task-status.js'

type Mode = 'list' | 'board'
type State = TaskListQuery['state']

const ALL_PROJECTS = '__all'
const SCOPES: TaskScope[] = ['mine', 'assigned_by_me', 'controlled', 'team', 'all']

export interface TasksScreenState {
  scope?: TaskScope
  state?: State
  projectId?: string
  mode?: Mode
}

/**
 * Задачи и поручения (10-tasks-projects.md §5): «Мои», «Поручил я», «На
 * контроле», все доступные; фильтр по проекту; список и доска по статусам —
 * перенос карточки выполняет разрешённый переход (у поручения — действие).
 * В проекте экран встроен в карточку проекта с зафиксированным проектом.
 */
export function TasksScreen({
  projectId: fixedProjectId,
  tabId,
  savedState,
}: {
  projectId?: string
  tabId?: string
  savedState?: TasksScreenState
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const invalidate = useTaskInvalidation()
  const openTab = useWorkspace((s) => s.openTab)
  const setTabState = useWorkspace((s) => s.setTabState)

  const [scope, setScope] = useState<TaskScope>(
    savedState?.scope ?? (fixedProjectId ? 'all' : 'mine'),
  )
  const [state, setState] = useState<State>(savedState?.state ?? 'open')
  const [project, setProject] = useState<string>(savedState?.projectId ?? ALL_PROJECTS)
  const [mode, setMode] = useState<Mode>(savedState?.mode ?? 'list')
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState<TaskDraft | null>(null)
  const [creatingProject, setCreatingProject] = useState(false)
  const [seriesOpen, setSeriesOpen] = useState(false)
  const [reporting, setReporting] = useState<TaskListItem | null>(null)
  const q = useDebouncedValue(search.trim(), 250)

  useEffect(() => {
    if (tabId) setTabState(tabId, { scope, state, projectId: project, mode })
  }, [tabId, scope, state, project, mode, setTabState])

  const projectId = fixedProjectId ?? (project === ALL_PROJECTS ? undefined : project)
  // Доска показывает и закрытые: перенос в «Готово» не должен прятать карточку
  const query: Partial<TaskListQuery> = {
    scope,
    state: mode === 'board' ? 'all' : state,
    ...(projectId ? { projectId } : {}),
    ...(q ? { q } : {}),
  }
  const { data, isLoading } = useQuery(tasksQuery(query))
  const { data: summary } = useQuery({ ...taskSummaryQuery(), enabled: !fixedProjectId })
  const { data: projects = [] } = useQuery({ ...projectsQuery(), enabled: !fixedProjectId })
  const items = data?.items ?? []

  const open = (item: TaskListItem, how: 'preview' | 'permanent' = 'permanent') =>
    openTab({
      kind: 'object',
      objectId: item.id,
      objectType: 'task',
      title: item.title,
      mode: how,
    })

  const move = useMutation({
    mutationFn: ({ item, step }: { item: TaskListItem; step: TaskStep; status: TaskStatus }) =>
      postTaskStep(item.id, step),
    onMutate: ({ item, status }) => {
      // Карточка переезжает сразу; ответ сервера или ошибка вернут правду
      client.setQueryData<TaskList>(taskKeys.list(query), (current) =>
        current
          ? {
              ...current,
              items: current.items.map((row) => (row.id === item.id ? { ...row, status } : row)),
            }
          : current,
      )
    },
    onSuccess: (_record, { step }) => {
      toast.show({ title: t(`tasks.done.${step.kind}`), tone: 'success' })
    },
    onError: (failure) => toast.error(errorText(failure, t('errors.unknown'))),
    onSettled: (_record, _error, { item }) => invalidate(item.id),
  })

  const onMove = (item: TaskListItem, column: string) => {
    const next = boardMove(item, column as TaskStatusCategory)
    if (!next) return
    if (next.kind === 'status') {
      move.mutate({ item, step: { kind: 'status', status: next.status }, status: next.status })
    } else if (next.action === 'report') {
      // Отчёт — всегда с текстом: перенос открывает форму
      setReporting(item)
    } else {
      move.mutate({ item, step: { kind: next.action }, status: ACTION_STATUS[next.action] })
    }
  }

  const person = (user: TaskListItem['assignee']) =>
    user ? (
      <span className="flex min-w-0 items-center gap-1.5">
        <Avatar name={user.displayName} src={user.avatarUrl} size="xs" />
        <span className="truncate">{user.displayName}</span>
      </span>
    ) : (
      <span className="text-fg-muted">—</span>
    )
  const due = (item: TaskListItem) =>
    item.dueAt ? (
      <span className={cn('tabular', item.overdue ? 'text-danger' : 'text-fg-secondary')}>
        {formatDate(item.dueAt, { locale })}
      </span>
    ) : (
      <span className="text-fg-muted">—</span>
    )
  const status = (item: TaskListItem) => (
    <StatusBadge status={STATUS_TONE_KEY[item.status]} label={t(`tasks.statuses.${item.status}`)} />
  )

  const columns: Array<DataTableColumn<TaskListItem>> = [
    {
      key: 'title',
      header: t('tasks.fields.title'),
      minWidth: 260,
      cell: (item) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-xs text-fg-muted">{item.key}</span>
          {item.kind === 'instruction' ? (
            <Badge tone="purple" size="sm">
              {t('tasks.kinds.instruction')}
            </Badge>
          ) : null}
          {item.kind === 'subtask' ? (
            <Badge tone="neutral" size="sm">
              {t('tasks.kinds.subtask')}
            </Badge>
          ) : null}
          <span className="truncate">{item.title}</span>
          <ProgressMark progress={item.checklistProgress} kind="checklist" />
          <ProgressMark progress={item.subtaskProgress} kind="subtasks" />
          {item.extensions > 0 ? (
            <Badge tone="warning" size="sm">
              {t('tasks.extended')}
            </Badge>
          ) : null}
        </span>
      ),
    },
    { key: 'status', header: t('tasks.fields.status'), width: 170, cell: status },
    {
      key: 'assignee',
      header: t('tasks.fields.assignee'),
      width: 190,
      cell: (item) => person(item.assignee),
    },
    {
      key: 'author',
      header: t('tasks.fields.author'),
      width: 190,
      cell: (item) => person(item.author),
    },
    { key: 'due', header: t('tasks.fields.due'), width: 120, cell: due },
    {
      key: 'priority',
      header: t('tasks.fields.priority'),
      width: 100,
      cell: (item) => t(`tasks.priorities.short${item.priority}`),
    },
    {
      key: 'project',
      header: t('tasks.fields.project'),
      width: 120,
      cell: (item) => item.project?.key ?? <span className="text-fg-muted">—</span>,
    },
  ]

  const createDraft = (kind: 'task' | 'instruction'): TaskDraft => ({
    kind,
    ...(projectId ? { projectId } : {}),
  })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          fixedProjectId ? (
            <SegmentedControl
              size="sm"
              aria-label={t('tasks.scopeLabel')}
              value={scope}
              onValueChange={setScope}
              options={SCOPES.map((value) => ({ value, label: t(`tasks.scopes.${value}`) }))}
            />
          ) : (
            <>
              <h1 className="text-sm font-semibold text-fg">{t('tasks.title')}</h1>
              <SegmentedControl
                size="sm"
                aria-label={t('tasks.scopeLabel')}
                value={scope}
                onValueChange={setScope}
                options={SCOPES.map((value) => ({ value, label: t(`tasks.scopes.${value}`) }))}
              />
            </>
          )
        }
        right={
          <>
            {fixedProjectId ? null : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<ClipboardCheck className="size-3.5" />}
                  onClick={() =>
                    openTab({
                      kind: 'screen',
                      screen: 'control',
                      title: t('tasks.control.title'),
                      icon: 'task',
                      mode: 'permanent',
                    })
                  }
                >
                  {t('tasks.control.open')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Users className="size-3.5" />}
                  onClick={() =>
                    openTab({
                      kind: 'screen',
                      screen: 'workload',
                      title: t('tasks.workload.title'),
                      icon: 'user',
                      mode: 'permanent',
                    })
                  }
                >
                  {t('tasks.workload.title')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<FolderKanban className="size-3.5" />}
                  onClick={() => setCreatingProject(true)}
                >
                  {t('tasks.projects.create')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Repeat className="size-3.5" />}
                  onClick={() => setSeriesOpen(true)}
                >
                  {t('tasks.series.title')}
                </Button>
              </>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() => setCreating(createDraft('task'))}
            >
              {t('tasks.kinds.task')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="size-3.5" />}
              onClick={() => setCreating(createDraft('instruction'))}
            >
              {t('tasks.kinds.instruction')}
            </Button>
          </>
        }
      />

      {fixedProjectId ? null : (
        <div className="grid shrink-0 grid-cols-2 gap-3 border-b border-line bg-canvas p-3 sm:grid-cols-5">
          <StatTile label={t('tasks.summary.open')} value={summary?.open ?? 0} />
          <StatTile label={t('tasks.summary.overdue')} value={summary?.overdue ?? 0} />
          <StatTile label={t('tasks.summary.dueToday')} value={summary?.dueToday ?? 0} />
          <StatTile
            label={t('tasks.summary.toAccept')}
            value={summary?.toAccept ?? 0}
            onClick={() => setScope('assigned_by_me')}
          />
          <StatTile
            label={t('tasks.summary.onTime')}
            value={
              summary?.onTimeRate === null || summary?.onTimeRate === undefined
                ? '—'
                : formatPercent(summary.onTimeRate, { precision: 0 }, { locale })
            }
          />
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2.5 py-2">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t('tasks.searchPlaceholder')}
          aria-label={t('tasks.searchPlaceholder')}
          className="w-64"
        />
        {fixedProjectId ? null : (
          <Select value={project} onValueChange={setProject}>
            <SelectTrigger aria-label={t('tasks.fields.project')} className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROJECTS}>{t('tasks.allProjects')}</SelectItem>
              {projects.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.key} · {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {mode === 'list' ? (
          <SegmentedControl
            size="sm"
            aria-label={t('tasks.stateLabel')}
            value={state}
            onValueChange={setState}
            options={(['open', 'closed', 'all'] as const).map((value) => ({
              value,
              label: t(`tasks.states.${value}`),
            }))}
          />
        ) : null}
        <span className="ml-auto tabular text-xs text-fg-muted">
          {data && data.total > items.length
            ? t('tasks.shown', { count: items.length, total: data.total })
            : t('tasks.count', { count: data?.total ?? 0 })}
        </span>
        <SegmentedControl
          size="sm"
          aria-label={t('tasks.viewLabel')}
          value={mode}
          onValueChange={setMode}
          options={[
            {
              value: 'list',
              label: t('tasks.views.list'),
              icon: <LayoutList className="size-3.5" aria-hidden />,
            },
            {
              value: 'board',
              label: t('tasks.views.board'),
              icon: <SquareKanban className="size-3.5" aria-hidden />,
            },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1">
        {!isLoading && items.length === 0 ? (
          <EmptyState
            icon={<CheckSquare />}
            title={t(q ? 'common.states.nothingFound' : 'tasks.empty')}
            description={q ? undefined : t(`tasks.emptyHint.${scope}`)}
            action={
              q ? undefined : (
                <Button variant="primary" onClick={() => setCreating(createDraft('instruction'))}>
                  {t('tasks.create.instructionTitle')}
                </Button>
              )
            }
          />
        ) : mode === 'list' ? (
          <DataTable
            aria-label={t('tasks.title')}
            rows={items}
            getRowId={(item) => item.id}
            columns={columns}
            loading={isLoading}
            onRowClick={(item) => open(item, 'preview')}
            onRowOpen={(item) => open(item)}
          />
        ) : (
          <KanbanBoard
            aria-label={t('tasks.views.board')}
            columns={BOARD_COLUMNS.map((key) => ({ key, title: t(`tasks.columns.${key}`) }))}
            items={items.filter((item) => item.status !== 'cancelled')}
            getItemId={(item) => item.id}
            getColumnKey={(item) => TASK_STATUS_CATEGORY[item.status]}
            canMove={(item, column) => boardMove(item, column as TaskStatusCategory) !== null}
            onMove={onMove}
            onCardOpen={(item) => open(item)}
            renderCard={(item) => (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2 text-2xs text-fg-muted">
                  <span className="font-mono">{item.key}</span>
                  {item.kind === 'instruction' ? (
                    <Badge tone="purple" size="sm">
                      {t('tasks.kinds.instruction')}
                    </Badge>
                  ) : null}
                  <span className="ml-auto">{t(`tasks.priorities.short${item.priority}`)}</span>
                </div>
                <div className="line-clamp-3 text-sm text-fg">{item.title}</div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {status(item)}
                  <ProgressMark progress={item.checklistProgress} kind="checklist" />
                  <ProgressMark progress={item.subtaskProgress} kind="subtasks" />
                  {item.assignee ? (
                    <Avatar
                      name={item.assignee.displayName}
                      src={item.assignee.avatarUrl}
                      size="xs"
                    />
                  ) : null}
                  {due(item)}
                </div>
              </div>
            )}
          />
        )}
      </div>

      {creating ? <CreateTaskDialog draft={creating} onClose={() => setCreating(null)} /> : null}
      {creatingProject ? <CreateProjectDialog onClose={() => setCreatingProject(false)} /> : null}
      {seriesOpen ? <SeriesDialog onClose={() => setSeriesOpen(false)} /> : null}
      {reporting ? <ReportDialog task={reporting} onClose={() => setReporting(null)} /> : null}
    </div>
  )
}
