import { Json, LangText } from '@kchs/contracts'
import { z } from 'zod'

/**
 * Контракт ProcessDefinition (docs/contracts/process-definition.md, ADR-0012,
 * ADR-0079): декларативное определение маршрута — шаги, переменные, таймеры,
 * условия вставки. Схема проверяет форму; связи шагов, достижимость, циклы и
 * выражения — `validateDefinition`.
 */

/** Ключ шага: латиница в нижнем регистре, цифры и `_`, начинается с буквы. */
export const STEP_KEY = /^[a-z][a-z0-9_]{0,63}$/
export const StepKey = z.string().regex(STEP_KEY, 'ключ шага: a–z, 0–9 и _, начинается с буквы')

const VariableName = z
  .string()
  .regex(/^[a-z][a-zA-Z0-9_]{0,63}$/, 'имя переменной: латиница, цифры и _')

/** Исход завершения: `completed`, `rejected`, `withdrawn`… */
export const Outcome = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'исход: a–z, 0–9 и _')

/**
 * Переход при отклонении: ключ шага, `continue` (дальше по маршруту) или
 * `end:<исход>` (завершить маршрут). По умолчанию — `end:rejected`.
 */
export const RejectTarget = z
  .string()
  .regex(
    /^(continue|end:[a-z][a-z0-9_]{0,31}|[a-z][a-z0-9_]{0,63})$/,
    'ключ шага, continue или end:<исход>',
  )

/** Выражение назначения: `user:<id>`, `unit_head(author.unit)`… (разбирает `parseAssignee`). */
const Assignee = z.string().trim().min(1).max(500)
const Assignees = z.array(Assignee).min(1).max(50)
/** `to` уведомления и эскалации: одно выражение или список. */
const Recipients = z.union([Assignee, z.array(Assignee).min(1).max(50)])

/** Срок в рабочих днях по производственному календарю от активации шага. */
const DueWorkingDays = z.number().int().min(0).max(365)
/** Условие на языке выражений платформы (`object.fields.amount > 1000000`). */
const ConditionExpr = z.string().trim().min(1).max(4000)
/** Шаблон уведомления: ключ словаря в разделе `processes.templates`. */
const TemplateKey = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/, 'ключ шаблона')

const base = {
  name: LangText.optional(),
  description: LangText.optional(),
}

export const APPROVAL_MODES = ['parallel', 'sequential', 'any'] as const
export const Quorum = z.union([z.enum(['all', 'any']), z.number().int().min(1).max(100)])
export type Quorum = z.infer<typeof Quorum>

export const ApprovalStep = z.strictObject({
  type: z.literal('approval'),
  ...base,
  mode: z.enum(APPROVAL_MODES).default('parallel'),
  quorum: Quorum.default('all'),
  assignees: Assignees,
  dueWorkingDays: DueWorkingDays.optional(),
  onReject: RejectTarget.optional(),
  allowAddApprover: z.boolean().default(false),
  /** Согласующий может передать шаг другому сотруднику. */
  allowDelegate: z.boolean().default(true),
  next: StepKey.optional(),
})

export const SignStep = z.strictObject({
  type: z.literal('sign'),
  ...base,
  mode: z.enum(['parallel', 'sequential']).default('parallel'),
  assignees: Assignees,
  dueWorkingDays: DueWorkingDays.optional(),
  /** Подпись подтверждается кодом второго фактора. */
  requireMfa: z.boolean().default(false),
  signatureKind: z.enum(['simple', 'qualified']).default('simple'),
  /** Переход при отказе в подписи (как `onReject` согласования). */
  onReject: RejectTarget.optional(),
  next: StepKey.optional(),
})

export const RegisterStep = z.strictObject({
  type: z.literal('register'),
  ...base,
  /** Регистратор; без назначенных модуль регистрирует автоматически. */
  assignees: Assignees.optional(),
  journal: z.string().trim().min(1).max(64).optional(),
  dueWorkingDays: DueWorkingDays.optional(),
  next: StepKey.optional(),
})

export const AcknowledgeStep = z.strictObject({
  type: z.literal('acknowledge'),
  ...base,
  assignees: Assignees,
  dueWorkingDays: DueWorkingDays.optional(),
  next: StepKey.optional(),
})

export const TaskStep = z.strictObject({
  type: z.literal('task'),
  ...base,
  title: LangText,
  assignees: Assignees,
  dueWorkingDays: DueWorkingDays.optional(),
  params: z.record(z.string(), Json).default({}),
  next: StepKey.optional(),
})

export const ConditionStep = z.strictObject({
  type: z.literal('condition'),
  ...base,
  branches: z
    .array(z.strictObject({ if: ConditionExpr, next: StepKey }))
    .min(1)
    .max(20),
  else: StepKey.optional(),
})

export const ParallelStep = z.strictObject({
  type: z.literal('parallel'),
  ...base,
  /** Ветви — упорядоченные списки ключей шагов; шаги ветви идут друг за другом. */
  branches: z.array(z.array(StepKey).min(1).max(50)).min(1).max(20),
  join: z.enum(['all', 'any']).default('all'),
  next: StepKey.optional(),
})

export const WaitStep = z.strictObject({
  type: z.literal('wait'),
  ...base,
  /** Тип доменного события об этом же объекте (`document.version_added`). */
  event: z
    .string()
    .regex(/^[a-z][a-z_]*\.[a-z][a-z_]*$/, 'тип события: <домен>.<событие>')
    .optional(),
  /** Условие над событием: `event.payload.number > 1`. */
  filter: ConditionExpr.optional(),
  /** Дата или момент ISO 8601, `var:<имя>` или `field:<путь>`. */
  until: z.string().trim().min(1).max(200).optional(),
  durationWorkingDays: DueWorkingDays.optional(),
  next: StepKey.optional(),
})

export const NotifyStep = z.strictObject({
  type: z.literal('notify'),
  ...base,
  to: Recipients,
  template: TemplateKey.optional(),
  next: StepKey.optional(),
})

export const SetStep = z.strictObject({
  type: z.literal('set'),
  ...base,
  field: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/, 'путь поля'),
  value: Json,
  next: StepKey.optional(),
})

export const CallStep = z.strictObject({
  type: z.literal('call'),
  ...base,
  /** Действие модуля: `documents.dispatch`. */
  action: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/, 'действие: <модуль>.<действие>'),
  params: z.record(z.string(), Json).default({}),
  next: StepKey.optional(),
})

export const ReturnStep = z.strictObject({
  type: z.literal('return'),
  ...base,
  /** Кому вернуть: выражение назначения, по умолчанию автор. */
  to: Assignee.default('author'),
  reapproval: z.enum(['full', 'rejecters_only']).default('full'),
  dueWorkingDays: DueWorkingDays.optional(),
  next: StepKey.optional(),
})

export const EndStep = z.strictObject({
  type: z.literal('end'),
  ...base,
  outcome: Outcome.default('completed'),
})

export const Step = z.discriminatedUnion('type', [
  ApprovalStep,
  SignStep,
  RegisterStep,
  AcknowledgeStep,
  TaskStep,
  ConditionStep,
  ParallelStep,
  WaitStep,
  NotifyStep,
  SetStep,
  CallStep,
  ReturnStep,
  EndStep,
])
export type Step = z.infer<typeof Step>
export type StepType = Step['type']
export type StepOf<T extends StepType> = Extract<Step, { type: T }>

export const STEP_TYPES = [
  'approval',
  'sign',
  'register',
  'acknowledge',
  'task',
  'condition',
  'parallel',
  'wait',
  'notify',
  'set',
  'call',
  'return',
  'end',
] as const satisfies readonly StepType[]

/** Шаг, который вставляет условие при запуске: действие, без управления потоком. */
export const InsertableStep = z.discriminatedUnion('type', [
  ApprovalStep,
  SignStep,
  RegisterStep,
  AcknowledgeStep,
  TaskStep,
  NotifyStep,
  SetStep,
  CallStep,
])

export const VARIABLE_TYPES = [
  'user',
  'users',
  'unit',
  'group',
  'text',
  'number',
  'date',
  'boolean',
] as const
export const VariableType = z.enum(VARIABLE_TYPES)
export type VariableType = z.infer<typeof VariableType>

export const Variable = z.strictObject({
  type: VariableType,
  label: LangText,
  description: LangText.optional(),
  required: z.boolean().default(false),
})
export type Variable = z.infer<typeof Variable>

export const OverdueAction = z.strictObject({
  action: z.literal('notify'),
  to: Recipients,
  template: TemplateKey.optional(),
})

export const Timer = z.strictObject({
  /** Шаг или `*` — все шаги со сроком. */
  step: z.union([z.literal('*'), StepKey]),
  onOverdue: z.array(OverdueAction).min(1).max(10),
})
export type Timer = z.infer<typeof Timer>

export const StartCondition = z.strictObject({
  at: z.literal('start').default('start'),
  if: ConditionExpr,
  insertBefore: StepKey,
  /** Ключ вставленного шага; по умолчанию `cond_<номер>`. */
  key: StepKey.optional(),
  step: InsertableStep,
})
export type StartCondition = z.infer<typeof StartCondition>

export const ProcessDefinition = z.strictObject({
  version: z.literal(1),
  key: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'ключ маршрута: a–z, 0–9 и _'),
  objectType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'тип объекта'),
  name: LangText,
  description: LangText.optional(),
  variables: z.record(VariableName, Variable).default({}),
  start: StepKey,
  steps: z
    .record(StepKey, Step)
    .refine((steps) => Object.keys(steps).length > 0, 'нужен хотя бы один шаг')
    .refine((steps) => Object.keys(steps).length <= 200, 'не больше 200 шагов'),
  timers: z.array(Timer).max(20).default([]),
  conditions: z.array(StartCondition).max(20).default([]),
})
export type ProcessDefinition = z.infer<typeof ProcessDefinition>
export type ProcessDefinitionInput = z.input<typeof ProcessDefinition>

/** Шаги, где назначенные принимают решение во Входящих. */
export const DECISION_STEP_TYPES = [
  'approval',
  'sign',
  'acknowledge',
  'register',
  'return',
] as const
export type DecisionStepType = (typeof DECISION_STEP_TYPES)[number]

/** Шаги управления потоком: исполняются сразу, без назначенных. */
export const CONTROL_STEP_TYPES = ['condition', 'parallel', 'end'] as const

/** Шаг — решение людей (у `register` — только если назначены регистраторы). */
export function isDecisionStep(step: Step): boolean {
  if (step.type === 'register') return Boolean(step.assignees?.length)
  return (DECISION_STEP_TYPES as readonly string[]).includes(step.type)
}

/** Выражения назначенных шага (для `return` — `to`, для `notify` — получатели). */
export function stepAssigneeExpressions(step: Step): string[] {
  switch (step.type) {
    case 'approval':
    case 'sign':
    case 'acknowledge':
    case 'task':
      return step.assignees
    case 'register':
      return step.assignees ?? []
    case 'return':
      return [step.to]
    case 'notify':
      return typeof step.to === 'string' ? [step.to] : step.to
    default:
      return []
  }
}

/** Получатели действия эскалации одним списком. */
export function recipientList(to: string | readonly string[]): string[] {
  return typeof to === 'string' ? [to] : [...to]
}

/** Следующий шаг, если он есть у типа. */
export function nextOf(step: Step): string | undefined {
  return 'next' in step ? step.next : undefined
}

/** Срок шага в рабочих днях, если задан. */
export function dueOf(step: Step): number | undefined {
  return 'dueWorkingDays' in step ? step.dueWorkingDays : undefined
}
