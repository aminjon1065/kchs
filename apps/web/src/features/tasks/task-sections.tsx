import type { Locale, TaskRecord } from '@kchs/contracts'
import { formatDate, formatDateTime } from '@kchs/fields'
import { Badge, Button, ObjectChip, ObjectIcon, StatusBadge, UserChip } from '@kchs/ui'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { STATUS_TONE_KEY } from './task-status.js'

/**
 * Части соисполнителей основного поручения (10-tasks-projects.md §4,
 * ADR-0082): ответственный исполнитель видит их состояние и сроки.
 */
export function PartsSection({ task }: { task: TaskRecord }) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const openTab = useWorkspace((s) => s.openTab)
  if (task.parts.length === 0) return null
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h2 className="text-sm font-semibold text-fg">{t('tasks.parts.title')}</h2>
      <p className="mb-2 text-xs text-fg-muted">{t('tasks.parts.hint')}</p>
      <ul aria-label={t('tasks.parts.title')} className="divide-y divide-line">
        {task.parts.map((part) => (
          <li key={part.id} className="flex flex-wrap items-center gap-3 py-2">
            <Button
              variant="link"
              size="sm"
              onClick={() =>
                openTab({
                  kind: 'object',
                  objectId: part.id,
                  objectType: 'task',
                  title: task.title,
                  mode: 'permanent',
                })
              }
            >
              {part.key}
            </Button>
            {part.assignee ? <UserChip user={part.assignee} /> : null}
            <StatusBadge
              status={STATUS_TONE_KEY[part.status]}
              label={t(`tasks.statuses.${part.status}`)}
            />
            {part.dueAt ? (
              <span className={part.overdue ? 'text-xs text-danger' : 'text-xs text-fg-muted'}>
                {formatDate(part.dueAt, { locale })}
              </span>
            ) : null}
            {part.overdue ? (
              <Badge tone="danger" size="sm">
                {t('common.time.overdue')}
              </Badge>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** История сроков: кто, когда, с какого срока на какой и почему. */
export function DueHistorySection({
  task,
  ctx,
}: {
  task: TaskRecord
  ctx: { locale: Locale; timezone?: string }
}) {
  const t = useT()
  if (task.dueHistory.length === 0) return null
  const date = (value: string | null) => (value ? formatDate(value, { locale: ctx.locale }) : '—')
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h2 className="mb-2 text-sm font-semibold text-fg">{t('tasks.history.title')}</h2>
      <ol aria-label={t('tasks.history.title')} className="flex flex-col gap-2">
        {task.dueHistory.map((change) => (
          <li key={change.id} className="flex flex-col gap-0.5 text-sm">
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={change.reason === 'extension' ? 'warning' : 'neutral'} size="sm">
                {t(`tasks.history.reasons.${change.reason}`)}
              </Badge>
              <span className="tabular text-fg">
                {change.from
                  ? t('tasks.history.change', { from: date(change.from), to: date(change.to) })
                  : date(change.to)}
              </span>
              {change.workingDays !== null ? (
                <span className="text-xs text-fg-muted">
                  {t('tasks.due.workingDaysShort', { count: change.workingDays })}
                </span>
              ) : null}
            </span>
            <span className="text-xs text-fg-muted">
              {[
                change.actor?.displayName ?? t('tasks.history.system'),
                change.onBehalfOf
                  ? t('tasks.history.onBehalf', { name: change.onBehalfOf.displayName })
                  : null,
                formatDateTime(change.at, ctx),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {change.comment ? (
              <span className="whitespace-pre-line text-xs text-fg-secondary">
                {change.comment}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  )
}

/** Вложения и подготовленные объекты отчёта: чип — если объект виден смотрящему. */
export function ResultObjects({ task }: { task: TaskRecord }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const objects = task.result?.objects ?? []
  if (objects.length === 0) return null
  return (
    <ul aria-label={t('tasks.report.objects')} className="mt-2 flex flex-wrap gap-2">
      {objects.map((object) => (
        <li key={object.id}>
          {object.title ? (
            <ObjectChip
              object={{ id: object.id, type: object.type, title: object.title }}
              onOpen={(item) =>
                openTab({
                  kind: 'object',
                  objectId: item.id,
                  objectType: item.type,
                  title: item.title,
                  mode: 'permanent',
                })
              }
            />
          ) : (
            <span className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-fg-muted">
              <ObjectIcon type={object.type} className="size-3.5" />
              {t('tasks.report.noAccess')}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
