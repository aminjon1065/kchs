import type { TaskBulkAction, TaskBulkResult } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { DueInput, type DueValue, dueFields, emptyDue, hasDue } from './due-input.js'
import { projectsQuery } from './queries.js'
import { useTaskInvalidation } from './task-actions.js'
import { type PickedUser, UserPicker } from './user-picker.js'

export type BulkKind = TaskBulkAction['kind']

const NO_PROJECT = '__none'

/** Панель выделенных задач: число и действия (ADR-0155). */
export function BulkBar({
  count,
  onAction,
  onClear,
}: {
  count: number
  onAction: (kind: BulkKind) => void
  onClear: () => void
}) {
  const t = useT()
  return (
    <div
      role="toolbar"
      aria-label={t('tasks.bulk.toolbar')}
      className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-subtle px-4 py-2"
    >
      <span className="text-sm font-medium text-fg">{t('tasks.bulk.selected', { count })}</span>
      {(['reassign', 'due', 'close', 'project', 'cancel'] as const).map((kind) => (
        <Button key={kind} size="sm" variant="secondary" onClick={() => onAction(kind)}>
          {t(`tasks.bulk.actions.${kind}`)}
        </Button>
      ))}
      <Button size="sm" variant="ghost" onClick={onClear}>
        {t('tasks.bulk.clear')}
      </Button>
    </div>
  )
}

/**
 * Диалог массового действия: параметры, затем один запрос; итог — «сделано N,
 * пропущено M» с причинами пропуска.
 */
export function BulkDialog({
  kind,
  ids,
  onClose,
  onDone,
}: {
  kind: BulkKind
  ids: string[]
  onClose: () => void
  onDone: () => void
}) {
  const t = useT()
  const toast = useToast()
  const invalidate = useTaskInvalidation()
  const commentId = useId()
  const [assignee, setAssignee] = useState<PickedUser | null>(null)
  const [due, setDue] = useState<DueValue>(emptyDue())
  const [projectId, setProjectId] = useState(NO_PROJECT)
  const [comment, setComment] = useState('')
  const [result, setResult] = useState<TaskBulkResult | null>(null)
  const { data: projects = [] } = useQuery(projectsQuery())

  const action = (): TaskBulkAction | null => {
    const note = comment.trim() ? { comment: comment.trim() } : {}
    if (kind === 'reassign') return assignee ? { kind, assigneeId: assignee.id, ...note } : null
    if (kind === 'due') return hasDue(due) ? { kind, ...dueFields(due), ...note } : null
    if (kind === 'project') return { kind, projectId: projectId === NO_PROJECT ? null : projectId }
    if (kind === 'cancel') return { kind, ...note }
    return { kind }
  }
  const run = useMutation({
    mutationFn: (body: TaskBulkAction) =>
      http.post<TaskBulkResult>('/tasks/bulk', { ids, action: body }),
    onSuccess: (outcome) => {
      invalidate()
      toast.show({
        title: t('tasks.bulk.result', { done: outcome.done, skipped: outcome.skipped.length }),
        tone: outcome.skipped.length ? 'warning' : 'success',
      })
      if (outcome.skipped.length) setResult(outcome)
      else {
        onDone()
        onClose()
      }
    },
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  })
  const body = action()

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t(`tasks.bulk.titles.${kind}`, { count: ids.length })}
        size="sm"
        footer={
          result ? (
            <Button
              variant="primary"
              onClick={() => {
                onDone()
                onClose()
              }}
            >
              {t('common.actions.close')}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>
                {t('common.actions.cancel')}
              </Button>
              <Button
                variant={kind === 'cancel' ? 'danger' : 'primary'}
                disabled={!body}
                loading={run.isPending}
                onClick={() => body && run.mutate(body)}
              >
                {t('tasks.bulk.apply')}
              </Button>
            </>
          )
        }
      >
        {result ? (
          <div className="flex flex-col gap-2">
            <Callout tone="warning">
              {t('tasks.bulk.result', { done: result.done, skipped: result.skipped.length })}
            </Callout>
            <ul aria-label={t('tasks.bulk.skipped')} className="flex flex-col gap-1 text-xs">
              {result.skipped.map((item) => (
                <li key={item.id}>
                  <span className="font-mono text-fg-muted">{item.key ?? '—'}</span> · {item.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {kind === 'reassign' ? (
              <Field label={t('tasks.fields.assignee')} required>
                <UserPicker
                  value={assignee}
                  onChange={setAssignee}
                  label={t('tasks.fields.assignee')}
                />
              </Field>
            ) : null}
            {kind === 'due' ? (
              <DueInput value={due} onChange={setDue} label={t('tasks.fields.due')} required />
            ) : null}
            {kind === 'project' ? (
              <Field label={t('tasks.fields.project')} hint={t('tasks.bulk.projectHint')}>
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger aria-label={t('tasks.fields.project')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PROJECT}>{t('tasks.noProject')}</SelectItem>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.key} · {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            {kind === 'close' ? (
              <p className="text-sm text-fg-secondary">{t('tasks.bulk.closeHint')}</p>
            ) : null}
            {kind === 'reassign' || kind === 'due' || kind === 'cancel' ? (
              <Field label={t('tasks.bulk.comment')} htmlFor={commentId}>
                <Textarea
                  id={commentId}
                  rows={2}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              </Field>
            ) : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
