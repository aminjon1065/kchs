import {
  deadlineOf,
  type StartCondition,
  type Step,
  type Timer,
  type Variable,
} from '@kchs/process'
import {
  Button,
  Card,
  Field,
  IconButton,
  Input,
  KeyValueList,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@kchs/ui'
import { Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { useT } from '~/app/i18n.js'
import { defaultStep } from '../model.js'
import { AssigneeEditor } from './assignee-editor.js'
import { useDesigner, useStepTitle } from './context.js'
import { DeadlineInput, ExpressionInput, LangFields, StepSelect } from './fields.js'

const VARIABLE_TYPES = [
  'user',
  'users',
  'unit',
  'group',
  'text',
  'number',
  'date',
  'boolean',
] as const
/** Шаги, которые может вставить условие запуска (ADR-0079). */
const INSERTABLE = ['approval', 'sign', 'acknowledge', 'notify'] as const
const ALL_STEPS = '*'

function Section({
  id,
  title,
  hint,
  children,
}: {
  id: string
  title: string
  hint?: string
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div>
        <h3 id={id} className="text-sm font-semibold text-fg">
          {title}
        </h3>
        {hint ? <p className="text-xs text-fg-muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}

/**
 * Настройки маршрута целиком: название, первый шаг, переменные запуска
 * (подписант, согласующие — выбирает инициатор), эскалация при просрочке и
 * условия запуска, вставляющие шаг (например, финансиста при большой сумме).
 */
export function RouteSettings() {
  const t = useT()
  const titleOf = useStepTitle()
  const { definition, update, readOnly } = useDesigner()
  return (
    <div className="flex flex-col gap-6 p-4">
      <Section id="route-general" title={t('processDesigner.route.general')}>
        <KeyValueList
          items={[
            {
              key: 'key',
              label: t('processDesigner.route.key'),
              value: <code className="font-mono text-xs">{definition.key}</code>,
            },
            {
              key: 'objectType',
              label: t('processDesigner.route.objectType'),
              value: t(`objects.types.${definition.objectType}`),
            },
          ]}
        />
        <LangFields
          label={t('processDesigner.route.name')}
          value={definition.name}
          required
          onChange={(name) => update((current) => ({ ...current, name: name ?? { ru: '' } }))}
        />
        <LangFields
          label={t('processDesigner.route.description')}
          value={definition.description}
          onChange={(description) =>
            update((current) => {
              const { description: _old, ...rest } = current
              return description ? { ...rest, description } : rest
            })
          }
        />
        <StepSelect
          label={t('processDesigner.route.start')}
          value={definition.start}
          onChange={(start) => start && update((current) => ({ ...current, start }))}
        />
        <p className="text-xs text-fg-muted">
          {t('processDesigner.route.startHint', {
            step: titleOf(definition.start, definition.steps[definition.start]),
          })}
        </p>
      </Section>
      <Variables readOnly={readOnly} />
      <Timers readOnly={readOnly} />
      <Conditions readOnly={readOnly} />
    </div>
  )
}

function Variables({ readOnly }: { readOnly: boolean }) {
  const t = useT()
  const { definition, update } = useDesigner()
  const [name, setName] = useState('')
  const nameId = useId()
  const entries = Object.entries(definition.variables)
  const valid = /^[a-z][a-zA-Z0-9_]{0,63}$/.test(name) && !definition.variables[name]
  const setVariable = (key: string, variable: Variable | undefined) =>
    update((current) => {
      const variables = { ...current.variables }
      if (variable) variables[key] = variable
      else delete variables[key]
      return { ...current, variables }
    })
  return (
    <Section
      id="route-variables"
      title={t('processDesigner.route.variables')}
      hint={t('processDesigner.route.variablesHint')}
    >
      {entries.map(([key, variable]) => (
        <Card key={key}>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <code className="font-mono text-xs text-fg-secondary">var:{key}</code>
              {readOnly ? null : (
                <IconButton
                  label={t('processDesigner.route.removeVariable', { name: key })}
                  size="sm"
                  onClick={() => setVariable(key, undefined)}
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              )}
            </div>
            <LangFields
              label={t('processDesigner.route.variableLabel')}
              value={variable.label}
              required
              onChange={(label) => setVariable(key, { ...variable, label: label ?? { ru: '' } })}
            />
            <VariableTypeSelect
              value={variable.type}
              onChange={(type) => setVariable(key, { ...variable, type })}
            />
            <Switch
              label={t('processDesigner.route.variableRequired')}
              checked={variable.required}
              disabled={readOnly}
              onCheckedChange={(required) => setVariable(key, { ...variable, required })}
            />
          </div>
        </Card>
      ))}
      {readOnly ? null : (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!valid) return
            setVariable(name, { type: 'user', label: { ru: name }, required: true })
            setName('')
          }}
        >
          <Field
            label={t('processDesigner.route.variableName')}
            hint={t('processDesigner.route.variableNameHint')}
            htmlFor={nameId}
          >
            <Input
              id={nameId}
              value={name}
              className="w-48 font-mono text-xs"
              placeholder="signer"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Button type="submit" size="sm" disabled={!valid}>
            <Plus className="size-3.5" />
            {t('processDesigner.route.addVariable')}
          </Button>
        </form>
      )}
    </Section>
  )
}

function VariableTypeSelect({
  value,
  onChange,
}: {
  value: Variable['type']
  onChange: (type: Variable['type']) => void
}) {
  const t = useT()
  const id = useId()
  const { readOnly } = useDesigner()
  const label = t('processDesigner.route.variableType')
  return (
    <Field label={label} htmlFor={id}>
      <Select
        value={value}
        disabled={readOnly}
        onValueChange={(next) => onChange(next as Variable['type'])}
      >
        <SelectTrigger id={id} aria-label={label} className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {VARIABLE_TYPES.map((type) => (
            <SelectItem key={type} value={type}>
              {t(`processDesigner.route.variableTypes.${type}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

function Timers({ readOnly }: { readOnly: boolean }) {
  const t = useT()
  const { definition, update } = useDesigner()
  const setTimers = (timers: Timer[]) => update((current) => ({ ...current, timers }))
  // Эскалация срабатывает на просрочку: шаги со сроком в рабочих днях или часах
  const withDue = Object.entries(definition.steps).filter(
    ([, step]) => deadlineOf(step) !== undefined,
  )
  return (
    <Section
      id="route-timers"
      title={t('processDesigner.route.timers')}
      hint={t('processDesigner.route.timersHint')}
    >
      {definition.timers.map((timer, index) => (
        <Card key={index}>
          <div className="flex flex-col gap-2">
            <div className="flex items-end justify-between gap-2">
              <StepSelect
                label={t('processDesigner.route.timerStep')}
                value={timer.step}
                extra={[{ value: ALL_STEPS, label: t('processDesigner.route.timerAll') }]}
                onChange={(step) =>
                  setTimers(
                    definition.timers.map((item, position) =>
                      position === index ? { ...item, step: step ?? ALL_STEPS } : item,
                    ),
                  )
                }
              />
              {readOnly ? null : (
                <IconButton
                  label={t('processDesigner.route.removeTimer', { n: index + 1 })}
                  size="sm"
                  onClick={() =>
                    setTimers(definition.timers.filter((_, position) => position !== index))
                  }
                >
                  <Trash2 className="size-3.5" />
                </IconButton>
              )}
            </div>
            <Field label={t('processDesigner.route.timerTo')}>
              <AssigneeEditor
                label={t('processDesigner.route.timerTo')}
                timer
                value={timer.onOverdue.flatMap((action) =>
                  typeof action.to === 'string' ? [action.to] : action.to,
                )}
                onChange={(to) =>
                  setTimers(
                    definition.timers.map((item, position) =>
                      position === index
                        ? {
                            ...item,
                            onOverdue: to.map((recipient) => ({
                              action: 'notify' as const,
                              to: recipient,
                            })),
                          }
                        : item,
                    ),
                  )
                }
              />
            </Field>
          </div>
        </Card>
      ))}
      {withDue.length === 0 ? (
        <p className="text-xs text-fg-muted">{t('processDesigner.route.timersNoDue')}</p>
      ) : null}
      {readOnly ? null : (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setTimers([
                ...definition.timers,
                {
                  step: ALL_STEPS,
                  onOverdue: [{ action: 'notify', to: 'manager(step.assignee)' }],
                },
              ])
            }
          >
            <Plus className="size-3.5" />
            {t('processDesigner.route.addTimer')}
          </Button>
        </div>
      )}
    </Section>
  )
}

function Conditions({ readOnly }: { readOnly: boolean }) {
  const t = useT()
  const { definition, update } = useDesigner()
  const setConditions = (conditions: StartCondition[]) =>
    update((current) => ({ ...current, conditions }))
  const change = (index: number, patch: Partial<StartCondition>) =>
    setConditions(
      definition.conditions.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    )
  return (
    <Section
      id="route-conditions"
      title={t('processDesigner.route.conditions')}
      hint={t('processDesigner.route.conditionsHint')}
    >
      {definition.conditions.map((condition, index) => {
        const step = condition.step as Step
        return (
          <Card key={index}>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-fg-secondary">
                  {t('processDesigner.route.conditionN', { n: index + 1 })}
                </span>
                {readOnly ? null : (
                  <IconButton
                    label={t('processDesigner.route.removeCondition', { n: index + 1 })}
                    size="sm"
                    onClick={() =>
                      setConditions(
                        definition.conditions.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                )}
              </div>
              <ExpressionInput
                label={t('processDesigner.route.conditionIf')}
                multiline
                value={condition.if}
                placeholder="object.fields.amount > 1000000"
                onChange={(value) => change(index, { if: value })}
              />
              <StepSelect
                label={t('processDesigner.route.conditionBefore')}
                value={condition.insertBefore}
                onChange={(insertBefore) => insertBefore && change(index, { insertBefore })}
              />
              <InsertedStepFields
                step={step}
                onChange={(next) => change(index, { step: next as StartCondition['step'] })}
              />
            </div>
          </Card>
        )
      })}
      {readOnly ? null : (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setConditions([
                ...definition.conditions,
                {
                  at: 'start',
                  if: 'object.fields.amount > 1000000',
                  insertBefore: definition.start,
                  step: defaultStep('approval') as StartCondition['step'],
                },
              ])
            }
          >
            <Plus className="size-3.5" />
            {t('processDesigner.route.addCondition')}
          </Button>
        </div>
      )}
    </Section>
  )
}

/** Вставляемый шаг: тип, назначенные и срок (прочие поля — в JSON маршрута). */
function InsertedStepFields({ step, onChange }: { step: Step; onChange: (step: Step) => void }) {
  const t = useT()
  const id = useId()
  const { readOnly } = useDesigner()
  const typeLabel = t('processDesigner.route.conditionStep')
  const known = (INSERTABLE as readonly string[]).includes(step.type)
  const assignees =
    step.type === 'notify'
      ? typeof step.to === 'string'
        ? [step.to]
        : step.to
      : 'assignees' in step
        ? (step.assignees ?? [])
        : []
  return (
    <div className="flex flex-col gap-2">
      <Field label={typeLabel} htmlFor={id}>
        <Select
          value={step.type}
          disabled={readOnly}
          onValueChange={(type) => {
            const next = defaultStep(type as Step['type'])
            const { next: _next, ...rest } = next as Step & { next?: string }
            onChange(rest as Step)
          }}
        >
          <SelectTrigger id={id} aria-label={typeLabel} className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {known ? null : (
              <SelectItem value={step.type}>{t(`processDesigner.types.${step.type}`)}</SelectItem>
            )}
            {INSERTABLE.map((type) => (
              <SelectItem key={type} value={type}>
                {t(`processDesigner.types.${type}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {step.type === 'approval' ||
      step.type === 'sign' ||
      step.type === 'acknowledge' ||
      step.type === 'notify' ? (
        <Field label={t('processDesigner.route.conditionAssignees')}>
          <AssigneeEditor
            label={t('processDesigner.route.conditionAssignees')}
            value={assignees}
            onChange={(list) =>
              onChange(
                step.type === 'notify'
                  ? { ...step, to: list.length === 1 ? (list[0] as string) : list }
                  : ({ ...step, assignees: list } as Step),
              )
            }
          />
        </Field>
      ) : null}
      {'dueWorkingDays' in step || step.type === 'approval' || step.type === 'sign' ? (
        <DeadlineInput
          value={{
            days: 'dueWorkingDays' in step ? step.dueWorkingDays : undefined,
            hours: 'dueHours' in step ? step.dueHours : undefined,
          }}
          onChange={({ days, hours }) => {
            const next: Record<string, unknown> = { ...step }
            if (days === undefined) delete next.dueWorkingDays
            else next.dueWorkingDays = days
            if (hours === undefined) delete next.dueHours
            else next.dueHours = hours
            onChange(next as Step)
          }}
          labels={{
            days: t('processDesigner.inspector.due'),
            hours: t('processDesigner.inspector.dueHours'),
          }}
          hints={{
            days: t('processDesigner.inspector.dueHint'),
            hours: t('processDesigner.inspector.dueHoursHint'),
          }}
        />
      ) : null}
    </div>
  )
}
