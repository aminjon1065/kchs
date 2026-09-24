import type { Step } from '@kchs/process'
import {
  Button,
  Callout,
  EmptyState,
  Field,
  IconButton,
  Input,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@kchs/ui'
import { MousePointerClick, Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { addBranch, issuesByStep, layoutOf, renameStep, updateStep } from '../model.js'
import { AssigneeEditor } from './assignee-editor.js'
import { useDesigner, useStepTitle } from './context.js'
import {
  DeadlineInput,
  ExpressionInput,
  JsonInput,
  LangFields,
  NONE,
  NumberInput,
  StepSelect,
} from './fields.js'
import { StepIcon } from './summary.js'

type Patch = Record<string, unknown>

/**
 * Инспектор шага (08-documents.md §4): название, ключ, назначенные, порядок и
 * кворум, срок в рабочих днях или часах, переход при отклонении и далее — поля по типу
 * шага; внизу — проблемы проверки этого шага.
 */
export function StepInspector({ stepKey }: { stepKey: string }) {
  const t = useT()
  const { definition, update, issues } = useDesigner()
  const step = definition.steps[stepKey]
  if (!step) {
    return (
      <EmptyState
        icon={<MousePointerClick className="size-5" />}
        title={t('processDesigner.inspector.empty')}
      />
    )
  }
  const owner = layoutOf(definition).owners.get(stepKey)
  const patch = (changes: Patch) => {
    const next: Record<string, unknown> = { ...step }
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) delete next[name]
      else next[name] = value
    }
    update((current) => updateStep(current, stepKey, next as Step))
  }
  const stepIssues = issuesByStep(issues).get(stepKey) ?? []

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-fg">
        <StepIcon type={step.type} />
        {t(`processDesigner.types.${step.type}`)}
      </div>
      {stepIssues.length > 0 ? (
        <Callout tone="danger" title={t('processDesigner.inspector.issues')}>
          <ul className="list-disc pl-4">
            {stepIssues.map((issue) => (
              <li key={`${issue.path}:${issue.code}`}>{issue.message}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      <LangFields
        label={t('processDesigner.inspector.name')}
        value={step.name}
        onChange={(name) => patch({ name })}
      />
      <KeyField stepKey={stepKey} />
      <TypeFields stepKey={stepKey} step={step} patch={patch} />
      {owner ? (
        <p className="text-xs text-fg-muted">
          {t('processDesigner.inspector.inBranch', { n: owner.branch + 1 })}
        </p>
      ) : 'next' in step || (step.type !== 'condition' && step.type !== 'end') ? (
        <StepSelect
          label={t('processDesigner.inspector.next')}
          value={'next' in step ? step.next : undefined}
          exclude={stepKey}
          noneLabel={t('processDesigner.inspector.nextNone')}
          onChange={(next) => patch({ next })}
        />
      ) : null}
    </div>
  )
}

function KeyField({ stepKey }: { stepKey: string }) {
  const t = useT()
  const id = useId()
  const { definition, update, select, readOnly } = useDesigner()
  const [draft, setDraft] = useState(stepKey)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setDraft(stepKey)
    setError(null)
  }, [stepKey])
  const commit = () => {
    const next = draft.trim()
    if (next === stepKey) return setError(null)
    const renamed = renameStep(definition, stepKey, next)
    if (renamed === definition) {
      setError(t('processDesigner.inspector.keyInvalid'))
      return
    }
    setError(null)
    update(() => renamed)
    select({ kind: 'step', key: next })
  }
  return (
    <Field
      label={t('processDesigner.inspector.key')}
      hint={t('processDesigner.inspector.keyHint')}
      error={error ?? undefined}
      htmlFor={id}
    >
      <Input
        id={id}
        value={draft}
        readOnly={readOnly}
        className="font-mono text-xs"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
      />
    </Field>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-end gap-3">{children}</div>
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  const { readOnly } = useDesigner()
  return <Switch label={label} checked={checked} disabled={readOnly} onCheckedChange={onChange} />
}

function ChoiceSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (next: T) => void
}) {
  const id = useId()
  const { readOnly } = useDesigner()
  return (
    <Field label={label} htmlFor={id}>
      <Select value={value} disabled={readOnly} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger id={id} aria-label={label} className="min-w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

/** Переход при отклонении: умолчание — завершить маршрут (`end:rejected`). */
function RejectSelect({
  stepKey,
  value,
  label,
  onChange,
}: {
  stepKey: string
  value: string | undefined
  label: string
  onChange: (next: string | undefined) => void
}) {
  const t = useT()
  return (
    <StepSelect
      label={label}
      value={value === 'end:rejected' ? undefined : value}
      exclude={stepKey}
      noneLabel={t('processDesigner.inspector.rejectDefault')}
      extra={[{ value: 'continue', label: t('processDesigner.inspector.rejectContinue') }]}
      onChange={onChange}
    />
  )
}

/**
 * Срок шага: рабочие дни по производственному календарю или календарные часы
 * (ADR-0131) — два поля определения, одно на экране. Ключ шага сбрасывает
 * выбранную единицу при переходе к другому шагу.
 */
function DueInput({
  stepKey,
  step,
  patch,
}: {
  stepKey: string
  step: { dueWorkingDays?: number | undefined; dueHours?: number | undefined }
  patch: (changes: Patch) => void
}) {
  const t = useT()
  return (
    <DeadlineInput
      key={`${stepKey}:due`}
      value={{ days: step.dueWorkingDays, hours: step.dueHours }}
      onChange={(next) => patch({ dueWorkingDays: next.days, dueHours: next.hours })}
      labels={{
        days: t('processDesigner.inspector.due'),
        hours: t('processDesigner.inspector.dueHours'),
      }}
      hints={{
        days: t('processDesigner.inspector.dueHint'),
        hours: t('processDesigner.inspector.dueHoursHint'),
      }}
    />
  )
}

function TypeFields({
  stepKey,
  step,
  patch,
}: {
  stepKey: string
  step: Step
  patch: (changes: Patch) => void
}) {
  const t = useT()
  const titleOf = useStepTitle()
  const { definition, update, catalog, readOnly } = useDesigner()
  switch (step.type) {
    case 'approval': {
      const quorumKind = typeof step.quorum === 'number' ? 'n' : step.quorum
      return (
        <>
          <Field label={t('processDesigner.inspector.approvers')}>
            <AssigneeEditor
              label={t('processDesigner.inspector.approvers')}
              value={step.assignees}
              onChange={(assignees) => patch({ assignees })}
            />
          </Field>
          <Field label={t('processDesigner.inspector.mode')}>
            <SegmentedControl
              aria-label={t('processDesigner.inspector.mode')}
              value={step.mode}
              onValueChange={(mode) => !readOnly && patch({ mode })}
              options={(['parallel', 'sequential', 'any'] as const).map((mode) => ({
                value: mode,
                label: t(`processDesigner.inspector.modes.${mode}`),
              }))}
            />
          </Field>
          {step.mode === 'any' ? null : (
            <Row>
              <ChoiceSelect
                label={t('processDesigner.inspector.quorum')}
                value={quorumKind}
                options={(['all', 'any', 'n'] as const).map((kind) => ({
                  value: kind,
                  label: t(`processDesigner.inspector.quorums.${kind}`),
                }))}
                onChange={(kind) =>
                  patch({
                    quorum: kind === 'n' ? Math.max(1, Math.min(2, step.assignees.length)) : kind,
                  })
                }
              />
              {typeof step.quorum === 'number' ? (
                <NumberInput
                  label={t('processDesigner.inspector.quorumN')}
                  value={step.quorum}
                  min={1}
                  max={100}
                  onChange={(quorum) => patch({ quorum: quorum ?? 1 })}
                />
              ) : null}
            </Row>
          )}
          <DueInput stepKey={stepKey} step={step} patch={patch} />
          <RejectSelect
            stepKey={stepKey}
            label={t('processDesigner.inspector.onReject')}
            value={step.onReject}
            onChange={(onReject) => patch({ onReject })}
          />
          <Toggle
            label={t('processDesigner.inspector.allowAddApprover')}
            checked={step.allowAddApprover}
            onChange={(allowAddApprover) => patch({ allowAddApprover })}
          />
          <Toggle
            label={t('processDesigner.inspector.allowDelegate')}
            checked={step.allowDelegate}
            onChange={(allowDelegate) => patch({ allowDelegate })}
          />
        </>
      )
    }
    case 'sign':
      return (
        <>
          <Field label={t('processDesigner.inspector.signers')}>
            <AssigneeEditor
              label={t('processDesigner.inspector.signers')}
              value={step.assignees}
              onChange={(assignees) => patch({ assignees })}
            />
          </Field>
          <Field label={t('processDesigner.inspector.mode')}>
            <SegmentedControl
              aria-label={t('processDesigner.inspector.mode')}
              value={step.mode}
              onValueChange={(mode) => !readOnly && patch({ mode })}
              options={(['parallel', 'sequential'] as const).map((mode) => ({
                value: mode,
                label: t(`processDesigner.inspector.modes.${mode}`),
              }))}
            />
          </Field>
          <DueInput stepKey={stepKey} step={step} patch={patch} />
          <Toggle
            label={t('processDesigner.inspector.requireMfa')}
            checked={step.requireMfa}
            onChange={(requireMfa) => patch({ requireMfa })}
          />
          <ChoiceSelect
            label={t('processDesigner.inspector.signatureKind')}
            value={step.signatureKind}
            options={(['simple', 'qualified'] as const).map((kind) => ({
              value: kind,
              label: t(`processDesigner.inspector.signatureKinds.${kind}`),
            }))}
            onChange={(signatureKind) => patch({ signatureKind })}
          />
          <RejectSelect
            stepKey={stepKey}
            label={t('processDesigner.inspector.signOnReject')}
            value={step.onReject}
            onChange={(onReject) => patch({ onReject })}
          />
        </>
      )
    case 'register':
      return (
        <>
          <Field
            label={t('processDesigner.inspector.registrars')}
            hint={t('processDesigner.inspector.registrarsHint')}
          >
            <AssigneeEditor
              label={t('processDesigner.inspector.registrars')}
              value={step.assignees ?? []}
              allowEmpty
              onChange={(assignees) =>
                patch({ assignees: assignees.length > 0 ? assignees : undefined })
              }
            />
          </Field>
          <ExpressionInput
            label={t('processDesigner.inspector.journal')}
            hint={t('processDesigner.inspector.journalHint')}
            value={step.journal ?? ''}
            onChange={(journal) => patch({ journal: journal.trim() ? journal : undefined })}
          />
          <DueInput stepKey={stepKey} step={step} patch={patch} />
        </>
      )
    case 'acknowledge':
      return (
        <>
          <Field label={t('processDesigner.inspector.readers')}>
            <AssigneeEditor
              label={t('processDesigner.inspector.readers')}
              value={step.assignees}
              onChange={(assignees) => patch({ assignees })}
            />
          </Field>
          <DueInput stepKey={stepKey} step={step} patch={patch} />
        </>
      )
    case 'task':
      return (
        <>
          <LangFields
            label={t('processDesigner.inspector.taskTitle')}
            value={step.title}
            required
            onChange={(title) => patch({ title: title ?? { ru: '' } })}
          />
          <Field label={t('processDesigner.inspector.executors')}>
            <AssigneeEditor
              label={t('processDesigner.inspector.executors')}
              value={step.assignees}
              onChange={(assignees) => patch({ assignees })}
            />
          </Field>
          <DueInput stepKey={stepKey} step={step} patch={patch} />
          <JsonInput
            label={t('processDesigner.inspector.params')}
            value={step.params}
            objectOnly
            onChange={(params) => patch({ params })}
          />
        </>
      )
    case 'condition':
      return (
        <>
          <p className="text-xs text-fg-muted">{t('processDesigner.inspector.conditionHint')}</p>
          <ol className="flex flex-col gap-3">
            {step.branches.map((branch, index) => (
              <li key={index} className="flex flex-col gap-2 rounded-md border border-line p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-fg-secondary">
                    {t('processDesigner.inspector.conditionN', { n: index + 1 })}
                  </span>
                  {readOnly || step.branches.length <= 1 ? null : (
                    <IconButton
                      label={t('processDesigner.inspector.removeCondition', { n: index + 1 })}
                      size="sm"
                      onClick={() =>
                        patch({ branches: step.branches.filter((_, item) => item !== index) })
                      }
                    >
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  )}
                </div>
                <ExpressionInput
                  label={t('processDesigner.inspector.if')}
                  multiline
                  value={branch.if}
                  placeholder="object.fields.amount > 1000000"
                  onChange={(value) =>
                    patch({
                      branches: step.branches.map((item, position) =>
                        position === index ? { ...item, if: value } : item,
                      ),
                    })
                  }
                />
                <StepSelect
                  label={t('processDesigner.inspector.thenGo')}
                  value={branch.next || undefined}
                  exclude={stepKey}
                  onChange={(next) =>
                    patch({
                      branches: step.branches.map((item, position) =>
                        position === index ? { ...item, next: next ?? '' } : item,
                      ),
                    })
                  }
                />
              </li>
            ))}
          </ol>
          {readOnly ? null : (
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  patch({
                    branches: [
                      ...step.branches,
                      { if: 'true', next: step.else ?? step.branches[0]?.next ?? '' },
                    ],
                  })
                }
              >
                <Plus className="size-3.5" />
                {t('processDesigner.inspector.addCondition')}
              </Button>
            </div>
          )}
          <StepSelect
            label={t('processDesigner.inspector.else')}
            value={step.else}
            exclude={stepKey}
            noneLabel={t('processDesigner.inspector.nextNone')}
            onChange={(next) => patch({ else: next })}
          />
        </>
      )
    case 'parallel':
      return (
        <>
          <Field label={t('processDesigner.inspector.join')}>
            <SegmentedControl
              aria-label={t('processDesigner.inspector.join')}
              value={step.join}
              onValueChange={(join) => !readOnly && patch({ join })}
              options={(['all', 'any'] as const).map((join) => ({
                value: join,
                label: t(`processDesigner.summary.join.${join}`),
              }))}
            />
          </Field>
          <p className="text-xs text-fg-muted">
            {t('processDesigner.inspector.branchesCount', { count: step.branches.length })}
          </p>
          {readOnly ? null : (
            <div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => update((current) => addBranch(current, stepKey))}
              >
                <Plus className="size-3.5" />
                {t('processDesigner.flow.addBranch')}
              </Button>
            </div>
          )}
        </>
      )
    case 'wait': {
      const events = catalog?.waitEvents ?? []
      return (
        <>
          <ChoiceSelect
            label={t('processDesigner.inspector.event')}
            value={step.event ?? NONE}
            options={[
              { value: NONE, label: t('processDesigner.inspector.eventNone') },
              ...(step.event && !events.includes(step.event)
                ? [{ value: step.event, label: step.event }]
                : []),
              ...events.map((event) => ({ value: event, label: event })),
            ]}
            onChange={(event) => patch({ event: event === NONE ? undefined : event })}
          />
          {step.event ? (
            <ExpressionInput
              label={t('processDesigner.inspector.filter')}
              multiline
              value={step.filter ?? ''}
              placeholder="event.payload.number > 1"
              onChange={(filter) => patch({ filter: filter.trim() ? filter : undefined })}
            />
          ) : null}
          <DeadlineInput
            key={`${stepKey}:duration`}
            value={{ days: step.durationWorkingDays, hours: step.durationHours }}
            onChange={(next) =>
              patch({ durationWorkingDays: next.days, durationHours: next.hours })
            }
            labels={{
              days: t('processDesigner.inspector.duration'),
              hours: t('processDesigner.inspector.durationHours'),
            }}
            hints={{
              days: t('processDesigner.inspector.durationHint'),
              hours: t('processDesigner.inspector.dueHoursHint'),
            }}
          />
          <ExpressionInput
            label={t('processDesigner.inspector.until')}
            hint={t('processDesigner.inspector.untilHint')}
            value={step.until ?? ''}
            onChange={(until) => patch({ until: until.trim() ? until : undefined })}
          />
        </>
      )
    }
    case 'notify':
      return (
        <>
          <Field label={t('processDesigner.inspector.recipients')}>
            <AssigneeEditor
              label={t('processDesigner.inspector.recipients')}
              value={typeof step.to === 'string' ? [step.to] : step.to}
              onChange={(to) => patch({ to: to.length === 1 ? to[0] : to })}
            />
          </Field>
          <ExpressionInput
            label={t('processDesigner.inspector.template')}
            hint={t('processDesigner.inspector.templateHint')}
            value={step.template ?? ''}
            onChange={(template) => patch({ template: template.trim() ? template : undefined })}
          />
        </>
      )
    case 'set':
      return (
        <>
          <ExpressionInput
            label={t('processDesigner.inspector.field')}
            value={step.field}
            onChange={(field) => patch({ field })}
          />
          <JsonInput
            label={t('processDesigner.inspector.value')}
            value={step.value}
            onChange={(value) => patch({ value })}
          />
        </>
      )
    case 'call': {
      const actions = (catalog?.handlers ?? [])
        .filter((handler) => handler.type === 'call' && handler.action)
        .map((handler) => handler.action as string)
      return (
        <>
          <ExpressionInput
            label={t('processDesigner.inspector.action')}
            hint={
              actions.length > 0
                ? t('processDesigner.inspector.actionHint', { list: actions.join(', ') })
                : undefined
            }
            value={step.action}
            onChange={(action) => patch({ action })}
          />
          <JsonInput
            label={t('processDesigner.inspector.params')}
            value={step.params}
            objectOnly
            onChange={(params) => patch({ params })}
          />
        </>
      )
    }
    case 'return':
      return (
        <>
          <Field label={t('processDesigner.inspector.returnTo')}>
            <AssigneeEditor
              label={t('processDesigner.inspector.returnTo')}
              value={[step.to]}
              single
              onChange={(to) => patch({ to: to[0] ?? 'author' })}
            />
          </Field>
          <ChoiceSelect
            label={t('processDesigner.inspector.reapproval')}
            value={step.reapproval}
            options={(['full', 'rejecters_only'] as const).map((kind) => ({
              value: kind,
              label: t(`processDesigner.inspector.reapprovals.${kind}`),
            }))}
            onChange={(reapproval) => patch({ reapproval })}
          />
          <DueInput stepKey={stepKey} step={step} patch={patch} />
          <p className="text-xs text-fg-muted">
            {t('processDesigner.inspector.returnHint', {
              step: step.next ? titleOf(step.next, definition.steps[step.next]) : '—',
            })}
          </p>
        </>
      )
    case 'end':
      return (
        <ExpressionInput
          label={t('processDesigner.inspector.outcome')}
          hint={t('processDesigner.inspector.outcomeHint')}
          value={step.outcome}
          onChange={(outcome) => patch({ outcome })}
        />
      )
  }
}
