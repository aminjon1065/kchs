import type { SearchHit, TaskRecord } from '@kchs/contracts'
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  Field,
  FileDropzone,
  IconButton,
  ObjectIcon,
  ProgressBar,
  SearchInput,
  Textarea,
  useDebouncedValue,
  useToast,
} from '@kchs/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useId, useState } from 'react'
import { uploadFile } from '~/entities/files/upload.js'
import { searchQuery } from '~/shared/api/queries.js'
import { useT } from '~/shared/i18n.js'
import { DueInput, type DueValue, dueFields, emptyDue, hasDue } from './due-input.js'
import { reportTask, returnTask, taskKeys } from './queries.js'
import { errorText, useTaskInvalidation } from './task-actions.js'
import { dateFromDue } from './task-status.js'

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
      reportTask(task.id, {
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
      returnTask(task.id, {
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
