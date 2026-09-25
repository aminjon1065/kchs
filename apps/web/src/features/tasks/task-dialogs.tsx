import type {
  SearchHit,
  TaskExtensionDecisionInput,
  TaskRecord,
  TaskSource,
  TaskUpdateInput,
} from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  FileDropzone,
  IconButton,
  Input,
  ObjectIcon,
  ProgressBar,
  RadioGroup,
  RadioItem,
  SearchInput,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useId, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { uploadFile } from '~/features/files/upload.js'
import { TerritorySelect } from '~/features/gis/territory-select.js'
import { ApiError, http } from '~/shared/api/client.js'
import { searchQuery, spacesQuery } from '~/shared/api/queries.js'
import { orderSpaces } from '~/shared/spaces.js'
import { DueInput, type DueValue, dueFields, emptyDue, hasDue } from './due-input.js'
import { projectsQuery, taskKeys } from './queries.js'
import { errorText, useTaskInvalidation } from './task-actions.js'
import { dateFromDue, PRIORITIES, pickedOf } from './task-status.js'
import { type PickedUser, UserPicker, UsersPicker } from './user-picker.js'

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
        ...(instruction && coAssignees.length > 0
          ? { coAssigneeIds: coAssignees.map((user) => user.id) }
          : {}),
        ...(instruction && controller ? { controllerId: controller.id } : {}),
        ...dueFields(due),
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

  const ready = title.trim().length > 0 && (!instruction || (assignee !== null && hasDue(due)))
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
          <DueInput
            value={due}
            onChange={setDue}
            label={t('tasks.fields.due')}
            required={instruction}
            error={fieldErrors.dueAt ?? fieldErrors.dueWorkingDays}
          />
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

/** Объект отчёта в форме: вложение (загружено к поручению) или найденный объект. */
interface ReportObject {
  id: string
  type: string
  title: string
}

/**
 * Отчёт исполнителя (10-tasks-projects.md §4): текст обязателен; файлы
 * загружаются вложениями поручения, подготовленные объекты (документ, отчёт)
 * находятся поиском — всё уходит автору на приёмку вместе с текстом.
 */
export function ReportDialog({
  task,
  initial,
  onClose,
}: {
  task: { id: string; key: string; title: string; spaceId: string | null }
  /** Готовый отчёт (ADR-0136): форма открывается с его текстом и материалами. */
  initial?: { text: string; objects: ReportObject[] }
  onClose: () => void
}) {
  const t = useT()
  const toast = useToast()
  const client = useQueryClient()
  const invalidate = useTaskInvalidation()
  const textId = useId()
  const [text, setText] = useState(initial?.text ?? '')
  const [objects, setObjects] = useState<ReportObject[]>(initial?.objects ?? [])
  const [uploads, setUploads] = useState<Record<string, { name: string; progress: number }>>({})
  const [search, setSearch] = useState('')
  const q = useDebouncedValue(search.trim(), 250)
  const { data: found } = useQuery(searchQuery({ q, limit: 6 }))
  const [failure, setFailure] = useState<string | null>(null)
  const uploading = Object.keys(uploads).length > 0

  const add = (object: ReportObject) =>
    setObjects((current) =>
      current.some((item) => item.id === object.id) ? current : [...current, object],
    )

  const attach = async (files: File[]) => {
    if (!task.spaceId) return
    for (const file of files) {
      const key = `${file.name}:${file.size}:${file.lastModified}`
      setUploads((current) => ({ ...current, [key]: { name: file.name, progress: 0 } }))
      try {
        const created = await uploadFile({
          file,
          spaceId: task.spaceId,
          attachToObjectId: task.id,
          onProgress: (progress) =>
            setUploads((current) => ({ ...current, [key]: { name: file.name, progress } })),
        })
        add({ id: created.id, type: 'file', title: file.name })
      } catch {
        toast.error(t('objects.attachments.failed', { name: file.name }))
      } finally {
        setUploads((current) => {
          const next = { ...current }
          delete next[key]
          return next
        })
      }
    }
  }

  const report = useMutation({
    mutationFn: () =>
      http.post<TaskRecord>(`/tasks/${task.id}/report`, {
        text: text.trim(),
        objectIds: objects.map((object) => object.id),
      }),
    onSuccess: (record) => {
      client.setQueryData(taskKeys.task(task.id), record)
      toast.show({ title: t('tasks.report.sent'), tone: 'success' })
      invalidate(task.id)
      onClose()
    },
    onError: (error) => setFailure(errorText(error, t('errors.unknown'))),
  })

  const candidates = (found?.hits ?? []).filter(
    (hit: SearchHit) =>
      hit.objectId !== task.id && !objects.some((item) => item.id === hit.objectId),
  )
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
              disabled={!text.trim() || uploading}
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
          <Field label={t('tasks.report.objects')} hint={t('tasks.report.objectsHint')}>
            <div className="flex flex-col gap-2">
              {objects.length > 0 ? (
                <ul aria-label={t('tasks.report.objects')} className="flex flex-col gap-1">
                  {objects.map((object) => (
                    <li
                      key={object.id}
                      className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm"
                    >
                      <ObjectIcon type={object.type} className="size-4 shrink-0 text-fg-muted" />
                      <span className="min-w-0 flex-1 truncate">{object.title}</span>
                      <IconButton
                        size="sm"
                        label={t('common.actions.remove')}
                        onClick={() =>
                          setObjects((current) => current.filter((item) => item.id !== object.id))
                        }
                      >
                        <X className="size-3.5" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              ) : null}
              {Object.entries(uploads).map(([key, upload]) => (
                <div key={key} className="flex flex-col gap-1 text-xs text-fg-muted">
                  <span>{upload.name}</span>
                  <ProgressBar value={upload.progress} />
                </div>
              ))}
              {task.spaceId ? (
                <FileDropzone compact onFiles={(files) => void attach(files)} />
              ) : null}
              <SearchInput
                value={search}
                onValueChange={setSearch}
                placeholder={t('tasks.report.findObject')}
                aria-label={t('tasks.report.findObject')}
              />
              {q && candidates.length > 0 ? (
                <ul
                  aria-label={t('tasks.report.findObject')}
                  className="max-h-40 overflow-y-auto rounded-md border border-line p-1"
                >
                  {candidates.map((hit) => (
                    <li key={hit.objectId}>
                      <button
                        type="button"
                        onClick={() => {
                          add({ id: hit.objectId, type: hit.type, title: hit.title })
                          setSearch('')
                        }}
                        className="flex w-full items-center gap-2 rounded-xs px-2 py-1.5 text-left text-sm hover:bg-surface-3"
                      >
                        <ObjectIcon type={hit.type} className="size-4 shrink-0 text-fg-muted" />
                        <span className="min-w-0 flex-1 truncate">{hit.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
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
  const [comment, setComment] = useState('')
  const [due, setDue] = useState<DueValue>(emptyDue(dateFromDue(task.dueAt)))
  const [failure, setFailure] = useState<string | null>(null)
  const dueChanged =
    due.mode === 'working' ? hasDue(due) : due.date !== '' && due.date !== dateFromDue(task.dueAt)

  const send = useMutation({
    mutationFn: () =>
      http.post<TaskRecord>(`/tasks/${task.id}/return`, {
        comment: comment.trim(),
        ...(dueChanged ? dueFields(due) : {}),
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
          <DueInput value={due} onChange={setDue} label={t('tasks.return.newDue')} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

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
      http.post<TaskRecord>(`/tasks/${task.id}/extension`, {
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
      setFieldErrors(error instanceof ApiError ? error.fieldErrors() : {})
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
  const locale = useAppearance((s) => s.locale)
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
      return http.post<TaskRecord>(`/tasks/${task.id}/extension/decide`, body)
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
      http.post<TaskRecord>(`/tasks/${task.id}/reassign`, {
        assigneeId: assignee?.id,
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      }),
    onSuccess: (record) => {
      client.setQueryData(taskKeys.task(task.id), record)
      toast.show({ title: t('tasks.done.reassign'), tone: 'success' })
      invalidate(task.id)
      onClose()
    },
    onError: (error) => {
      setFieldErrors(error instanceof ApiError ? error.fieldErrors() : {})
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
