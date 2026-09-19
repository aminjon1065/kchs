import type {
  DocumentRecord,
  DocumentResolutions,
  ResolutionInput,
  ResolutionRecord,
  UserRef,
} from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { DueInput, type DueValue, emptyDue } from '~/features/tasks/due-input.js'
import { pickedOf } from '~/features/tasks/task-status.js'
import { type PickedUser, UserPicker, UsersPicker } from '~/features/tasks/user-picker.js'
import { http } from '~/shared/api/client.js'
import { documentKeys, resolutionTemplatesQuery } from '../queries.js'
import { errorText, localToday } from '../status.js'

const NO_TEMPLATE = '__none'

/** Срок резолюции из поля: дата (не раньше сегодняшней) или 1…366 рабочих дней. */
function dueOf(value: DueValue): Pick<ResolutionInput, 'dueDate' | 'dueWorkingDays'> | null {
  if (value.mode === 'date') {
    return value.date && value.date >= localToday() ? { dueDate: value.date } : null
  }
  const days = Number(value.days)
  return value.days.trim() !== '' && Number.isInteger(days) && days >= 1 && days <= 366
    ? { dueWorkingDays: days }
    : null
}

/**
 * Резолюция (08-documents.md §6, ADR-0084): текст (шаблоны — быстрый ввод),
 * ответственный, соисполнители, срок датой или рабочими днями, контроль.
 * Делопроизводитель вносит резолюцию от имени руководителя; вложенная —
 * к резолюции, где пишущий — ответственный или соисполнитель.
 */
export function ResolutionDialog({
  document,
  view,
  parent,
  onClose,
}: {
  document: DocumentRecord
  view: DocumentResolutions
  parent: ResolutionRecord | null
  onClose: () => void
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const { data: templates = [] } = useQuery(resolutionTemplatesQuery())
  // Автор: получатель направления (я или замещаемый); делопроизводитель выбирает руководителя
  const onBehalf = !parent && !view.can.resolve && view.can.resolveOnBehalf
  const waiting = view.requests.find((request) => request.state === 'open')?.user ?? null
  const [author, setAuthor] = useState<PickedUser | null>(() =>
    onBehalf ? pickedOf(waiting) : null,
  )
  const [templateId, setTemplateId] = useState(NO_TEMPLATE)
  const [text, setText] = useState('')
  const [responsible, setResponsible] = useState<PickedUser | null>(null)
  const [coExecutors, setCoExecutors] = useState<PickedUser[]>([])
  const [due, setDue] = useState<DueValue>(() => emptyDue())
  const [control, setControl] = useState(!parent)
  const [controller, setController] = useState<PickedUser | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const dueInput = dueOf(due)
  const ready =
    text.trim() !== '' && responsible !== null && dueInput !== null && (!onBehalf || author)

  const applyTemplate = (id: string) => {
    setTemplateId(id)
    const template = templates.find((item) => item.id === id)
    if (!template) return
    setText(template.text)
    setControl(template.control)
    if (template.dueWorkingDays) {
      setDue({ mode: 'working', date: '', days: String(template.dueWorkingDays) })
    }
  }

  const save = useMutation({
    mutationFn: () => {
      const body: ResolutionInput = {
        text: text.trim(),
        responsibleId: responsible?.id ?? '',
        coExecutorIds: coExecutors.map((user) => user.id),
        ...dueInput,
        control,
        ...(control && controller ? { controllerId: controller.id } : {}),
        parentId: parent?.id ?? null,
        ...(onBehalf && author ? { authorId: author.id } : {}),
      }
      return http.post<DocumentResolutions>(`/documents/${document.id}/resolutions`, body)
    },
    onSuccess: (next) => {
      client.setQueryData(documentKeys.resolutions(document.id), next)
      void client.invalidateQueries({ queryKey: ['object', document.id] })
      void client.invalidateQueries({ queryKey: documentKeys.all })
      toast.show({ title: t('documents.resolutions.saved'), tone: 'success' })
      onClose()
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  const defaultAuthor: UserRef | null = parent ? null : view.defaultAuthor
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t(parent ? 'documents.resolutions.nested' : 'documents.resolutions.add')}
        description={document.subject || t('documents.draft')}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!ready}
              loading={save.isPending}
              onClick={() => save.mutate()}
            >
              {t('documents.resolutions.submit')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          {parent ? (
            <Callout tone="info">
              {t('documents.resolutions.parent', { text: parent.text })}
              <br />
              {t('documents.resolutions.parentDue', {
                date: formatDate(`${parent.dueDate}T12:00:00`, { locale }),
              })}
            </Callout>
          ) : null}
          {onBehalf ? (
            <Field
              label={t('documents.resolutions.author')}
              hint={t('documents.resolutions.onBehalfHint')}
              required
            >
              <UserPicker
                value={author}
                onChange={setAuthor}
                label={t('documents.resolutions.author')}
              />
            </Field>
          ) : defaultAuthor && !parent ? (
            <p className="text-xs text-fg-secondary">
              {t('documents.resolutions.authorIs', { name: defaultAuthor.displayName })}
            </p>
          ) : null}
          {templates.length > 0 ? (
            <Field label={t('documents.resolutions.template')}>
              <Select value={templateId} onValueChange={applyTemplate}>
                <SelectTrigger aria-label={t('documents.resolutions.template')}>
                  <SelectValue placeholder={t('documents.resolutions.templatePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TEMPLATE}>
                    {t('documents.resolutions.templatePlaceholder')}
                  </SelectItem>
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.text}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field label={t('documents.resolutions.text')} htmlFor={`${formId}-text`} required>
            <Textarea
              id={`${formId}-text`}
              rows={4}
              maxLength={4000}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <Field label={t('documents.resolutions.responsible')} required>
            <UserPicker
              value={responsible}
              onChange={(user) => {
                setResponsible(user)
                if (user) setCoExecutors((list) => list.filter((item) => item.id !== user.id))
              }}
              label={t('documents.resolutions.responsible')}
            />
          </Field>
          <Field label={t('documents.resolutions.coExecutors')}>
            <UsersPicker
              value={coExecutors}
              onChange={setCoExecutors}
              label={t('documents.resolutions.coExecutors')}
              exclude={responsible ? [responsible.id] : []}
            />
          </Field>
          <DueInput
            value={due}
            onChange={setDue}
            label={t('documents.resolutions.due')}
            required
            error={
              due.mode === 'working' && due.days.trim() !== '' && !dueInput
                ? t('documents.resolutions.workingDaysMin')
                : undefined
            }
          />
          <Switch
            label={t('documents.resolutions.control')}
            checked={control}
            onCheckedChange={setControl}
          />
          {control ? (
            <Field
              label={t('documents.resolutions.controller')}
              hint={t('documents.resolutions.controllerHint')}
            >
              <UserPicker
                value={controller}
                onChange={setController}
                label={t('documents.resolutions.controller')}
              />
            </Field>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Направить на резолюцию (делопроизводитель) или переадресовать (получатель направления). */
export function ResolutionRequestDialog({
  document,
  onClose,
}: {
  document: DocumentRecord
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const [user, setUser] = useState<PickedUser | null>(null)
  const [dueDate, setDueDate] = useState('')
  const [note, setNote] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const send = useMutation({
    mutationFn: () =>
      http.post<DocumentResolutions>(`/documents/${document.id}/resolution-requests`, {
        userId: user?.id ?? '',
        dueDate: dueDate || null,
        note: note.trim() || null,
      }),
    onSuccess: (next) => {
      client.setQueryData(documentKeys.resolutions(document.id), next)
      toast.show({ title: t('documents.resolutions.requested'), tone: 'success' })
      onClose()
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.resolutions.request')}
        description={document.subject || t('documents.draft')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!user}
              loading={send.isPending}
              onClick={() => send.mutate()}
            >
              {t('documents.resolutions.requestSend')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('documents.resolutions.requestTo')} required>
            <UserPicker
              value={user}
              onChange={setUser}
              label={t('documents.resolutions.requestTo')}
            />
          </Field>
          <Field label={t('documents.resolutions.requestDue')} htmlFor={`${formId}-due`}>
            <Input
              id={`${formId}-due`}
              type="date"
              min={localToday()}
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </Field>
          <Field label={t('documents.resolutions.requestNote')} htmlFor={`${formId}-note`}>
            <Textarea
              id={`${formId}-note`}
              rows={3}
              maxLength={2000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** «Не требует исполнения»: документ исполнен без поручений. */
export function NoExecutionDialog({
  document,
  onClose,
}: {
  document: DocumentRecord
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const formId = useId()
  const [comment, setComment] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const done = useMutation({
    mutationFn: () =>
      http.post<DocumentRecord>(`/documents/${document.id}/no-execution`, {
        comment: comment.trim() || null,
      }),
    onSuccess: (record) => {
      client.setQueryData(documentKeys.document(record.id), record)
      void client.invalidateQueries({ queryKey: ['object', record.id] })
      void client.invalidateQueries({ queryKey: documentKeys.all })
      toast.show({ title: t('documents.resolutions.noExecutionDone'), tone: 'success' })
      onClose()
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        title={t('documents.resolutions.noExecutionTitle')}
        description={t('documents.resolutions.noExecutionHint')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button variant="primary" loading={done.isPending} onClick={() => done.mutate()}>
              {t('documents.resolutions.noExecution')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('documents.resolutions.comment')} htmlFor={`${formId}-comment`}>
            <Textarea
              id={`${formId}-comment`}
              rows={3}
              maxLength={2000}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
