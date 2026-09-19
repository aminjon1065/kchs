import type { StepType } from '@kchs/process'
import {
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
} from '@kchs/ui'
import {
  ArrowDown,
  ArrowUp,
  CornerDownRight,
  MoreHorizontal,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { Fragment, useMemo } from 'react'
import { useT } from '~/app/i18n.js'
import {
  addBranch,
  canBeInBranch,
  type FlowChain,
  type FlowNode,
  insertAfter,
  insertIntoBranch,
  issuesByStep,
  isTerminal,
  layoutOf,
  moveStep,
  removeBranch,
  removeStep,
  STEP_PALETTE,
} from '../model.js'
import { useDesigner, useStepTitle } from './context.js'
import { StepIcon, useStepSummary } from './summary.js'

/** Где вставлять: после шага линии (`null` — в начало) или в ветвь группы. */
type Place =
  | { kind: 'after'; key: string | null }
  | { kind: 'branch'; parallel: string; branch: number; position: number }

/**
 * Схема маршрута (08-documents.md §4): основная линия от начала, параллельные
 * группы с ветвями внутри, ниже — прочие цепочки (возвраты, ветви условий,
 * недостижимые шаги). Кнопки «+» вставляют шаг, меню карточки — сдвиг и удаление.
 */
export function FlowView() {
  const t = useT()
  const { definition } = useDesigner()
  const layout = useMemo(() => layoutOf(definition), [definition])
  return (
    <div className="@container flex flex-col gap-1 p-4">
      <ol
        aria-label={t('processDesigner.flow.label')}
        className="flex flex-col items-stretch gap-1"
      >
        <li className="flex justify-center">
          <Badge tone="neutral">
            <Play className="size-3" aria-hidden />
            {t('processDesigner.flow.start')}
          </Badge>
        </li>
        <InsertPoint place={{ kind: 'after', key: null }} />
        <ChainItems chain={layout.main} />
      </ol>
      {layout.others.length > 0 ? (
        <section aria-labelledby="flow-others" className="mt-6 flex flex-col gap-4">
          <div>
            <h3 id="flow-others" className="text-sm font-semibold text-fg">
              {t('processDesigner.flow.others')}
            </h3>
            <p className="text-xs text-fg-muted">{t('processDesigner.flow.othersHint')}</p>
          </div>
          {layout.others.map((chain) => (
            <OtherChain key={chain.nodes[0]?.key} chain={chain} />
          ))}
        </section>
      ) : null}
    </div>
  )
}

function ChainItems({ chain }: { chain: FlowChain }) {
  const t = useT()
  const titleOf = useStepTitle()
  const { definition } = useDesigner()
  return (
    <>
      {chain.nodes.map((node) => (
        <Fragment key={node.key}>
          <li>
            <StepCard node={node} />
          </li>
          {isTerminal(node.step) ? null : <InsertPoint place={{ kind: 'after', key: node.key }} />}
        </Fragment>
      ))}
      {chain.continuesTo ? (
        <li className="flex items-center justify-center gap-1.5 text-xs text-fg-muted">
          <CornerDownRight className="size-3.5" aria-hidden />
          {t('processDesigner.flow.continuesTo', {
            step: titleOf(chain.continuesTo, definition.steps[chain.continuesTo]),
          })}
        </li>
      ) : null}
    </>
  )
}

function OtherChain({ chain }: { chain: FlowChain }) {
  const t = useT()
  const titleOf = useStepTitle()
  const { definition } = useDesigner()
  const entered = chain.enteredFrom.map((item) =>
    t(`processDesigner.flow.enteredFrom.${item.via}`, {
      step: titleOf(item.key, definition.steps[item.key]),
    }),
  )
  return (
    <div className="rounded-md border border-dashed border-line p-3">
      <p className="mb-2 text-xs text-fg-muted">
        {entered.length > 0
          ? t('processDesigner.flow.entered', { list: entered.join('; ') })
          : t('processDesigner.flow.unreachable')}
      </p>
      <ol className="flex flex-col gap-1">
        <ChainItems chain={chain} />
      </ol>
    </div>
  )
}

function StepCard({ node }: { node: FlowNode }) {
  const t = useT()
  const titleOf = useStepTitle()
  const summaryOf = useStepSummary()
  const { definition, update, issues, selection, select, readOnly } = useDesigner()
  const stepIssues = useMemo(() => issuesByStep(issues).get(node.key) ?? [], [issues, node.key])
  const errors = stepIssues.filter((issue) => issue.severity === 'error').length
  const warnings = stepIssues.length - errors
  const selected = selection.kind === 'step' && selection.key === node.key
  const title = titleOf(node.key, node.step)
  const up = moveStep(definition, node.key, -1)
  const down = moveStep(definition, node.key, 1)
  const lines = summaryOf(node.step).filter(Boolean)

  return (
    <div
      data-step-key={node.key}
      className={cn(
        'rounded-md border bg-surface shadow-xs transition-colors',
        selected
          ? 'border-accent ring-2 ring-accent/30'
          : errors > 0
            ? 'border-danger'
            : 'border-line',
      )}
    >
      <div className="flex items-start gap-2 p-2.5">
        <span className="mt-0.5 text-fg-muted">
          <StepIcon type={node.step.type} />
        </span>
        <button
          type="button"
          aria-pressed={selected}
          onClick={() => select({ kind: 'step', key: node.key })}
          className="min-w-0 flex-1 rounded-xs text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <span className="block truncate text-sm font-medium text-fg">{title}</span>
          <span className="block truncate text-xs text-fg-muted">
            {t(`processDesigner.types.${node.step.type}`)} ·{' '}
            <code className="font-mono">{node.key}</code>
          </span>
          {lines.map((line) => (
            <span key={line} className="mt-0.5 block text-xs text-fg-secondary">
              {line}
            </span>
          ))}
        </button>
        {errors > 0 ? (
          <Badge tone="danger">{t('processDesigner.flow.errors', { count: errors })}</Badge>
        ) : warnings > 0 ? (
          <Badge tone="warning">{t('processDesigner.flow.warnings', { count: warnings })}</Badge>
        ) : null}
        {readOnly ? null : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={t('processDesigner.flow.actions', { step: title })} size="sm">
                <MoreHorizontal className="size-4" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                icon={<ArrowUp className="size-3.5" />}
                disabled={up === definition}
                onSelect={() => update(() => up)}
              >
                {t('processDesigner.flow.moveUp')}
              </DropdownMenuItem>
              <DropdownMenuItem
                icon={<ArrowDown className="size-3.5" />}
                disabled={down === definition}
                onSelect={() => update(() => down)}
              >
                {t('processDesigner.flow.moveDown')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                danger
                icon={<Trash2 className="size-3.5" />}
                onSelect={() => {
                  update((current) => removeStep(current, node.key))
                  if (selected) select({ kind: 'route', section: 'general' })
                }}
              >
                {t('processDesigner.flow.remove')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {node.branches ? <BranchGroup node={node} /> : null}
    </div>
  )
}

function BranchGroup({ node }: { node: FlowNode }) {
  const t = useT()
  const { update, readOnly } = useDesigner()
  const branches = node.branches ?? []
  return (
    <div className="flex flex-col gap-2 border-t border-line p-2.5">
      <div className="grid gap-2 @2xl:auto-cols-fr @2xl:grid-flow-col">
        {branches.map((branch, index) => {
          const label = t('processDesigner.flow.branch', { n: index + 1 })
          return (
            <section
              key={index}
              aria-label={label}
              className="flex min-w-0 flex-col gap-1 rounded-md border border-dashed border-line bg-surface-2 p-2"
            >
              <header className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-fg-secondary">{label}</span>
                {readOnly ? null : (
                  <IconButton
                    label={t('processDesigner.flow.removeBranch', { n: index + 1 })}
                    size="sm"
                    onClick={() => update((current) => removeBranch(current, node.key, index))}
                  >
                    <X className="size-3.5" />
                  </IconButton>
                )}
              </header>
              <ol className="flex flex-col gap-1">
                <InsertPoint
                  place={{ kind: 'branch', parallel: node.key, branch: index, position: 0 }}
                />
                {branch.map((child, position) => (
                  <Fragment key={child.key}>
                    <li>
                      <StepCard node={child} />
                    </li>
                    <InsertPoint
                      place={{
                        kind: 'branch',
                        parallel: node.key,
                        branch: index,
                        position: position + 1,
                      }}
                    />
                  </Fragment>
                ))}
              </ol>
            </section>
          )
        })}
      </div>
      {readOnly ? null : (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => update((current) => addBranch(current, node.key))}
          >
            <Plus className="size-3.5" />
            {t('processDesigner.flow.addBranch')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** Какие шаги можно вставить в место: в ветвь — без условий, возвратов и завершения. */
function paletteFor(place: Place, next: string | undefined, nextIsEnd: boolean): StepType[] {
  if (place.kind === 'branch') return STEP_PALETTE.filter(canBeInBranch)
  return STEP_PALETTE.filter((type) => {
    // Завершение — только в конце линии, условие — только перед шагом
    if (type === 'end') return !next || nextIsEnd
    if (type === 'condition') return Boolean(next)
    return true
  })
}

function InsertPoint({ place }: { place: Place }) {
  const t = useT()
  const { definition, update, select, readOnly } = useDesigner()
  if (readOnly) return <li aria-hidden className="h-3" />
  const after = place.kind === 'after' && place.key ? definition.steps[place.key] : undefined
  const next =
    place.kind === 'after'
      ? place.key
        ? after && 'next' in after
          ? after.next
          : undefined
        : definition.start
      : undefined
  const nextIsEnd = next ? definition.steps[next]?.type === 'end' : false
  const insert = (type: StepType) => {
    const result =
      place.kind === 'after'
        ? insertAfter(definition, place.key, type)
        : insertIntoBranch(definition, place.parallel, place.branch, place.position, type)
    if (!result.key) return
    update(() => result.definition)
    select({ kind: 'step', key: result.key })
  }
  return (
    <li
      className="flex justify-center"
      data-insert={
        place.kind === 'after'
          ? `after:${place.key ?? ''}`
          : `branch:${place.parallel}:${place.branch}:${place.position}`
      }
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label={t('processDesigner.flow.addHere')} size="sm" variant="ghost">
            <Plus className="size-3.5" />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-56">
          {paletteFor(place, next, nextIsEnd).map((type) => (
            <DropdownMenuItem
              key={type}
              icon={<StepIcon type={type} className="size-3.5" />}
              onSelect={() => insert(type)}
            >
              {t(`processDesigner.types.${type}`)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}
