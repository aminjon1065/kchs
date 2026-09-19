import type { LangText } from '@kchs/contracts'
import type { ProcessInstanceView, ProcessMyAction } from '@kchs/process'
import {
  Button,
  Dialog,
  DialogContent,
  Field,
  FileDropzone,
  Input,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UserPlus, UserRoundPen } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { uploadFile } from '~/features/files/upload.js'
import { type PickedUser, UserPicker } from '~/features/tasks/user-picker.js'
import { ApiError } from '~/shared/api/client.js'
import { keys, meQuery } from '~/shared/api/queries.js'
import { COMMENT_REQUIRED, knownKey, STEP_TYPES } from './labels.js'
import { processApi } from './queries.js'

/** Решения назначенного — кнопки; передача и добавление согласующего — отдельно. */
const DECISIONS = new Set([
  'approve',
  'remarks',
  'reject',
  'sign',
  'refuse',
  'acknowledge',
  'register',
  'resubmit',
  'withdraw',
])
const DANGER = new Set(['reject', 'refuse', 'withdraw'])

function text(value: LangText | null | undefined, locale: string): string | null {
  if (!value) return null
  return (value as Record<string, string | undefined>)[locale] ?? value.ru
}

type Pending =
  | { kind: 'decision'; item: ProcessMyAction; action: string }
  | { kind: 'delegate' | 'add'; item: ProcessMyAction }

/**
 * Действия смотрящего на идущих шагах маршрута (08-documents.md §15, ADR-0083):
 * Согласовать / Замечания / Отклонить / Подписать с кодом второго фактора,
 * повторная отправка после доработки, передача шага и новый согласующий.
 * Решение — то же API движка, что у Входящих; заместитель решает «от имени».
 */
export function ProcessStepActions({
  objectId,
  view,
  onDone,
}: {
  objectId: string
  view: ProcessInstanceView
  onDone?: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const { data: me } = useQuery(meQuery())
  const commentId = useId()
  const codeId = useId()
  const [pending, setPending] = useState<Pending | null>(null)
  const [comment, setComment] = useState('')
  const [code, setCode] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [person, setPerson] = useState<PickedUser | null>(null)

  const reset = () => {
    setPending(null)
    setComment('')
    setCode('')
    setFiles([])
    setPerson(null)
  }

  const done = () => {
    toast.show({ title: t('processes.actions.done'), tone: 'success' })
    reset()
    void client.invalidateQueries({ queryKey: keys.object(objectId) })
    void client.invalidateQueries({ queryKey: ['inbox'] })
    void client.invalidateQueries({ queryKey: keys.inboxCounts })
    onDone?.()
  }
  const failed = (error: unknown) =>
    toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))

  const decide = useMutation({
    mutationFn: async (input: { item: ProcessMyAction; action: string }) => {
      // Файлы замечаний — свои файлы в личном пространстве: к объекту их прикрепит решение
      const fileIds: string[] = []
      if (files.length > 0) {
        if (!me?.personalSpaceId) throw new Error(t('errors.unknown'))
        for (const file of files) {
          fileIds.push((await uploadFile({ file, spaceId: me.personalSpaceId })).id)
        }
      }
      await processApi.act(
        view.id,
        input.item.stepId,
        {
          action: input.action,
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          ...(code.trim() ? { code: code.trim() } : {}),
          ...(fileIds.length > 0 ? { fileIds } : {}),
        },
        input.item.onBehalfOf?.id ?? null,
      )
    },
    onSuccess: done,
    onError: failed,
  })

  const hand = useMutation({
    mutationFn: async (input: { kind: 'delegate' | 'add'; item: ProcessMyAction }) => {
      if (!person) return
      const body = { userId: person.id, ...(comment.trim() ? { comment: comment.trim() } : {}) }
      const actor = input.item.onBehalfOf?.id ?? null
      if (input.kind === 'delegate') {
        await processApi.delegate(view.id, input.item.stepId, body, actor)
      } else {
        await processApi.addAssignee(view.id, input.item.stepId, body, actor)
      }
    },
    onSuccess: done,
    onError: failed,
  })

  const needsDialog = (item: ProcessMyAction, action: string) =>
    COMMENT_REQUIRED.has(action) || action === 'remarks' || (action === 'sign' && item.requireMfa)

  const run = (item: ProcessMyAction, action: string) => {
    if (needsDialog(item, action)) {
      reset()
      setPending({ kind: 'decision', item, action })
      return
    }
    decide.mutate({ item, action })
  }

  if (view.myActions.length === 0) return null

  const decisionReady = (value: Extract<Pending, { kind: 'decision' }>) =>
    (!COMMENT_REQUIRED.has(value.action) || Boolean(comment.trim())) &&
    (value.action !== 'remarks' || Boolean(comment.trim()) || files.length > 0) &&
    (!(value.action === 'sign' && value.item.requireMfa) || Boolean(code.trim()))

  return (
    <div className="flex flex-col gap-3">
      {view.myActions.map((item) => {
        const step = view.steps.find((candidate) => candidate.id === item.stepId)
        const name =
          text(step?.name, locale) ??
          t(`processes.types.${knownKey(step?.type ?? 'approval', STEP_TYPES, 'approval')}`)
        const decisions = item.actions.filter((action) => DECISIONS.has(action))
        return (
          <div key={item.stepId} className="flex flex-col gap-2">
            <p className="text-sm text-fg">
              {item.onBehalfOf
                ? t('processes.actions.forStepOnBehalf', {
                    step: name,
                    name: item.onBehalfOf.displayName,
                  })
                : t('processes.actions.forStep', { step: name })}
            </p>
            <div className="flex flex-wrap gap-2">
              {decisions.map((action, index) => (
                <Button
                  key={action}
                  size="sm"
                  variant={index === 0 ? 'primary' : DANGER.has(action) ? 'danger' : 'secondary'}
                  loading={decide.isPending && decide.variables?.action === action}
                  disabled={decide.isPending}
                  onClick={() => run(item, action)}
                >
                  {t(`processes.decisions.${action}`)}
                </Button>
              ))}
            </div>
            {item.actions.includes('delegate') || item.actions.includes('add_approver') ? (
              <div className="flex flex-wrap gap-2">
                {item.actions.includes('delegate') ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<UserRoundPen className="size-3.5" />}
                    onClick={() => {
                      reset()
                      setPending({ kind: 'delegate', item })
                    }}
                  >
                    {t('processes.actions.delegate')}
                  </Button>
                ) : null}
                {item.actions.includes('add_approver') ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<UserPlus className="size-3.5" />}
                    onClick={() => {
                      reset()
                      setPending({ kind: 'add', item })
                    }}
                  >
                    {t('processes.actions.addApprover')}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}

      <Dialog open={pending !== null} onOpenChange={(open) => !open && reset()}>
        {pending?.kind === 'decision' ? (
          <DialogContent
            title={t(`processes.decisions.${pending.action}`)}
            size="md"
            footer={
              <>
                <Button variant="secondary" onClick={reset}>
                  {t('common.actions.cancel')}
                </Button>
                <Button
                  variant={DANGER.has(pending.action) ? 'danger' : 'primary'}
                  disabled={!decisionReady(pending)}
                  loading={decide.isPending}
                  onClick={() => decide.mutate({ item: pending.item, action: pending.action })}
                >
                  {t(`processes.decisions.${pending.action}`)}
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <Field
                label={t('inbox.comment')}
                htmlFor={commentId}
                required={COMMENT_REQUIRED.has(pending.action)}
                hint={pending.action === 'remarks' ? t('processes.actions.remarksHint') : undefined}
              >
                <Textarea
                  id={commentId}
                  autoFocus={pending.action !== 'sign'}
                  rows={5}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              </Field>
              {pending.action === 'remarks' ? (
                <FileDropzone
                  compact
                  onFiles={(added) => setFiles((current) => [...current, ...added])}
                  label={
                    files.length > 0
                      ? files.map((file) => file.name).join(', ')
                      : t('processes.actions.remarksFiles')
                  }
                />
              ) : null}
              {pending.action === 'sign' && pending.item.requireMfa ? (
                <Field label={t('inbox.code')} htmlFor={codeId} hint={t('inbox.codeHint')} required>
                  <Input
                    id={codeId}
                    autoFocus
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={24}
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    mono
                  />
                </Field>
              ) : null}
            </div>
          </DialogContent>
        ) : pending ? (
          <DialogContent
            title={t(
              pending.kind === 'delegate'
                ? 'processes.actions.delegate'
                : 'processes.actions.addApprover',
            )}
            description={t(
              pending.kind === 'delegate'
                ? 'processes.actions.delegateHint'
                : 'processes.actions.addApproverHint',
            )}
            size="md"
            footer={
              <>
                <Button variant="secondary" onClick={reset}>
                  {t('common.actions.cancel')}
                </Button>
                <Button
                  variant="primary"
                  disabled={!person}
                  loading={hand.isPending}
                  onClick={() => hand.mutate({ kind: pending.kind, item: pending.item })}
                >
                  {t(
                    pending.kind === 'delegate'
                      ? 'processes.actions.delegate'
                      : 'processes.actions.addApprover',
                  )}
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <UserPicker
                value={person}
                onChange={setPerson}
                label={t('processes.actions.person')}
              />
              <Field label={t('inbox.comment')} htmlFor={commentId}>
                <Textarea
                  id={commentId}
                  rows={3}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              </Field>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  )
}
