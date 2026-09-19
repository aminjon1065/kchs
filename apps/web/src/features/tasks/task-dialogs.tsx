import type { TaskRecord, TaskSource, TaskUpdateInput } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { TerritorySelect } from '~/features/gis/territory-select.js'
import { ApiError, http } from '~/shared/api/client.js'
import { spacesQuery } from '~/shared/api/queries.js'
import { orderSpaces } from '~/shared/spaces.js'
import { projectsQuery, taskKeys } from './queries.js'
import { errorText, useTaskInvalidation } from './task-actions.js'
import { dateFromDue, dueFromDate, PRIORITIES, pickedOf } from './task-status.js'
import { type PickedUser, UserPicker } from './user-picker.js'

const NO_PROJECT = '__none'

type CreatableKind = 'task' | 'instruction'

/** Заготовка новой задачи: из строки датасета, из проекта или с экрана задач. */
export interface TaskDraft {
  kind?: CreatableKind
  title?: string
  projectId?: string
  source?: TaskSource
  /** Территория задачи (паспорт территории). */
  territoryId?: string
}

function PrioritySelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT()
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={t('tasks.fields.priority')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {PRIORITIES.map((priority) => (
          <SelectItem key={priority} value={String(priority)}>
            {t(`tasks.priorities.p${priority}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Новая задача или поручение (10-tasks-projects.md §1): у поручения обязательны
 * исполнитель и срок; из карточки строки датасета — с заголовком строки и
 * связью с ней. Созданную задачу можно открыть из уведомления.
 */
export function CreateTaskDialog({
  draft = {},
  onClose,
  onCreated,
}: {
  draft?: TaskDraft
  onClose: () => void
  /** Создано: карточка строки переключается на свои поручения. */
  onCreated?: (id: string) => void
}) {
  const t = useT()
  const toast = useToast()
  const invalidate = useTaskInvalidation()
  const openTab = useWorkspace((s) => s.openTab)
  const titleId = useId()
  const dueId = useId()
  const descriptionId = useId()
  const [kind, setKind] = useState<CreatableKind>(draft.kind ?? 'task')
  const [title, setTitle] = useState(draft.title ?? '')
  const [assignee, setAssignee] = useState<PickedUser | null>(null)
  const [controller, setController] = useState<PickedUser | null>(null)
  const [due, setDue] = useState('')
  const [priority, setPriority] = useState('3')
  const [projectId, setProjectId] = useState(draft.projectId ?? NO_PROJECT)
  const [territoryId, setTerritoryId] = useState<string | null>(draft.territoryId ?? null)
  const [description, setDescription] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const { data: projects = [] } = useQuery(projectsQuery())
  const instruction = kind === 'instruction'

  const create = useMutation({
    mutationFn: () =>
      http.post<{ id: string }>('/tasks', {
        kind,
        title: title.trim(),
        priority: Number(priority),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(projectId !== NO_PROJECT ? { projectId } : {}),
        ...(assignee ? { assigneeId: assignee.id } : {}),
        ...(instruction && controller ? { controllerId: controller.id } : {}),
        ...(due ? { dueAt: dueFromDate(due) } : {}),
        ...(draft.source ? { source: draft.source } : {}),
        ...(territoryId ? { territoryId } : {}),
      }),
    onSuccess: ({ id }) => {
      const created = title.trim()
      toast.show({
        title: t(instruction ? 'tasks.create.instructionCreated' : 'tasks.create.created'),
        tone: 'success',
        action: {
          label: t('common.actions.open'),
          onClick: () =>
            openTab({
              kind: 'object',
              objectId: id,
              objectType: 'task',
              title: created,
              mode: 'permanent',
            }),
        },
      })
      invalidate()
      onCreated?.(id)
      onClose()
    },
    onError: (error) => {
      setFieldErrors(error instanceof ApiError ? error.fieldErrors() : {})
      setFailure(errorText(error, t('errors.unknown')))
    },
  })

  const ready = title.trim().length > 0 && (!instruction || (assignee !== null && due !== ''))
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t(instruction ? 'tasks.create.instructionTitle' : 'tasks.create.title')}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!ready}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <SegmentedControl
            aria-label={t('tasks.fields.kind')}
            value={kind}
            onValueChange={setKind}
            options={[
              { value: 'task', label: t('tasks.kinds.task') },
              { value: 'instruction', label: t('tasks.kinds.instruction') },
            ]}
          />
          {instruction ? (
            <p className="text-xs text-fg-muted">{t('tasks.create.instructionHint')}</p>
          ) : null}
          {draft.source?.kind === 'dataset_row' ? (
            <Callout tone="info">
              {t('tasks.create.fromRow', { label: draft.source.label ?? draft.source.rowId })}
            </Callout>
          ) : null}
          <Field
            label={t('tasks.fields.title')}
            htmlFor={titleId}
            error={fieldErrors.title}
            required
          >
            <Input
              id={titleId}
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field
            label={t('tasks.fields.assignee')}
            hint={instruction ? undefined : t('tasks.create.assigneeHint')}
            error={fieldErrors.assigneeId}
            required={instruction}
          >
            <UserPicker
              value={assignee}
              onChange={setAssignee}
              label={t('tasks.fields.assignee')}
            />
          </Field>
          {instruction ? (
            <Field label={t('tasks.fields.controller')} error={fieldErrors.controllerId}>
              <UserPicker
                value={controller}
                onChange={setController}
                label={t('tasks.fields.controller')}
              />
            </Field>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('tasks.fields.due')}
              htmlFor={dueId}
              error={fieldErrors.dueAt}
              required={instruction}
            >
              <Input
                id={dueId}
                type="date"
                value={due}
                onChange={(event) => setDue(event.target.value)}
              />
            </Field>
            <Field label={t('tasks.fields.priority')}>
              <PrioritySelect value={priority} onChange={setPriority} />
            </Field>
          </div>
          <Field label={t('tasks.fields.project')}>
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
          <Field
            label={t('tasks.fields.territory')}
            hint={draft.source ? t('tasks.create.territoryHint') : undefined}
            error={fieldErrors.territoryId}
          >
            <TerritorySelect
              value={territoryId ? { id: territoryId } : null}
              onChange={(value) => setTerritoryId(value?.id ?? null)}
              label={t('tasks.fields.territory')}
            />
          </Field>
          <Field
            label={t('tasks.fields.description')}
            htmlFor={descriptionId}
            error={fieldErrors.description}
          >
            <Textarea
              id={descriptionId}
              rows={4}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Правка задачи: название, описание, приоритет, срок и участники. Смена
 * исполнителя поручения возвращает его в «Назначено» — новому исполнителю.
 */
export function EditTaskDialog({ task, onClose }: { task: TaskRecord; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const invalidate = useTaskInvalidation()
  const titleId = useId()
  const dueId = useId()
  const descriptionId = useId()
  const instruction = task.kind === 'instruction'
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  const [priority, setPriority] = useState(String(task.priority))
  const [due, setDue] = useState(dateFromDue(task.dueAt))
  const [assignee, setAssignee] = useState<PickedUser | null>(pickedOf(task.assignee))
  const [controller, setController] = useState<PickedUser | null>(pickedOf(task.controller))
  const [territoryId, setTerritoryId] = useState<string | null>(task.territoryId)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)

  const patch = (): TaskUpdateInput => {
    const result: TaskUpdateInput = {}
    if (title.trim() !== task.title) result.title = title.trim()
    if (description.trim() !== (task.description ?? '')) {
      result.description = description.trim() || null
    }
    if (Number(priority) !== task.priority) result.priority = Number(priority)
    if (due !== dateFromDue(task.dueAt)) result.dueAt = due ? dueFromDate(due) : null
    if ((assignee?.id ?? null) !== (task.assignee?.id ?? null)) {
      result.assigneeId = assignee?.id ?? null
    }
    if (instruction && (controller?.id ?? null) !== (task.controller?.id ?? null)) {
      result.controllerId = controller?.id ?? null
    }
    if (territoryId !== task.territoryId) result.territoryId = territoryId
    return result
  }

  const save = useMutation({
    mutationFn: () => http.patch<TaskRecord>(`/tasks/${task.id}`, patch()),
    onSuccess: (record) => {
      client.setQueryData(taskKeys.task(task.id), record)
      toast.show({ title: t('common.states.saved'), tone: 'success' })
      invalidate(task.id)
      onClose()
    },
    onError: (error) => {
      setFieldErrors(error instanceof ApiError ? error.fieldErrors() : {})
      setFailure(errorText(error, t('errors.unknown')))
    },
  })

  const ready =
    title.trim().length > 0 &&
    (!instruction || (assignee !== null && due !== '')) &&
    Object.keys(patch()).length > 0
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('tasks.edit.title', { key: task.key })}
        size="md"
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
              {t('common.actions.save')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field
            label={t('tasks.fields.title')}
            htmlFor={titleId}
            error={fieldErrors.title}
            required
          >
            <Input id={titleId} value={title} onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field
            label={t('tasks.fields.assignee')}
            hint={instruction ? t('tasks.edit.reassignHint') : undefined}
            error={fieldErrors.assigneeId}
            required={instruction}
          >
            <UserPicker
              value={assignee}
              onChange={setAssignee}
              label={t('tasks.fields.assignee')}
            />
          </Field>
          {instruction ? (
            <Field label={t('tasks.fields.controller')} error={fieldErrors.controllerId}>
              <UserPicker
                value={controller}
                onChange={setController}
                label={t('tasks.fields.controller')}
              />
            </Field>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('tasks.fields.due')}
              htmlFor={dueId}
              error={fieldErrors.dueAt}
              required={instruction}
            >
              <Input
                id={dueId}
                type="date"
                value={due}
                onChange={(event) => setDue(event.target.value)}
              />
            </Field>
            <Field label={t('tasks.fields.priority')}>
              <PrioritySelect value={priority} onChange={setPriority} />
            </Field>
          </div>
          <Field label={t('tasks.fields.territory')} error={fieldErrors.territoryId}>
            <TerritorySelect
              value={territoryId ? { id: territoryId } : null}
              onChange={(value) => setTerritoryId(value?.id ?? null)}
              label={t('tasks.fields.territory')}
            />
          </Field>
          <Field
            label={t('tasks.fields.description')}
            htmlFor={descriptionId}
            error={fieldErrors.description}
          >
            <Textarea
              id={descriptionId}
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Отчёт исполнителя: текст обязателен, поручение уходит автору на приёмку. */
export function ReportDialog({
  task,
  onClose,
}: {
  task: { id: string; key: string; title: string }
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const invalidate = useTaskInvalidation()
  const textId = useId()
  const [text, setText] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const report = useMutation({
    mutationFn: () => http.post<TaskRecord>(`/tasks/${task.id}/report`, { text: text.trim() }),
    onSuccess: (record) => {
      client.setQueryData(taskKeys.task(task.id), record)
      toast.show({ title: t('tasks.report.sent'), tone: 'success' })
      invalidate(task.id)
      onClose()
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('tasks.report.title')}
        description={`${task.key} · ${task.title}`}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!text.trim()}
              loading={report.isPending}
              onClick={() => report.mutate()}
            >
              {t('tasks.actions.report')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('tasks.report.text')} htmlFor={textId} required>
            <Textarea
              id={textId}
              autoFocus
              rows={6}
              value={text}
              placeholder={t('tasks.report.placeholder')}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Возврат на доработку: замечания обязательны, новый срок — по желанию. */
export function ReturnDialog({ task, onClose }: { task: TaskRecord; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const invalidate = useTaskInvalidation()
  const commentId = useId()
  const dueId = useId()
  const [comment, setComment] = useState('')
  const [due, setDue] = useState(dateFromDue(task.dueAt))
  const [failure, setFailure] = useState<string | null>(null)

  const send = useMutation({
    mutationFn: () =>
      http.post<TaskRecord>(`/tasks/${task.id}/return`, {
        comment: comment.trim(),
        ...(due && due !== dateFromDue(task.dueAt) ? { dueAt: dueFromDate(due) } : {}),
      }),
    onSuccess: (record) => {
      client.setQueryData(taskKeys.task(task.id), record)
      toast.show({ title: t('tasks.return.sent'), tone: 'success' })
      invalidate(task.id)
      onClose()
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('tasks.return.title')}
        description={`${task.key} · ${task.title}`}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!comment.trim()}
              loading={send.isPending}
              onClick={() => send.mutate()}
            >
              {t('tasks.actions.return')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field label={t('tasks.return.comment')} htmlFor={commentId} required>
            <Textarea
              id={commentId}
              autoFocus
              rows={5}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </Field>
          <Field label={t('tasks.return.newDue')} htmlFor={dueId}>
            <Input
              id={dueId}
              type="date"
              value={due}
              onChange={(event) => setDue(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Новый проект: ключ задач, название и пространство участников. */
export function CreateProjectDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const openTab = useWorkspace((s) => s.openTab)
  const keyId = useId()
  const nameId = useId()
  const descriptionId = useId()
  const { data: spaces = [] } = useQuery(spacesQuery())
  // Проект создаёт тот, кто правит пространство; права проверит сервер
  const ordered = orderSpaces(spaces)
  const editable = ordered.filter((item) => item.myRole === 'editor' || item.myRole === 'admin')
  const writable = editable.length > 0 ? editable : ordered
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [spaceId, setSpaceId] = useState<string>('')
  const [description, setDescription] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const space = spaceId || writable[0]?.id || ''

  const create = useMutation({
    mutationFn: () =>
      http.post<{ id: string }>('/projects', {
        key: key.trim(),
        name: name.trim(),
        spaceId: space,
        ...(description.trim() ? { description: description.trim() } : {}),
      }),
    onSuccess: ({ id }) => {
      toast.show({ title: t('tasks.projects.created'), tone: 'success' })
      void client.invalidateQueries({ queryKey: ['projects'] })
      onClose()
      openTab({
        kind: 'object',
        objectId: id,
        objectType: 'project',
        title: name.trim(),
        mode: 'permanent',
      })
    },
    onError: (error) => {
      setFieldErrors(error instanceof ApiError ? error.fieldErrors() : {})
      setFailure(errorText(error, t('errors.unknown')))
    },
  })

  const ready = key.trim().length >= 2 && name.trim().length > 0 && Boolean(space)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={t('tasks.projects.createTitle')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!ready}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              {t('common.actions.create')}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {failure ? <Callout tone="danger">{failure}</Callout> : null}
          <Field
            label={t('tasks.projects.name')}
            htmlFor={nameId}
            error={fieldErrors.name}
            required
          >
            <Input
              id={nameId}
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field
            label={t('tasks.projects.key')}
            htmlFor={keyId}
            hint={t('tasks.projects.keyHint')}
            error={fieldErrors.key}
            required
          >
            <Input
              id={keyId}
              mono
              value={key}
              maxLength={10}
              onChange={(event) => setKey(event.target.value.toUpperCase().replace(/\s/g, ''))}
            />
          </Field>
          <Field label={t('common.labels.space')} error={fieldErrors.spaceId} required>
            <Select value={space} onValueChange={setSpaceId}>
              <SelectTrigger aria-label={t('common.labels.space')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {writable.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('tasks.fields.description')} htmlFor={descriptionId}>
            <Textarea
              id={descriptionId}
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}
