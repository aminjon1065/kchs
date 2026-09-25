import type { TaskProgress, TaskRecord } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import {
  Badge,
  Button,
  Checkbox,
  cn,
  IconButton,
  InlineEdit,
  Input,
  ProgressBar,
  StatusBadge,
  UserChip,
  useToast,
} from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ListChecks, ListTree, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { ApiError, http } from '~/shared/api/client.js'
import { taskKeys } from './queries.js'
import { useTaskInvalidation } from './task-actions.js'
import { STATUS_TONE_KEY } from './task-status.js'

/** Отметка прогресса в строке списка и на карточке доски: «2/5». */
export function ProgressMark({
  progress,
  kind,
}: {
  progress: TaskProgress | null
  kind: 'checklist' | 'subtasks'
}) {
  const t = useT()
  if (!progress) return null
  const Icon = kind === 'checklist' ? ListChecks : ListTree
  const complete = progress.done === progress.total
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 text-2xs tabular',
        complete ? 'text-success' : 'text-fg-muted',
      )}
      title={t(`tasks.progress.${kind}`, { done: progress.done, total: progress.total })}
    >
      <Icon className="size-3" aria-hidden />
      {progress.done}/{progress.total}
    </span>
  )
}

function useApply(taskId: string): {
  apply: (record: TaskRecord) => void
  fail: (error: unknown) => void
} {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const invalidate = useTaskInvalidation()
  return {
    apply: (record) => {
      client.setQueryData(taskKeys.task(taskId), record)
      invalidate()
    },
    fail: (error) => toast.error(error instanceof ApiError ? error.message : t('errors.unknown')),
  }
}

/**
 * Чек-лист задачи и поручения (ADR-0155): шаги исполнения по порядку. У поручения его
 * ведут исполнитель, автор и контролёр, у задачи — кто её правит; остальные видят.
 */
export function ChecklistSection({ task }: { task: TaskRecord }) {
  const t = useT()
  const { apply, fail } = useApply(task.id)
  const [text, setText] = useState('')
  const editable = task.can.checklist
  const add = useMutation({
    mutationFn: (value: string) =>
      http.post<TaskRecord>(`/tasks/${task.id}/checklist`, { text: value }),
    onSuccess: (record) => {
      setText('')
      apply(record)
    },
    onError: fail,
  })
  const patch = useMutation({
    mutationFn: (input: { itemId: string; body: Record<string, unknown> }) =>
      http.patch<TaskRecord>(`/tasks/${task.id}/checklist/${input.itemId}`, input.body),
    onSuccess: apply,
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: (itemId: string) =>
      http.delete<TaskRecord>(`/tasks/${task.id}/checklist/${itemId}`),
    onSuccess: apply,
    onError: fail,
  })

  if (!editable && task.checklist.length === 0) return null
  const progress = task.checklistProgress
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-fg">{t('tasks.checklist.title')}</h2>
        {progress ? (
          <span className="text-xs tabular text-fg-muted">
            {t('tasks.progress.count', { done: progress.done, total: progress.total })}
          </span>
        ) : null}
      </div>
      {progress ? (
        <ProgressBar
          value={progress.done}
          max={progress.total}
          label={t('tasks.checklist.title')}
          className="mb-2"
        />
      ) : null}
      {task.checklist.length > 0 ? (
        <ul aria-label={t('tasks.checklist.title')} className="flex flex-col">
          {task.checklist.map((item, index) => (
            <li key={item.id} className="group flex items-center gap-2 py-1">
              <Checkbox
                checked={item.done}
                disabled={!editable || patch.isPending}
                aria-label={item.text}
                onCheckedChange={(checked) =>
                  patch.mutate({ itemId: item.id, body: { done: checked === true } })
                }
              />
              <span className="min-w-0 flex-1">
                <InlineEdit
                  value={item.text}
                  disabled={!editable}
                  aria-label={t('tasks.checklist.rename', { text: item.text })}
                  className={cn('text-sm', item.done ? 'text-fg-muted line-through' : 'text-fg')}
                  onSave={(next) => patch.mutate({ itemId: item.id, body: { text: next } })}
                />
              </span>
              {item.done && item.doneBy ? (
                <span className="hidden shrink-0 text-2xs text-fg-muted sm:inline">
                  {item.doneBy.displayName}
                </span>
              ) : null}
              {editable ? (
                <span className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label={t('tasks.checklist.up', { text: item.text })}
                    disabled={index === 0}
                    onClick={() => patch.mutate({ itemId: item.id, body: { position: index - 1 } })}
                  >
                    <ArrowUp className="size-3.5" />
                  </IconButton>
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label={t('tasks.checklist.down', { text: item.text })}
                    disabled={index === task.checklist.length - 1}
                    onClick={() => patch.mutate({ itemId: item.id, body: { position: index + 1 } })}
                  >
                    <ArrowDown className="size-3.5" />
                  </IconButton>
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label={t('tasks.checklist.remove', { text: item.text })}
                    onClick={() => remove.mutate(item.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {editable ? (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (text.trim()) add.mutate(text.trim())
          }}
        >
          <Input
            value={text}
            maxLength={500}
            placeholder={t('tasks.checklist.placeholder')}
            aria-label={t('tasks.checklist.add')}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" variant="secondary" size="sm" loading={add.isPending}>
            {t('tasks.checklist.add')}
          </Button>
        </form>
      ) : null}
    </section>
  )
}

/**
 * Подзадачи обычной задачи (ADR-0155): свой исполнитель и срок, права — от задачи.
 * У поручения подзадач нет: работу делят части соисполнителей.
 */
export function SubtasksSection({ task }: { task: TaskRecord }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  const invalidate = useTaskInvalidation()
  const { fail } = useApply(task.id)
  const [title, setTitle] = useState('')
  const create = useMutation({
    mutationFn: (value: string) =>
      http.post<{ id: string }>(`/tasks/${task.id}/subtasks`, { title: value }),
    onSuccess: () => {
      setTitle('')
      invalidate(task.id)
    },
    onError: fail,
  })

  if (task.kind !== 'task' || (!task.can.subtasks && task.subtasks.length === 0)) return null
  const progress = task.subtaskProgress
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold text-fg">{t('tasks.subtasks.title')}</h2>
        {progress ? (
          <span className="text-xs tabular text-fg-muted">
            {t('tasks.progress.count', { done: progress.done, total: progress.total })}
          </span>
        ) : null}
      </div>
      {task.subtasks.length > 0 ? (
        <ul aria-label={t('tasks.subtasks.title')} className="divide-y divide-line">
          {task.subtasks.map((child) => (
            <li key={child.id} className="flex items-center gap-3 py-2">
              <Button
                variant="link"
                size="sm"
                className="shrink-0"
                onClick={() =>
                  openTab({
                    kind: 'object',
                    objectId: child.id,
                    objectType: 'task',
                    title: child.title,
                    mode: 'permanent',
                  })
                }
              >
                {child.key}
              </Button>
              <span className="min-w-0 flex-1 truncate text-sm text-fg">{child.title}</span>
              {child.assignee ? (
                <UserChip user={child.assignee} className="hidden max-w-40 sm:flex" />
              ) : null}
              <StatusBadge
                status={STATUS_TONE_KEY[child.status]}
                label={t(`tasks.statuses.${child.status}`)}
              />
              {child.dueAt ? (
                <span
                  className={cn(
                    'shrink-0 text-xs tabular',
                    child.overdue ? 'text-danger' : 'text-fg-muted',
                  )}
                >
                  {formatDate(child.dueAt, { locale })}
                </span>
              ) : null}
              {child.overdue ? (
                <Badge tone="danger" size="sm">
                  {t('common.time.overdue')}
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {task.can.subtasks ? (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (title.trim()) create.mutate(title.trim())
          }}
        >
          <Input
            value={title}
            maxLength={300}
            placeholder={t('tasks.subtasks.placeholder')}
            aria-label={t('tasks.subtasks.add')}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button type="submit" variant="secondary" size="sm" loading={create.isPending}>
            {t('tasks.subtasks.add')}
          </Button>
        </form>
      ) : null}
    </section>
  )
}
