import type { TaskListItem, TaskRecord } from '@kchs/contracts'
import { formatDate } from '@kchs/fields'
import { cn, EmptyState, useToast } from '@kchs/ui'
import { useMutation } from '@tanstack/react-query'
import { GanttChart } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from 'react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { ApiError, http } from '~/shared/api/client.js'
import { useTaskInvalidation } from './task-actions.js'
import { dateFromDue, dueFromDate } from './task-status.js'

const DAY_WIDTH = 28
const DAY_MS = 86_400_000

/** Полночь местной даты `ГГГГ-ММ-ДД` — счёт дней таймлайна идёт по местным суткам. */
function dayStart(date: string): number {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number)
  return new Date(year, month - 1, day).getTime()
}

function addDays(date: string, days: number): string {
  return dateFromDue(new Date(dayStart(date) + days * DAY_MS + DAY_MS / 2).toISOString())
}

function daysBetween(from: string, to: string): number {
  return Math.round((dayStart(to) - dayStart(from)) / DAY_MS)
}

/** Полоса задачи: плановое начало (иначе создание) и срок. */
function span(item: TaskListItem): { start: string; end: string } | null {
  if (!item.dueAt) return null
  const end = dateFromDue(item.dueAt)
  const startRaw = dateFromDue(item.startAt ?? item.createdAt)
  return { start: startRaw > end ? end : startRaw, end }
}

type Drag = { id: string; mode: 'move' | 'end'; x: number; delta: number }

/**
 * Таймлайн задач (ADR-0155): полоса от планового начала до срока. Перетаскивание полосы
 * переносит оба края, правого края — только срок; сохраняет сервер с проверкой прав
 * (у поручения срок правит автор). Shift+стрелки на полосе двигают срок на день.
 */
export function TaskTimeline({
  items,
  onOpen,
}: {
  items: readonly TaskListItem[]
  onOpen: (item: TaskListItem) => void
}) {
  const t = useT()
  const toast = useToast()
  const locale = useAppearance((s) => s.locale)
  const invalidate = useTaskInvalidation()
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef<Drag | null>(null)

  const dated = useMemo(
    () =>
      items
        .map((item) => ({ item, span: span(item) }))
        .filter(
          (entry): entry is { item: TaskListItem; span: { start: string; end: string } } =>
            entry.span !== null,
        ),
    [items],
  )
  const undated = items.filter((item) => !item.dueAt)
  const today = dateFromDue(new Date().toISOString())
  const first = dated.reduce(
    (min, entry) => (entry.span.start < min ? entry.span.start : min),
    today,
  )
  const last = dated.reduce((max, entry) => (entry.span.end > max ? entry.span.end : max), today)
  const from = addDays(first, -3)
  const days = Math.min(Math.max(daysBetween(from, last) + 8, 21), 400)
  const columns = Array.from({ length: days }, (_, index) => addDays(from, index))

  const save = useMutation({
    mutationFn: (input: { item: TaskListItem; start: string; end: string }) =>
      http.patch<TaskRecord>(`/tasks/${input.item.id}`, {
        dueAt: dueFromDate(input.end),
        ...(input.item.kind === 'instruction'
          ? {}
          : { startAt: new Date(dayStart(input.start)).toISOString() }),
      }),
    onSuccess: () => invalidate(),
    onError: (error) => {
      invalidate()
      toast.error(error instanceof ApiError ? error.message : t('errors.unknown'))
    },
  })

  const shifted = (entry: { item: TaskListItem; span: { start: string; end: string } }) => {
    if (!drag || drag.id !== entry.item.id || drag.delta === 0) return entry.span
    const end = addDays(entry.span.end, drag.delta)
    const start = drag.mode === 'move' ? addDays(entry.span.start, drag.delta) : entry.span.start
    return { start: start > end ? end : start, end }
  }

  const begin = (event: ReactPointerEvent, item: TaskListItem, mode: Drag['mode']) => {
    if (!item.can.edit) return
    event.preventDefault()
    event.stopPropagation()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    const next = { id: item.id, mode, x: event.clientX, delta: 0 }
    dragRef.current = next
    setDrag(next)
  }
  const moveDrag = (event: ReactPointerEvent) => {
    const current = dragRef.current
    if (!current) return
    const delta = Math.round((event.clientX - current.x) / DAY_WIDTH)
    if (delta === current.delta) return
    const next = { ...current, delta }
    dragRef.current = next
    setDrag(next)
  }
  const endDrag = (entry: { item: TaskListItem; span: { start: string; end: string } }) => {
    const current = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!current || current.delta === 0) return
    const end = addDays(entry.span.end, current.delta)
    const start =
      current.mode === 'move' ? addDays(entry.span.start, current.delta) : entry.span.start
    save.mutate({ item: entry.item, start: start > end ? end : start, end })
  }

  if (items.length === 0) return null
  if (dated.length === 0) {
    return (
      <EmptyState
        compact
        icon={<GanttChart />}
        title={t('tasks.timeline.empty')}
        description={t('tasks.timeline.emptyHint')}
      />
    )
  }
  const offset = (date: string) => daysBetween(from, date) * DAY_WIDTH

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-auto"
      aria-label={t('tasks.views.timeline')}
    >
      <div className="sticky top-0 z-(--z-sticky) flex border-b border-line bg-surface">
        <div className="w-64 shrink-0 border-r border-line px-3 py-1.5 text-xs text-fg-muted">
          {t('tasks.fields.title')}
        </div>
        <div className="relative flex" style={{ width: days * DAY_WIDTH }}>
          {columns.map((date) => (
            <div
              key={date}
              className={cn(
                'shrink-0 border-r border-line py-1.5 text-center text-2xs tabular',
                date === today ? 'bg-accent-subtle text-accent' : 'text-fg-muted',
              )}
              style={{ width: DAY_WIDTH }}
              title={formatDate(new Date(dayStart(date)).toISOString(), { locale })}
            >
              {date.slice(8, 10)}
            </div>
          ))}
        </div>
      </div>
      <ul className="flex flex-col">
        {dated.map((entry) => {
          const current = shifted(entry)
          const left = offset(current.start)
          const width = (daysBetween(current.start, current.end) + 1) * DAY_WIDTH
          const tone = entry.item.overdue
            ? 'bg-danger'
            : entry.item.status === 'done' || entry.item.status === 'accepted'
              ? 'bg-success'
              : 'bg-accent'
          return (
            <li key={entry.item.id} className="flex border-b border-line">
              <button
                type="button"
                className="w-64 shrink-0 truncate border-r border-line px-3 py-2 text-left text-sm text-fg hover:bg-surface-2"
                onClick={() => onOpen(entry.item)}
              >
                <span className="mr-1.5 font-mono text-xs text-fg-muted">{entry.item.key}</span>
                {entry.item.title}
              </button>
              <div className="relative" style={{ width: days * DAY_WIDTH }}>
                <button
                  type="button"
                  aria-label={t('tasks.timeline.bar', {
                    title: entry.item.title,
                    start: formatDate(new Date(dayStart(current.start)).toISOString(), { locale }),
                    end: formatDate(new Date(dayStart(current.end)).toISOString(), { locale }),
                  })}
                  className={cn(
                    'absolute top-1.5 flex h-6 items-center rounded-sm text-2xs text-accent-fg',
                    tone,
                    entry.item.can.edit ? 'cursor-grab' : 'cursor-default opacity-80',
                  )}
                  style={{ left, width }}
                  onPointerDown={(event) => begin(event, entry.item, 'move')}
                  onPointerMove={moveDrag}
                  onPointerUp={() => endDrag(entry)}
                  onDoubleClick={() => onOpen(entry.item)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onOpen(entry.item)
                    if (!entry.item.can.edit || !event.shiftKey) return
                    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
                    if (step === 0) return
                    event.preventDefault()
                    save.mutate({
                      item: entry.item,
                      start: entry.span.start,
                      end: addDays(entry.span.end, step),
                    })
                  }}
                >
                  <span className="truncate px-1.5">{entry.item.assignee?.displayName ?? ''}</span>
                  {entry.item.can.edit ? (
                    <span
                      aria-hidden
                      className="absolute top-0 right-0 h-full w-2 cursor-ew-resize rounded-r-sm"
                      onPointerDown={(event) => begin(event, entry.item, 'end')}
                    />
                  ) : null}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {undated.length > 0 ? (
        <p className="px-3 py-2 text-xs text-fg-muted">
          {t('tasks.timeline.undated', { count: undated.length })}
        </p>
      ) : null}
    </section>
  )
}
