import type { DocumentResolutions, Locale, ResolutionRecord, TaskListItem } from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import {
  Avatar,
  Badge,
  Button,
  cn,
  EmptyState,
  ErrorState,
  IconButton,
  Skeleton,
  StatusBadge,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CornerDownRight, GitBranch, Send, Stamp, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useObjectActions } from '~/app/workspace/object-actions.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { STATUS_TONE_KEY } from '~/features/tasks/task-status.js'
import { http } from '~/shared/api/client.js'
import { documentKeys, resolutionsQuery } from '../queries.js'
import { errorText } from '../status.js'
import { useDocument } from './document-context.js'
import {
  NoExecutionDialog,
  ResolutionDialog,
  ResolutionRequestDialog,
} from './resolution-dialogs.js'

type OpenDialog =
  | { kind: 'resolve'; parent: ResolutionRecord | null }
  | { kind: 'request' }
  | { kind: 'no_execution' }

/** Дата срока (`ГГГГ-ММ-ДД`) — полдень этого дня: та же дата в любом поясе. */
const dayOf = (day: string, locale: Locale) => formatDate(`${day}T12:00:00`, { locale })

/**
 * Вкладка «Резолюции и поручения» (03-screens.md §12, 08-documents.md §6,
 * ADR-0084): направления на резолюцию, резолюции деревом (вложенные — под
 * родительской) с поручениями и их состоянием, действия — наложить резолюцию,
 * направить или переадресовать, «не требует исполнения». Действие дела
 * Входящих «Наложить резолюцию» открывает здесь форму.
 */
export function ResolutionsTab() {
  const t = useT()
  const { document } = useDocument()
  const { data, isLoading, error, refetch } = useQuery(resolutionsQuery(document.id))
  const pendingAction = useObjectActions((s) => s.pending[document.id] ?? null)
  const takeAction = useObjectActions((s) => s.take)
  const [dialog, setDialog] = useState<OpenDialog | null>(null)

  // Намерение из Входящих: форма резолюции — когда права уже известны
  useEffect(() => {
    if (pendingAction !== 'resolve' || !data) return
    takeAction(document.id)
    if (data.can.resolve || data.can.resolveOnBehalf) setDialog({ kind: 'resolve', parent: null })
  }, [pendingAction, data, document.id, takeAction])

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }
  if (error || !data) {
    return <ErrorState description={errorText(error, t('errors.unknown'))} onRetry={refetch} />
  }

  const allowed = document.type.settings.allowResolutions
  const children = new Map<string | null, ResolutionRecord[]>()
  for (const item of data.items) {
    children.set(item.parentId, [...(children.get(item.parentId) ?? []), item])
  }
  const roots = children.get(null) ?? []
  const { can } = data

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        {can.resolve || can.resolveOnBehalf ? (
          <Button
            variant="primary"
            size="sm"
            icon={<Stamp className="size-3.5" />}
            onClick={() => setDialog({ kind: 'resolve', parent: null })}
          >
            {t(can.resolve ? 'documents.resolutions.add' : 'documents.resolutions.addOnBehalf')}
          </Button>
        ) : null}
        {can.request ? (
          <Button
            variant="secondary"
            size="sm"
            icon={<Send className="size-3.5" />}
            onClick={() => setDialog({ kind: 'request' })}
          >
            {t('documents.resolutions.request')}
          </Button>
        ) : null}
        {can.noExecution ? (
          <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'no_execution' })}>
            {t('documents.resolutions.noExecution')}
          </Button>
        ) : null}
      </div>

      {data.requests.length > 0 ? <Requests view={data} /> : null}

      {roots.length === 0 ? (
        <EmptyState
          icon={<GitBranch />}
          title={t('documents.resolutions.empty')}
          description={t(
            !allowed
              ? 'documents.resolutions.notAllowed'
              : document.status === 'draft'
                ? 'documents.resolutions.notRegistered'
                : 'documents.resolutions.emptyHint',
          )}
        />
      ) : (
        <section aria-label={t('documents.resolutions.title')} className="flex flex-col gap-3">
          {roots.map((item) => (
            <ResolutionNode
              key={item.id}
              item={item}
              branches={children}
              onNest={(parent) => setDialog({ kind: 'resolve', parent })}
            />
          ))}
        </section>
      )}

      {dialog?.kind === 'resolve' ? (
        <ResolutionDialog
          document={document}
          view={data}
          parent={dialog.parent}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'request' ? (
        <ResolutionRequestDialog document={document} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'no_execution' ? (
        <NoExecutionDialog document={document} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  )
}

/** Направления на резолюцию: кому, кем и когда, состояние; делопроизводитель снимает. */
function Requests({ view }: { view: DocumentResolutions }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const { document } = useDocument()
  const cancel = useMutation({
    mutationFn: (requestId: string) =>
      http.delete<DocumentResolutions>(
        `/documents/${document.id}/resolution-requests/${requestId}`,
      ),
    onSuccess: (next) => {
      client.setQueryData(documentKeys.resolutions(document.id), next)
      toast.show({ title: t('documents.resolutions.requestCancelled'), tone: 'success' })
    },
    onError: (error) => toast.error(errorText(error, t('errors.unknown'))),
  })
  return (
    <section
      aria-label={t('documents.resolutions.requests')}
      className="flex flex-col gap-1.5 rounded-md border border-line bg-surface p-3"
    >
      <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
        {t('documents.resolutions.requests')}
      </h2>
      <ul className="flex flex-col gap-1.5">
        {view.requests.map((request) => (
          <li key={request.id} className="flex items-start gap-2 text-sm">
            <Avatar name={request.user.displayName} src={request.user.avatarUrl} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-fg">{request.user.displayName}</span>
                <Badge
                  size="sm"
                  tone={request.state === 'open' ? 'accent' : 'neutral'}
                  title={t(`documents.resolutions.requestStates.${request.state}`)}
                >
                  {t(`documents.resolutions.requestStates.${request.state}`)}
                </Badge>
                {request.dueDate ? (
                  <span className="text-xs text-fg-secondary">
                    {t('documents.resolutions.dueUntil', { date: dayOf(request.dueDate, locale) })}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-fg-muted">
                {t('documents.resolutions.requestedBy', {
                  name: request.requestedBy?.displayName ?? t('documents.resolutions.system'),
                  date: formatDateTime(request.requestedAt, { locale }),
                })}
              </p>
              {request.note ? (
                <p className="whitespace-pre-line text-xs text-fg-secondary">{request.note}</p>
              ) : null}
              {request.comment && request.comment !== request.note ? (
                <p className="whitespace-pre-line text-xs text-fg-secondary">{request.comment}</p>
              ) : null}
            </div>
            {request.state === 'open' && view.can.resolveOnBehalf ? (
              <IconButton
                size="sm"
                label={t('documents.resolutions.requestCancel')}
                onClick={() => cancel.mutate(request.id)}
                disabled={cancel.isPending}
              >
                <X className="size-3.5" />
              </IconButton>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

function ResolutionNode({
  item,
  branches,
  onNest,
  depth = 0,
}: {
  item: ResolutionRecord
  branches: Map<string | null, ResolutionRecord[]>
  onNest: (parent: ResolutionRecord) => void
  depth?: number
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const nested = branches.get(item.id) ?? []
  const done = item.total > 0 && item.open === 0
  return (
    <div className={cn('flex flex-col gap-3', depth > 0 && 'border-l-2 border-line pl-4')}>
      <article
        aria-label={t('documents.resolutions.from', {
          date: formatDateTime(item.createdAt, { locale }),
        })}
        className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3"
      >
        <header className="flex flex-wrap items-center gap-2">
          {depth > 0 ? <CornerDownRight className="size-3.5 text-fg-muted" /> : null}
          <Avatar name={item.author.displayName} src={item.author.avatarUrl} size="sm" />
          <span className="text-sm font-medium text-fg">{item.author.displayName}</span>
          <span className="text-xs text-fg-muted">
            {t('documents.resolutions.from', {
              date: formatDateTime(item.createdAt, { locale }),
            })}
          </span>
          {item.enteredBy ? (
            <span className="text-xs text-fg-muted">
              {t('documents.resolutions.enteredBy', { name: item.enteredBy.displayName })}
            </span>
          ) : null}
          <span className="flex-1" />
          {item.control ? (
            <Badge size="sm" tone="purple">
              {t('documents.controls.on')}
            </Badge>
          ) : null}
          <Badge size="sm" tone={done ? 'success' : 'neutral'}>
            {done
              ? t('documents.resolutions.allDone')
              : t('documents.resolutions.progress', { open: item.open, total: item.total })}
          </Badge>
        </header>
        <p className="whitespace-pre-line text-sm text-fg">{item.text}</p>
        <dl className="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-xs text-fg-muted">{t('documents.resolutions.responsible')}</dt>
          <dd className="text-fg">{item.responsible.displayName}</dd>
          {item.coExecutors.length > 0 ? (
            <>
              <dt className="text-xs text-fg-muted">{t('documents.resolutions.coExecutors')}</dt>
              <dd className="text-fg">
                {item.coExecutors.map((user) => user.displayName).join(', ')}
              </dd>
            </>
          ) : null}
          <dt className="text-xs text-fg-muted">{t('documents.resolutions.due')}</dt>
          <dd className="text-fg">
            {dayOf(item.dueDate, locale)}
            {item.dueWorkingDays ? (
              <span className="text-fg-muted">
                {' '}
                ({t('documents.resolutions.dueWorkingDays', { days: item.dueWorkingDays })})
              </span>
            ) : null}
          </dd>
          {item.controller ? (
            <>
              <dt className="text-xs text-fg-muted">{t('documents.resolutions.controller')}</dt>
              <dd className="text-fg">{item.controller.displayName}</dd>
            </>
          ) : null}
        </dl>
        {item.instructions.length > 0 ? (
          <ul aria-label={t('documents.resolutions.instructions')} className="flex flex-col gap-1">
            {item.instructions.map((task) => (
              <InstructionRow key={task.id} task={task} />
            ))}
          </ul>
        ) : null}
        {item.canNest ? (
          <div>
            <Button variant="ghost" size="sm" onClick={() => onNest(item)}>
              {t('documents.resolutions.nested')}
            </Button>
          </div>
        ) : null}
      </article>
      {nested.map((child) => (
        <ResolutionNode
          key={child.id}
          item={child}
          branches={branches}
          onNest={onNest}
          depth={depth + 1}
        />
      ))}
    </div>
  )
}

/** Поручение резолюции: номер, исполнитель, срок, статус — щелчок открывает поручение. */
function InstructionRow({ task }: { task: TaskListItem }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  return (
    <li>
      <button
        type="button"
        onClick={() =>
          openTab({
            kind: 'object',
            objectId: task.id,
            objectType: 'task',
            title: task.title,
            mode: 'preview',
          })
        }
        className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left text-sm hover:bg-surface-3"
      >
        <span className="font-mono text-xs text-fg-muted">{task.key}</span>
        <span className="min-w-0 flex-1 truncate text-fg">
          {task.assignee?.displayName ?? t('documents.resolutions.noAssignee')}
        </span>
        {task.parentId ? (
          <Badge size="sm" tone="neutral">
            {t('documents.resolutions.part')}
          </Badge>
        ) : null}
        {task.dueAt ? (
          <span className={cn('text-xs', task.overdue ? 'text-danger' : 'text-fg-secondary')}>
            {formatDate(task.dueAt, { locale })}
          </span>
        ) : null}
        <StatusBadge
          status={STATUS_TONE_KEY[task.status]}
          label={t(`tasks.statuses.${task.status}`)}
        />
      </button>
    </li>
  )
}
