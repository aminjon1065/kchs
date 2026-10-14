import type { TaskExtensionDecisionInput, TaskRecord } from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  RadioGroup,
  RadioItem,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { type PickedUser, UserPicker } from '~/entities/people/user-picker.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { DueInput } from './due-input.js'
import { type DueValue, dueFields, emptyDue, hasDue } from './due-value.js'
import {
  decideExtension,
  fieldErrorsOf,
  reassignTask,
  requestExtension,
  taskKeys,
} from './queries.js'
import { errorText, useTaskInvalidation } from './task-actions.js'

/**
 * Запрос продления (10-tasks-projects.md §4, ADR-0082): желаемый срок —
 * датой или рабочими днями — и обоснование; решает автор поручения.
 */
export function ExtensionRequestDialog({
  task,
  onClose,
}: {
  task: TaskRecord
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const invalidate = useTaskInvalidation()
  const reasonId = useId()
  const [due, setDue] = useState<DueValue>(emptyDue())
  const [reason, setReason] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)

  const send = useMutation({
    mutationFn: () =>
      requestExtension(task.id, {
        ...dueFields(due),
        reason: reason.trim(),
      }),
    onSuccess: (record) => {
      client.setQueryData(taskKeys.task(task.id), record)
      toast.show({ title: t('tasks.done.extensionRequested'), tone: 'success' })
      invalidate(task.id)
      onClose()
    },
    onError: (error) => {
      setFieldErrors(fieldErrorsOf(error))
      setFailure(errorText(error, t('errors.unknown')))
    },
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('tasks.extension.title')}
        description={`${task.key} · ${task.title}`}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!hasDue(due) || !reason.trim()}
              loading={send.isPending}
              onClick={() => send.mutate()}
            >
              {t('tasks.actions.requestExtension')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <DueInput
            value={due}
            onChange={setDue}
            label={t('tasks.extension.dueLabel')}
            required
            error={fieldErrors.dueAt ?? fieldErrors.dueWorkingDays}
          />
          <Field label={t('tasks.extension.reason')} htmlFor={reasonId} required>
            <Textarea
              id={reasonId}
              rows={4}
              value={reason}
              placeholder={t('tasks.extension.reasonPlaceholder')}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

type Decision = 'approve' | 'other' | 'reject'

/**
 * Решение по продлению: согласовать запрошенный срок, согласовать другой или
 * отказать с причиной — решение попадает в историю сроков и аудит.
 */
export function ExtensionDecisionDialog({
  task,
  onClose,
}: {
  task: TaskRecord
  onClose: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const client = useQueryClient()
  const invalidate = useTaskInvalidation()
  const commentId = useId()
  const [decision, setDecision] = useState<Decision>('approve')
  const [due, setDue] = useState<DueValue>(emptyDue())
  const [comment, setComment] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const request = task.extension

  const decide = useMutation({
    mutationFn: () => {
      const body: TaskExtensionDecisionInput =
        decision === 'reject'
          ? { decision: 'reject', comment: comment.trim() }
          : {
              decision: 'approve',
              ...(decision === 'other' ? dueFields(due) : {}),
              ...(comment.trim() ? { comment: comment.trim() } : {}),
            }
      return decideExtension(task.id, body)
    },
    onSuccess: (record) => {
      client.setQueryData(taskKeys.task(task.id), record)
      toast.show({
        title: t(
          decision === 'reject' ? 'tasks.done.extensionRejected' : 'tasks.done.extensionApproved',
        ),
        tone: 'success',
      })
      invalidate(task.id)
      onClose()
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  const ready =
    decision === 'reject' ? comment.trim().length > 0 : decision === 'other' ? hasDue(due) : true
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('tasks.extension.decideTitle', { key: task.key })}
        description={task.title}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant={decision === 'reject' ? 'danger' : 'primary'}
              disabled={!ready}
              loading={decide.isPending}
              onClick={() => decide.mutate()}
            >
              {t(decision === 'reject' ? 'tasks.extension.reject' : 'tasks.extension.approve')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          {request ? (
            <Callout
              tone="info"
              title={t('tasks.extension.pending', {
                date: formatDate(request.requestedDueAt, { locale }),
              })}
            >
              <span className="block whitespace-pre-line">{request.reason}</span>
              <span className="mt-1 block text-xs text-fg-muted">
                {t('tasks.extension.requestedBy', {
                  name: request.requestedBy?.displayName ?? '—',
                  date: formatDateTime(request.requestedAt, { locale }),
                })}
              </span>
            </Callout>
          ) : null}
          <RadioGroup
            value={decision}
            onValueChange={(next) => setDecision(next as Decision)}
            aria-label={t('tasks.extension.decision')}
            className="flex flex-col gap-2"
          >
            <RadioItem value="approve" label={t('tasks.extension.approveRequested')} />
            <RadioItem value="other" label={t('tasks.extension.approveOther')} />
            <RadioItem value="reject" label={t('tasks.extension.reject')} />
          </RadioGroup>
          {decision === 'other' ? (
            <DueInput
              value={due}
              onChange={setDue}
              label={t('tasks.extension.otherDue')}
              required
            />
          ) : null}
          <Field
            label={t(
              decision === 'reject' ? 'tasks.extension.rejectReason' : 'tasks.extension.comment',
            )}
            htmlFor={commentId}
            required={decision === 'reject'}
          >
            <Textarea
              id={commentId}
              rows={3}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Переназначение исполнителя автором или контролёром (10-tasks-projects.md §4). */
export function ReassignDialog({ task, onClose }: { task: TaskRecord; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const invalidate = useTaskInvalidation()
  const commentId = useId()
  const [assignee, setAssignee] = useState<PickedUser | null>(null)
  const [comment, setComment] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)

  const send = useMutation({
    mutationFn: () =>
      reassignTask(task.id, {
        assigneeId: assignee!.id,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      }),
    onSuccess: (record) => {
      client.setQueryData(taskKeys.task(task.id), record)
      toast.show({ title: t('tasks.done.reassign'), tone: 'success' })
      invalidate(task.id)
      onClose()
    },
    onError: (error) => {
      setFieldErrors(fieldErrorsOf(error))
      setFailure(errorText(error, t('errors.unknown')))
    },
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('tasks.reassign.title', { key: task.key })}
        description={task.title}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!assignee || assignee.id === task.assignee?.id}
              loading={send.isPending}
              onClick={() => send.mutate()}
            >
              {t('tasks.actions.reassign')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <p className="text-sm text-fg-secondary">{t('tasks.reassign.hint')}</p>
          <Field label={t('tasks.reassign.assignee')} error={fieldErrors.assigneeId} required>
            <UserPicker
              value={assignee}
              onChange={setAssignee}
              label={t('tasks.reassign.assignee')}
            />
          </Field>
          <Field label={t('tasks.reassign.comment')} htmlFor={commentId}>
            <Textarea
              id={commentId}
              rows={3}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
