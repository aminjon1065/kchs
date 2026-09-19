import type { LangText } from '@kchs/contracts'
import { formatDateTime } from '@kchs/fields'
import type { ProcessInstanceView, ProcessStepView } from '@kchs/process'
import { Avatar, Badge, Button, cn } from '@kchs/ui'
import { useQuery } from '@tanstack/react-query'
import {
  Bell,
  CircleCheck,
  FileCog,
  Hourglass,
  ListTodo,
  type LucideIcon,
  Paperclip,
  PenLine,
  Stamp,
  Undo2,
  Workflow,
} from 'lucide-react'
import { useAppearance } from '~/app/appearance.js'
import { useT } from '~/app/i18n.js'
import { useWorkspace } from '~/app/workspace/store.js'
import { objectQuery } from '~/shared/api/queries.js'
import {
  DECISION_LABELS,
  ENTRY_STATES,
  entryTone,
  knownKey,
  OUTCOMES,
  outcomeTone,
  STEP_TYPES,
  VISIBLE_STEP_TYPES,
} from './labels.js'

const ICONS: Record<string, LucideIcon> = {
  approval: CircleCheck,
  sign: PenLine,
  register: Stamp,
  acknowledge: CircleCheck,
  return: Undo2,
  task: ListTodo,
  notify: Bell,
  wait: Hourglass,
  call: Workflow,
  set: FileCog,
}

function text(value: LangText | null | undefined, locale: string): string | null {
  if (!value) return null
  return (value as Record<string, string | undefined>)[locale] ?? value.ru
}

/** Файл решения (замечания с правками): название — из реестра, открывается во вкладке. */
function DecisionFile({ fileId }: { fileId: string }) {
  const t = useT()
  const openTab = useWorkspace((s) => s.openTab)
  const { data } = useQuery(objectQuery(fileId))
  const title = data?.title ?? t('processes.line.file')
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={<Paperclip className="size-3.5" />}
      onClick={() =>
        openTab({ kind: 'object', objectId: fileId, objectType: 'file', title, mode: 'preview' })
      }
    >
      {title}
    </Button>
  )
}

function StepCard({
  step,
  version,
  branch,
}: {
  step: ProcessStepView
  version: number | null
  /** Номер ветви параллельного шага (с 1). */
  branch: number | null
}) {
  const t = useT()
  const locale = useAppearance((s) => s.locale)
  const Icon = ICONS[step.type] ?? Workflow
  const typeLabel = t(`processes.types.${knownKey(step.type, STEP_TYPES, 'call')}`)
  const name = text(step.name, locale) ?? typeLabel
  const active = step.status === 'active'
  const decisions = step.actions.filter((action) => action.comment || action.fileIds.length > 0)
  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-md border bg-surface p-3',
        active ? 'border-accent' : 'border-line',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="size-4 shrink-0 text-fg-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={name}>
          {name}
        </span>
        {branch !== null ? (
          <Badge tone="outline" size="sm">
            {t('processes.line.branch', { number: branch })}
          </Badge>
        ) : null}
        {version !== null ? (
          <Badge tone="outline" size="sm">
            {t('processes.line.version', { number: version })}
          </Badge>
        ) : null}
        {active ? (
          <Badge tone={step.overdue ? 'danger' : 'accent'} size="sm" dot>
            {t(step.overdue ? 'processes.line.overdue' : 'processes.stepStatus.active')}
          </Badge>
        ) : step.status === 'cancelled' ? (
          <Badge tone="neutral" size="sm">
            {t('processes.stepStatus.cancelled')}
          </Badge>
        ) : (
          <Badge tone={outcomeTone(step.outcome)} size="sm">
            {t(`processes.outcomes.${knownKey(step.outcome ?? 'done', OUTCOMES, 'done')}`)}
          </Badge>
        )}
      </div>
      {step.dueAt && active ? (
        <span className={cn('text-xs', step.overdue ? 'text-danger' : 'text-fg-muted')}>
          {t('processes.line.due', { date: formatDateTime(step.dueAt, { locale }) })}
        </span>
      ) : null}
      {step.unassigned ? (
        <span className="text-xs text-danger">{t('processes.line.unassigned')}</span>
      ) : null}
      {step.assignees.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label={t('processes.line.assignees')}>
          {step.assignees.map((entry) => (
            <li key={`${entry.user.id}:${entry.state}`} className="flex items-center gap-2">
              <Avatar name={entry.user.displayName} src={entry.user.avatarUrl} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">{entry.user.displayName}</span>
                {entry.actor || entry.delegatedTo || entry.addedBy ? (
                  <span className="block truncate text-2xs text-fg-muted">
                    {[
                      entry.actor
                        ? t('processes.line.actor', { name: entry.actor.displayName })
                        : null,
                      entry.delegatedTo
                        ? t('processes.line.delegatedTo', { name: entry.delegatedTo.displayName })
                        : null,
                      entry.addedBy
                        ? t('processes.line.addedBy', { name: entry.addedBy.displayName })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                ) : null}
              </span>
              {entry.decidedAt ? (
                <span className="shrink-0 text-2xs text-fg-muted tabular">
                  {formatDateTime(entry.decidedAt, { locale })}
                </span>
              ) : null}
              <Badge tone={entryTone(entry.state)} size="sm">
                {t(`processes.entries.${knownKey(entry.state, ENTRY_STATES, 'pending')}`)}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      {decisions.length > 0 ? (
        <ul className="flex flex-col gap-1.5 border-t border-line pt-2">
          {decisions.map((action) => (
            <li key={action.id} className="flex flex-col gap-0.5">
              <span className="text-2xs text-fg-muted">
                {t('processes.line.decision', {
                  name: action.onBehalfOf
                    ? t('processes.line.onBehalf', {
                        actor: action.actor?.displayName ?? '—',
                        name: action.onBehalfOf.displayName,
                      })
                    : (action.actor?.displayName ?? '—'),
                  action: t(
                    `processes.history.${knownKey(action.action, DECISION_LABELS, 'other')}`,
                  ),
                  date: formatDateTime(action.at, { locale }),
                })}
              </span>
              {action.comment ? (
                <p className="whitespace-pre-line text-sm text-fg-secondary">{action.comment}</p>
              ) : null}
              {action.fileIds.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {action.fileIds.map((fileId) => (
                    <DecisionFile key={fileId} fileId={fileId} />
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Линия маршрута (08-documents.md §15, ADR-0083): шаги по кругам согласования,
 * текущий выделен, у каждого — назначенные с ответами (засчитанные одобрения
 * прошлого круга, очередь, передача, заместитель), срок и просрочка, решения
 * с комментариями и файлами, версия документа, которую видел шаг.
 */
export function RouteLine({
  view,
  versions,
}: {
  view: ProcessInstanceView
  /** Шаг → номер версии объекта, замороженной для него. */
  versions?: ReadonlyMap<string, number>
}) {
  const t = useT()
  const steps = view.steps.filter((step) => VISIBLE_STEP_TYPES.has(step.type))
  const rounds = [...new Set(steps.map((step) => step.round))].sort((a, b) => a - b)
  const parallel = new Map(
    view.steps.filter((step) => step.type === 'parallel').map((step) => [step.id, step]),
  )
  return (
    <div className="flex flex-col gap-4">
      {rounds.map((round) => (
        <section key={round} className="flex flex-col gap-2">
          {rounds.length > 1 ? (
            <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
              {t('processes.line.round', { round })}
            </h3>
          ) : null}
          <ol className="flex flex-col gap-2">
            {steps
              .filter((step) => step.round === round)
              .map((step) => {
                const inBranch = Boolean(step.parentId && parallel.has(step.parentId))
                return (
                  <li
                    key={step.id}
                    className={cn(inBranch && 'pl-4')}
                    aria-current={step.status === 'active' ? 'step' : undefined}
                  >
                    <StepCard
                      step={step}
                      version={versions?.get(step.id) ?? null}
                      branch={inBranch ? (step.branch ?? 0) + 1 : null}
                    />
                  </li>
                )
              })}
          </ol>
        </section>
      ))}
    </div>
  )
}
