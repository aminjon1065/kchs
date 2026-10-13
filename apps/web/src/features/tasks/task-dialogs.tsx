import type { TaskRecord, TaskSource, TaskUpdateInput } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
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
import { type PickedUser, UserPicker, UsersPicker } from '~/entities/people/user-picker.js'
import { TerritorySelect } from '~/features/gis/territory-select.js'
import { ApiError, http } from '~/shared/api/client.js'
import { spacesQuery } from '~/shared/api/queries.js'
import { useLocale } from '~/shared/appearance.js'
import { useT } from '~/shared/i18n.js'
import { orderSpaces } from '~/shared/spaces.js'
import { useWorkspace } from '~/shared/workspace/store.js'
import { DueInput, type DueValue, dueFields, emptyDue, hasDue } from './due-input.js'
import { projectsQuery, taskKeys } from './queries.js'
import { errorText, useTaskInvalidation } from './task-actions.js'
import {
  emptyRepeat,
  RepeatFields,
  type RepeatValue,
  repeatFields,
  repeatReady,
} from './task-series.js'
import { dateFromDue, PRIORITIES, pickedOf } from './task-status.js'

const NO_PROJECT = '__none'

type CreatableKind = 'task' | 'instruction'

/** Заготовка новой задачи: из строки датасета, из проекта или с экрана задач. */
export interface TaskDraft {
  kind?: CreatableKind
  title?: string
  /** Текст поручения: его предлагает ассистент (ADR-0100). */
  description?: string
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
 * исполнитель и срок — датой или рабочими днями, соисполнители получают свои
 * части; из карточки строки датасета — с заголовком строки и связью с ней.
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
  const descriptionId = useId()
  const [kind, setKind] = useState<CreatableKind>(draft.kind ?? 'task')
  const [title, setTitle] = useState(draft.title ?? '')
  const [assignee, setAssignee] = useState<PickedUser | null>(null)
  const [coAssignees, setCoAssignees] = useState<PickedUser[]>([])
  const [controller, setController] = useState<PickedUser | null>(null)
  const [due, setDue] = useState<DueValue>(emptyDue())
  const [priority, setPriority] = useState('3')
  const [projectId, setProjectId] = useState(draft.projectId ?? NO_PROJECT)
  const [territoryId, setTerritoryId] = useState<string | null>(draft.territoryId ?? null)
  const [description, setDescription] = useState(draft.description ?? '')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)
  // Повторяющееся поручение (ADR-0156): вместо задачи заводится серия
  const [repeat, setRepeat] = useState<RepeatValue>(emptyRepeat())
  const locale = useLocale()
  const { data: projects = [] } = useQuery(projectsQuery())
  const instruction = kind === 'instruction'
  const repeating = repeat.enabled && !draft.source

  const createSeries = useMutation({
    mutationFn: () =>
      http.post('/task-series', {
        body: {
          template: {
            kind,
            title: title.trim(),
            priority: Number(priority),
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(projectId !== NO_PROJECT ? { projectId } : {}),
            ...(assignee ? { assigneeId: assignee.id } : {}),
            ...(instruction && coAssignees.length > 0
              ? { coAssigneeIds: coAssignees.map((user) => user.id) }
              : {}),
            ...(instruction && controller ? { controllerId: controller.id } : {}),
          },
          ...repeatFields(repeat),
        },
      }),
    onSuccess: (series) => {
      toast.show({
        title: series.nextRunAt
          ? t('tasks.series.created', { date: formatDateTime(series.nextRunAt, { locale }) })
          : t('tasks.series.createdNoNext'),
        tone: 'success',
      })
      invalidate()
      onClose()
    },
    onError: (error) => {
      setFieldErrors(error instanceof ApiError ? error.fieldErrors() : {})
      setFailure(errorText(error, t('errors.unknown')))
    },
  })

  const create = useMutation({
    mutationFn: () =>
      http.post('/tasks', {
        body: {
          kind,
          title: title.trim(),
          priority: Number(priority),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(projectId !== NO_PROJECT ? { projectId } : {}),
          ...(assignee ? { assigneeId: assignee.id } : {}),
          ...(instruction && coAssignees.length > 0
            ? { coAssigneeIds: coAssignees.map((user) => user.id) }
            : {}),
          ...(instruction && controller ? { controllerId: controller.id } : {}),
          ...dueFields(due),
          ...(draft.source ? { source: draft.source } : {}),
          ...(territoryId ? { territoryId } : {}),
        },
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

  const ready = repeating
    ? title.trim().length > 0 && (!instruction || assignee !== null) && repeatReady(repeat)
    : title.trim().length > 0 && (!instruction || (assignee !== null && hasDue(due)))
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
              loading={create.isPending || createSeries.isPending}
              onClick={() => (repeating ? createSeries.mutate() : create.mutate())}
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
            <>
              <Field
                label={t('tasks.fields.coAssignees')}
                hint={t('tasks.create.coAssigneesHint')}
                error={fieldErrors.coAssigneeIds}
              >
                <UsersPicker
                  value={coAssignees}
                  onChange={setCoAssignees}
                  label={t('tasks.fields.coAssignees')}
                  exclude={assignee ? [assignee.id] : []}
                />
              </Field>
              <Field label={t('tasks.fields.controller')} error={fieldErrors.controllerId}>
                <UserPicker
                  value={controller}
                  onChange={setController}
                  label={t('tasks.fields.controller')}
                />
              </Field>
            </>
          ) : null}
          {repeating ? null : (
            <DueInput
              value={due}
              onChange={setDue}
              label={t('tasks.fields.due')}
              required={instruction}
              error={fieldErrors.dueAt ?? fieldErrors.dueWorkingDays}
            />
          )}
          {draft.source ? null : <RepeatFields value={repeat} onChange={setRepeat} />}
          <Field label={t('tasks.fields.priority')}>
            <PrioritySelect value={priority} onChange={setPriority} />
          </Field>
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
 * Правка задачи: название, описание, приоритет, срок (с основанием — в историю
 * сроков) и участники. Смена исполнителя поручения возвращает его в
 * «Назначено» — новому исполнителю; новые соисполнители получают части.
 */
export function EditTaskDialog({ task, onClose }: { task: TaskRecord; onClose: () => void }) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const invalidate = useTaskInvalidation()
  const titleId = useId()
  const descriptionId = useId()
  const dueCommentId = useId()
  const instruction = task.kind === 'instruction'
  // Часть соисполнителя: состав участников задаёт основное поручение
  const part = task.parent !== null
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  const [priority, setPriority] = useState(String(task.priority))
  const [due, setDue] = useState<DueValue>(emptyDue(dateFromDue(task.dueAt)))
  const [dueComment, setDueComment] = useState('')
  const [assignee, setAssignee] = useState<PickedUser | null>(pickedOf(task.assignee))
  const [coAssignees, setCoAssignees] = useState<PickedUser[]>(
    task.coAssignees.flatMap((user) => {
      const picked = pickedOf(user)
      return picked ? [picked] : []
    }),
  )
  const [controller, setController] = useState<PickedUser | null>(pickedOf(task.controller))
  const [territoryId, setTerritoryId] = useState<string | null>(task.territoryId)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [failure, setFailure] = useState<string | null>(null)

  const dueChanged = due.mode === 'working' ? hasDue(due) : due.date !== dateFromDue(task.dueAt)
  const patch = (): TaskUpdateInput => {
    const result: TaskUpdateInput = {}
    if (title.trim() !== task.title) result.title = title.trim()
    if (description.trim() !== (task.description ?? '')) {
      result.description = description.trim() || null
    }
    if (Number(priority) !== task.priority) result.priority = Number(priority)
    if (dueChanged) {
      const fields = dueFields(due)
      if (fields.dueWorkingDays !== undefined) result.dueWorkingDays = fields.dueWorkingDays
      else result.dueAt = fields.dueAt ?? null
      if (dueComment.trim()) result.dueComment = dueComment.trim()
    }
    if ((assignee?.id ?? null) !== (task.assignee?.id ?? null)) {
      result.assigneeId = assignee?.id ?? null
    }
    const coIds = coAssignees.map((user) => user.id)
    const before = task.coAssignees.map((user) => user.id)
    if (coIds.length !== before.length || coIds.some((id) => !before.includes(id))) {
      result.coAssigneeIds = coIds
    }
    if (instruction && (controller?.id ?? null) !== (task.controller?.id ?? null)) {
      result.controllerId = controller?.id ?? null
    }
    if (territoryId !== task.territoryId) result.territoryId = territoryId
    return result
  }

  const save = useMutation({
    mutationFn: () => http.patch('/tasks/:id', { params: { id: task.id }, body: patch() }),
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
    (!instruction || (assignee !== null && hasDue(due))) &&
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
          {instruction && !part ? (
            <Field
              label={t('tasks.fields.coAssignees')}
              hint={t('tasks.create.coAssigneesHint')}
              error={fieldErrors.coAssigneeIds}
            >
              <UsersPicker
                value={coAssignees}
                onChange={setCoAssignees}
                label={t('tasks.fields.coAssignees')}
                exclude={assignee ? [assignee.id] : []}
              />
            </Field>
          ) : null}
          {instruction && !part ? (
            <Field label={t('tasks.fields.controller')} error={fieldErrors.controllerId}>
              <UserPicker
                value={controller}
                onChange={setController}
                label={t('tasks.fields.controller')}
              />
            </Field>
          ) : null}
          <DueInput
            value={due}
            onChange={setDue}
            label={t('tasks.fields.due')}
            required={instruction}
            error={fieldErrors.dueAt ?? fieldErrors.dueWorkingDays}
          />
          {dueChanged && task.dueAt ? (
            <Field label={t('tasks.due.comment')} htmlFor={dueCommentId}>
              <Input
                id={dueCommentId}
                value={dueComment}
                onChange={(event) => setDueComment(event.target.value)}
              />
            </Field>
          ) : null}
          <Field label={t('tasks.fields.priority')}>
            <PrioritySelect value={priority} onChange={setPriority} />
          </Field>
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
      http.post('/projects', {
        body: {
          key: key.trim(),
          name: name.trim(),
          spaceId: space,
          ...(description.trim() ? { description: description.trim() } : {}),
        },
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
