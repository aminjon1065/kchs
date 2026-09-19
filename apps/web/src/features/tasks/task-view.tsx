import type { Locale, TaskRecord, TaskStatus } from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import {
  AlertDialog,
  Badge,
  Button,
  Callout,
  EmptyState,
  ErrorState,
  IconButton,
  InlineEdit,
  type KeyValueItem,
  KeyValueList,
  NoAccessState,
  ObjectChip,
  ObjectIcon,
  PanelToolbar,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  StatusBadge,
  UserChip,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Ban,
  CalendarClock,
  Check,
  CornerUpLeft,
  Gavel,
  Pencil,
  Play,
  Send,
  UserRoundCog,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { datasetQuery } from '~/features/data/queries.js'
import { RowCard } from '~/features/data/row-card.js'
import { TerritoryLink } from '~/features/gis/territory-link.js'
import { PresenceAvatars } from '~/features/objects/presence-avatars.js'
import { ApiError, http } from '~/shared/api/client.js'
import { meQuery, objectQuery } from '~/shared/api/queries.js'
import { taskKeys, taskQuery } from './queries.js'
import { errorText, postTaskStep, type TaskStep, useTaskInvalidation } from './task-actions.js'
import {
  EditTaskDialog,
  ExtensionDecisionDialog,
  ExtensionRequestDialog,
  ReassignDialog,
  ReportDialog,
  ReturnDialog,
} from './task-dialogs.js'
import { DueHistorySection, PartsSection, ResultObjects } from './task-sections.js'
import { STATUS_TONE_KEY } from './task-status.js'

type Dialog =
  | 'edit'
  | 'report'
  | 'return'
  | 'cancel'
  | 'row'
  | 'extend'
  | 'decide'
  | 'reassign'
  | null

/**
 * Карточка задачи или поручения (10-tasks-projects.md §5): кнопки по правам
 * смотрящего (принять, отчитаться, принять отчёт, вернуть), отчёт исполнителя,
 * замечания при возврате, участники, срок и источник — строка датасета.
 */
export function TaskView({ objectId, tabId }: { objectId: string; tabId: string }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const invalidate = useTaskInvalidation()
  const setTabTitle = useWorkspace((s) => s.setTabTitle)
  const openTab = useWorkspace((s) => s.openTab)
  const [dialog, setDialog] = useState<Dialog>(null)
  const { data: me } = useQuery(meQuery())
  const { data: task, error, isLoading, refetch } = useQuery(taskQuery(objectId))

  const step = useMutation({
    mutationFn: (next: TaskStep) => postTaskStep(objectId, next),
    onSuccess: (record, next) => {
      client.setQueryData(taskKeys.task(objectId), record)
      toast.show({ title: t(`tasks.done.${next.kind}`), tone: 'success' })
      invalidate(objectId)
    },
    onError: (failure) => toast.error(errorText(failure, t('errors.unknown'))),
  })

  const rename = useMutation({
    mutationFn: (title: string) => http.patch<TaskRecord>(`/tasks/${objectId}`, { title }),
    onSuccess: (record) => {
      client.setQueryData(taskKeys.task(objectId), record)
      setTabTitle(tabId, record.title)
      invalidate(objectId)
    },
    onError: (failure) => toast.error(errorText(failure, t('errors.unknown'))),
  })

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-7 w-80" />
        <Skeleton className="h-40 w-full" />
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
  if (!task) return <EmptyState title={t('common.states.notFound')} />

  const instruction = task.kind === 'instruction'
  const ctx = { locale, ...(me?.user.timezone ? { timezone: me.user.timezone } : {}) }
  const busy = step.isPending
  const openProject = () =>
    task.project &&
    openTab({
      kind: 'object',
      objectId: task.project.id,
      objectType: 'project',
      title: task.project.name,
      mode: 'permanent',
    })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        left={
          <>
            <ObjectIcon type="task" className="size-4 shrink-0 text-fg-muted" />
            <span className="shrink-0 font-mono text-xs text-fg-muted">{task.key}</span>
            <InlineEdit
              value={task.title}
              disabled={!task.can.edit}
              onSave={(next) => rename.mutate(next)}
              className="text-sm font-semibold text-fg"
              aria-label={t('tasks.fields.title')}
            />
            <StatusBadge
              status={STATUS_TONE_KEY[task.status]}
              label={t(`tasks.statuses.${task.status}`)}
            />
            {task.overdue ? (
              <Badge tone="danger" size="sm">
                {t('common.time.overdue')}
              </Badge>
            ) : null}
            {task.extensions > 0 ? (
              <Badge tone="warning" size="sm">
                {t('tasks.extended')}
              </Badge>
            ) : null}
          </>
        }
        right={
          <>
            <PresenceAvatars objectId={objectId} />
            {task.can.start ? (
              <Button
                variant="primary"
                size="sm"
                icon={<Play className="size-3.5" />}
                loading={busy}
                onClick={() => step.mutate({ kind: 'start' })}
              >
                {t('tasks.actions.start')}
              </Button>
            ) : null}
            {task.can.report ? (
              <Button
                variant="primary"
                size="sm"
                icon={<Send className="size-3.5" />}
                onClick={() => setDialog('report')}
              >
                {t('tasks.actions.report')}
              </Button>
            ) : null}
            {task.can.accept ? (
              <Button
                variant="primary"
                size="sm"
                icon={<Check className="size-3.5" />}
                loading={busy}
                onClick={() => step.mutate({ kind: 'accept' })}
              >
                {t('tasks.actions.accept')}
              </Button>
            ) : null}
            {task.can.return ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<CornerUpLeft className="size-3.5" />}
                onClick={() => setDialog('return')}
              >
                {t('tasks.actions.return')}
              </Button>
            ) : null}
            {task.can.decideExtension ? (
              <Button
                variant="primary"
                size="sm"
                icon={<Gavel className="size-3.5" />}
                onClick={() => setDialog('decide')}
              >
                {t('tasks.actions.decideExtension')}
              </Button>
            ) : null}
            {task.can.requestExtension ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<CalendarClock className="size-3.5" />}
                onClick={() => setDialog('extend')}
              >
                {t('tasks.actions.requestExtension')}
              </Button>
            ) : null}
            {task.can.reassign ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<UserRoundCog className="size-3.5" />}
                onClick={() => setDialog('reassign')}
              >
                {t('tasks.actions.reassign')}
              </Button>
            ) : null}
            {!instruction && task.can.transitions.length > 0 ? (
              <Select
                value={task.status}
                onValueChange={(status) =>
                  step.mutate({ kind: 'status', status: status as TaskStatus })
                }
                disabled={busy}
              >
                <SelectTrigger aria-label={t('tasks.fields.status')} className="h-7 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[task.status, ...task.can.transitions].map((status) => (
                    <SelectItem key={status} value={status}>
                      {t(`tasks.statuses.${status}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {task.can.edit ? (
              <IconButton label={t('common.actions.edit')} onClick={() => setDialog('edit')}>
                <Pencil className="size-4" />
              </IconButton>
            ) : null}
            {instruction && task.can.cancel ? (
              <IconButton
                label={t('tasks.actions.cancel')}
                variant="danger"
                onClick={() => setDialog('cancel')}
              >
                <Ban className="size-4" />
              </IconButton>
            ) : null}
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto bg-canvas">
        <div className="mx-auto grid max-w-[1100px] items-start gap-5 p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-4">
            <NextStep task={task} />
            {task.extension?.status === 'pending' ? (
              <Callout
                tone="warning"
                title={t('tasks.extension.pending', {
                  date: formatDate(task.extension.requestedDueAt, { locale }),
                })}
              >
                <span className="block whitespace-pre-line">{task.extension.reason}</span>
                <span className="mt-1 block text-xs text-fg-muted">
                  {t('tasks.extension.requestedBy', {
                    name: task.extension.requestedBy?.displayName ?? '—',
                    date: formatDateTime(task.extension.requestedAt, ctx),
                  })}
                </span>
              </Callout>
            ) : task.extension?.status === 'rejected' && !isClosedStatus(task.status) ? (
              <Callout tone="info" title={t('tasks.extension.rejectedTitle')}>
                <span className="block whitespace-pre-line">
                  {task.extension.decisionComment ?? ''}
                </span>
              </Callout>
            ) : null}
            {task.status === 'returned' && task.returnComment ? (
              <Callout tone="warning" title={t('tasks.view.returnComment')}>
                <span className="whitespace-pre-line">{task.returnComment}</span>
              </Callout>
            ) : null}
            <section className="rounded-lg border border-line bg-surface p-4">
              <h2 className="mb-2 text-sm font-semibold text-fg">
                {t('tasks.fields.description')}
              </h2>
              {task.description ? (
                <p className="whitespace-pre-line text-sm text-fg">{task.description}</p>
              ) : (
                <p className="text-sm text-fg-muted">{t('tasks.view.noDescription')}</p>
              )}
            </section>
            {task.result ? (
              <section className="rounded-lg border border-line bg-surface p-4">
                <h2 className="mb-2 text-sm font-semibold text-fg">{t('tasks.view.result')}</h2>
                <p className="whitespace-pre-line text-sm text-fg">{task.result.text}</p>
                <ResultObjects task={task} />
                <p className="mt-2 text-xs text-fg-muted">
                  {t('tasks.view.reportedBy', {
                    name: task.result.reportedBy?.displayName ?? '—',
                    date: formatDateTime(task.result.reportedAt, ctx),
                  })}
                </p>
              </section>
            ) : null}
            <PartsSection task={task} />
            <DueHistorySection task={task} ctx={ctx} />
          </div>

          <aside className="rounded-lg border border-line bg-surface p-4">
            <KeyValueList
              items={details(task, ctx, t, {
                openProject,
                openRow: () => setDialog('row'),
                openTask: (id, title) =>
                  openTab({
                    kind: 'object',
                    objectId: id,
                    objectType: 'task',
                    title,
                    mode: 'permanent',
                  }),
              })}
            />
          </aside>
        </div>
      </div>

      {dialog === 'edit' ? <EditTaskDialog task={task} onClose={() => setDialog(null)} /> : null}
      {dialog === 'report' ? <ReportDialog task={task} onClose={() => setDialog(null)} /> : null}
      {dialog === 'return' ? <ReturnDialog task={task} onClose={() => setDialog(null)} /> : null}
      {dialog === 'extend' ? (
        <ExtensionRequestDialog task={task} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'decide' ? (
        <ExtensionDecisionDialog task={task} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'reassign' ? (
        <ReassignDialog task={task} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'row' && task.source?.kind === 'dataset_row' ? (
        <SourceRow
          datasetId={task.source.datasetId}
          rowId={task.source.rowId}
          onClose={() => setDialog(null)}
        />
      ) : null}
      <AlertDialog
        open={dialog === 'cancel'}
        onOpenChange={(open) => setDialog(open ? 'cancel' : null)}
        title={t('tasks.cancel.title', { key: task.key })}
        description={t('tasks.cancel.body')}
        confirmLabel={t('tasks.actions.cancel')}
        destructive
        loading={busy}
        onConfirm={() => {
          step.mutate({ kind: 'cancel' })
          setDialog(null)
        }}
      />
    </div>
  )
}

const isClosedStatus = (status: TaskRecord['status']) =>
  status === 'accepted' || status === 'done' || status === 'cancelled'

/** Подсказка «что дальше» для смотрящего: его ход в процессе поручения. */
function NextStep({ task }: { task: TaskRecord }) {
  const t = useT()
  if (task.kind !== 'instruction') return null
  const openParts = task.parts.filter((part) => !isClosedStatus(part.status)).length
  const key = task.can.decideExtension
    ? 'decideExtension'
    : task.can.start
      ? 'start'
      : task.can.report && openParts > 0
        ? 'partsOpen'
        : task.can.report
          ? 'report'
          : task.can.accept
            ? 'accept'
            : task.extension?.status === 'pending'
              ? 'extensionPending'
              : task.status === 'reported'
                ? 'waitAccept'
                : null
  if (!key) return null
  return <Callout tone="info">{t(`tasks.next.${key}`, { count: openParts })}</Callout>
}

type Translate = ReturnType<typeof useT>

function details(
  task: TaskRecord,
  ctx: { locale: Locale; timezone?: string },
  t: Translate,
  actions: {
    openProject: () => void
    openRow: () => void
    openTask: (id: string, title: string) => void
  },
): KeyValueItem[] {
  const items: KeyValueItem[] = [
    { key: 'kind', label: t('tasks.fields.kind'), value: t(`tasks.kinds.${task.kind}`) },
    {
      key: 'priority',
      label: t('tasks.fields.priority'),
      value: t(`tasks.priorities.p${task.priority}`),
    },
    {
      key: 'assignee',
      label: t('tasks.fields.assignee'),
      value: task.assignee ? <UserChip user={task.assignee} /> : '—',
    },
  ]
  if (task.coAssignees.length > 0) {
    items.push({
      key: 'coAssignees',
      label: t('tasks.fields.coAssignees'),
      value: (
        <span className="flex flex-wrap gap-2">
          {task.coAssignees.map((user) => (
            <UserChip key={user.id} user={user} />
          ))}
        </span>
      ),
    })
  }
  if (task.kind === 'instruction') {
    items.push({
      key: 'controller',
      label: t('tasks.fields.controller'),
      value: task.controller ? <UserChip user={task.controller} /> : '—',
    })
  }
  items.push(
    {
      key: 'author',
      label: t('tasks.fields.author'),
      value: task.author ? <UserChip user={task.author} /> : '—',
    },
    {
      key: 'due',
      label: t('tasks.fields.due'),
      value: task.dueAt ? (
        // Срок — день по часам пользователя: так его выбирают в поле даты
        <span className={task.overdue ? 'text-danger' : undefined}>
          {formatDate(task.dueAt, { locale: ctx.locale })}
          {task.dueWorkingDays !== null ? (
            <span className="ml-1.5 text-xs text-fg-muted">
              {t('tasks.due.workingDaysShort', { count: task.dueWorkingDays })}
            </span>
          ) : null}
        </span>
      ) : (
        '—'
      ),
    },
  )
  if (task.originalDueAt && task.dueAt && task.originalDueAt !== task.dueAt) {
    items.push({
      key: 'originalDue',
      label: t('tasks.fields.originalDue'),
      value: formatDate(task.originalDueAt, { locale: ctx.locale }),
    })
  }
  if (task.parent) {
    const parent = task.parent
    items.push({
      key: 'parent',
      label: t('tasks.fields.parent'),
      value: (
        <Button variant="link" size="sm" onClick={() => actions.openTask(parent.id, parent.title)}>
          {parent.key} · {parent.title}
        </Button>
      ),
    })
  }
  if (task.project) {
    const project = task.project
    items.push({
      key: 'project',
      label: t('tasks.fields.project'),
      value: (
        <Button variant="link" size="sm" onClick={actions.openProject}>
          {project.key} · {project.name}
        </Button>
      ),
    })
  }
  if (task.territoryId) {
    items.push({
      key: 'territory',
      label: t('tasks.fields.territory'),
      value: <TerritoryLink id={task.territoryId} />,
    })
  }
  if (task.source) {
    const source = task.source
    items.push({
      key: 'source',
      label: t('tasks.fields.source'),
      value:
        source.kind === 'dataset_row' ? (
          <Button variant="link" size="sm" onClick={actions.openRow}>
            {source.label ?? t('tasks.view.row', { id: source.rowId })}
          </Button>
        ) : (
          <SourceObject objectId={source.objectId} />
        ),
    })
  }
  items.push({
    key: 'created',
    label: t('tasks.fields.created'),
    value: formatDateTime(task.createdAt, ctx),
  })
  if (task.startedAt) {
    items.push({
      key: 'started',
      label: t('tasks.fields.started'),
      value: formatDateTime(task.startedAt, ctx),
    })
  }
  if (task.completedAt) {
    items.push({
      key: 'completed',
      label: t('tasks.fields.completed'),
      value: formatDateTime(task.completedAt, ctx),
    })
  }
  return items
}

/** Источник — объект реестра: чип с переходом, если он виден смотрящему. */
function SourceObject({ objectId }: { objectId: string }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const { data: object, error } = useQuery(objectQuery(objectId))
  if (error) return <span className="text-fg-muted">{t('tasks.view.sourceHidden')}</span>
  if (!object) return <Skeleton className="h-5 w-32" />
  return (
    <ObjectChip
      object={{ id: object.id, type: object.type, title: object.title }}
      onOpen={(item) =>
        openTab({
          kind: 'object',
          objectId: item.id,
          objectType: item.type,
          title: item.title,
          mode: 'permanent',
        })
      }
    />
  )
}

/**
 * Строка-источник в карточке строки (только чтение). Датасет не виден
 * смотрящему — сообщение вместо карточки: поручение не расширяет доступ к данным.
 */
function SourceRow({
  datasetId,
  rowId,
  onClose,
}: {
  datasetId: string
  rowId: string
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const { data: dataset, error } = useQuery(datasetQuery(datasetId))

  useEffect(() => {
    if (!error) return
    toast.error(t('tasks.view.sourceHidden'))
    onClose()
  }, [error, onClose, t, toast])

  if (!dataset) return null
  return (
    <RowCard dataset={dataset} rowId={rowId} canEdit={false} onClose={onClose} onChanged={noop} />
  )
}

function noop(): void {}
