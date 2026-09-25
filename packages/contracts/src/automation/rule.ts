import { z } from 'zod'
import { Json, LangText, Slug, Uuid } from '../common/primitives.js'
import { ObjectType } from '../objects/object.js'

/**
 * Правило автоматизации (contracts/automation-rule.md, ADR-0096):
 * «когда (триггер) → если (условия) → то (действия)».
 *
 * Условия и шаблоны `{{…}}` — язык выражений платформы (`@kchs/query/expr`),
 * получатели и исполнители — язык назначений маршрутов (`@kchs/process`):
 * второго языка в продукте нет.
 */

/** Выражение cron из пяти полей (минута, час, день, месяц, день недели). */
export const CronPattern = z
  .string()
  .trim()
  .regex(/^\S+(\s+\S+){4}$/, 'выражение cron — пять полей')

/** Пояс IANA расписания. */
export const TimezoneName = z.string().min(1).max(64)

// ── Триггеры ────────────────────────────────────────────────────────────────

export const RULE_TRIGGER_KINDS = ['event', 'schedule', 'webhook', 'manual', 'metric'] as const
export const RuleTriggerKind = z.enum(RULE_TRIGGER_KINDS)
export type RuleTriggerKind = z.infer<typeof RuleTriggerKind>

/** Событие каталога (`document.registered`) или префикс домена (`task.*`). */
export const EventTypePattern = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-z_]+\.([a-z_]+|\*)$/, 'тип события каталога или префикс домена: `task.*`')

export const EventTrigger = z.object({
  kind: z.literal('event'),
  type: EventTypePattern,
  /**
   * Отбор по полям конверта: путь → значение (`object.type`, `payload.kind`).
   * Проверяется до условий и не требует чтения объекта.
   */
  filter: z.record(z.string(), Json).default({}),
})
export type EventTrigger = z.infer<typeof EventTrigger>

export const ScheduleTrigger = z.object({
  kind: z.literal('schedule'),
  cron: CronPattern,
  timezone: TimezoneName,
  /** Объект, в контексте которого выполняется правило (необязательно). */
  objectId: Uuid.nullable().default(null),
})
export type ScheduleTrigger = z.infer<typeof ScheduleTrigger>

export const WebhookTrigger = z.object({
  kind: z.literal('webhook'),
  /** Ключ входящего вызова: событие `webhook.received` с этим ключом. */
  hookKey: Slug,
})
export type WebhookTrigger = z.infer<typeof WebhookTrigger>

export const ManualTrigger = z.object({
  kind: z.literal('manual'),
  /** У объектов каких типов появляется кнопка в меню «⋯». */
  objectTypes: z.array(ObjectType).min(1).max(20),
  /** Спросить подтверждение перед запуском. */
  confirm: z.boolean().default(false),
})
export type ManualTrigger = z.infer<typeof ManualTrigger>

export const MetricTrigger = z.object({
  kind: z.literal('metric'),
  metricId: Uuid,
  /** Условие над значением показателя: `value > 100`, `value < previous`. */
  condition: z.string().trim().min(1).max(500),
  cron: CronPattern,
  timezone: TimezoneName,
})
export type MetricTrigger = z.infer<typeof MetricTrigger>

export const RuleTrigger = z.discriminatedUnion('kind', [
  EventTrigger,
  ScheduleTrigger,
  WebhookTrigger,
  ManualTrigger,
  MetricTrigger,
])
export type RuleTrigger = z.infer<typeof RuleTrigger>

// ── Условия ─────────────────────────────────────────────────────────────────

/**
 * Дерево условий: выражение или группа `and` / `or` / `not`.
 * Корни ссылок — `event`, `object`, `actor`, `previous`, `now`.
 */
export type RuleCondition =
  | { expr: string }
  | { and: RuleCondition[] }
  | { or: RuleCondition[] }
  | { not: RuleCondition }

export const RuleCondition: z.ZodType<RuleCondition> = z.lazy(() =>
  z.union([
    z.object({ expr: z.string().trim().min(1).max(1000) }),
    z.object({ and: z.array(RuleCondition).min(1).max(20) }),
    z.object({ or: z.array(RuleCondition).min(1).max(20) }),
    z.object({ not: RuleCondition }),
  ]),
)

/** Корни ссылок в условиях и шаблонах правила. */
export const RULE_EXPRESSION_ROOTS = ['event', 'object', 'actor', 'previous', 'now'] as const

// ── Действия ────────────────────────────────────────────────────────────────

export const RULE_ACTION_TYPES = [
  'notify',
  'create_task',
  'update_fields',
  'set_status',
  'assign',
  'create_document',
  'start_process',
  'add_link',
  'add_tag',
  'post_message',
  'create_event',
  'send_email',
  'send_telegram',
  'webhook',
  'ai_task',
  'wait',
  'stop',
] as const
export const RuleActionType = z.enum(RULE_ACTION_TYPES)
export type RuleActionType = z.infer<typeof RuleActionType>

/** Строка с подстановками `{{выражение}}`. */
const Template = z.string().max(4000)
/** Выражение назначения: `user:<id>`, `role:finance`, `unit_head('FIN')`, `field:responsibleId`. */
const Assignee = z.string().trim().min(1).max(200)
/** Объект действия; по умолчанию — объект события. */
const TargetObject = Template.default('{{object.id}}')

/**
 * Срочное уведомление (05-risks N23, ADR-0140): проходит сквозь тихие часы и «не беспокоить»
 * получателя — внешние каналы (Telegram, push, почта) доставляются сразу. Для алертов ЧС,
 * эскалаций и срочных поручений; остальные уведомления правил тишина глушит.
 */
const Urgent = z.boolean().default(false)

export const NotifyAction = z.object({
  type: z.literal('notify'),
  to: z.array(Assignee).min(1).max(20),
  text: Template.min(1),
  channels: z.array(z.enum(['app', 'email', 'telegram', 'push'])).default(['app']),
  object: TargetObject,
  urgent: Urgent,
})

export const CreateTaskAction = z.object({
  type: z.literal('create_task'),
  title: Template.min(1),
  description: Template.nullable().default(null),
  assignee: Assignee,
  coAssignees: z.array(Assignee).max(10).default([]),
  controller: Assignee.nullable().default(null),
  dueWorkingDays: z.number().int().min(1).max(365).nullable().default(null),
  dueAt: Template.nullable().default(null),
  priority: z.number().int().min(1).max(5).default(3),
  /** Источник поручения — объект реестра; по умолчанию объект события. */
  source: TargetObject,
})

export const UpdateFieldsAction = z.object({
  type: z.literal('update_fields'),
  fields: z.record(z.string().min(1).max(64), Template),
  object: TargetObject,
})

export const SetStatusAction = z.object({
  type: z.literal('set_status'),
  status: z.string().trim().min(1).max(64),
  comment: Template.nullable().default(null),
  object: TargetObject,
})

export const AssignAction = z.object({
  type: z.literal('assign'),
  assignee: Assignee,
  /** Роль назначения в карточке объекта: исполнитель или контролёр. */
  role: z.enum(['responsible', 'controller']).default('responsible'),
  object: TargetObject,
})

export const CreateDocumentAction = z.object({
  type: z.literal('create_document'),
  typeKey: z.string().trim().min(1).max(64),
  subject: Template.min(1),
  templateId: Uuid.nullable().default(null),
  spaceId: Uuid.nullable().default(null),
  fields: z.record(z.string().min(1).max(64), Template).default({}),
  /** Связать созданный документ с объектом события. */
  linkToSource: z.boolean().default(true),
})

export const StartProcessAction = z.object({
  type: z.literal('start_process'),
  definitionKey: z.string().trim().min(1).max(64),
  variables: z.record(z.string().min(1).max(64), Template).default({}),
  object: TargetObject,
})

export const AddLinkAction = z.object({
  type: z.literal('add_link'),
  target: Template.min(1),
  kind: z.string().trim().min(1).max(32).default('related'),
  object: TargetObject,
})

export const AddTagAction = z.object({
  type: z.literal('add_tag'),
  tag: Template.min(1),
  object: TargetObject,
})

export const PostMessageAction = z.object({
  type: z.literal('post_message'),
  text: Template.min(1),
  /** Беседа: `object` — обсуждение объекта события, иначе идентификатор беседы. */
  conversation: Template.default('object'),
})

export const CreateEventAction = z.object({
  type: z.literal('create_event'),
  calendarId: Uuid.nullable().default(null),
  title: Template.min(1),
  startsAt: Template.min(1),
  durationMinutes: z.number().int().min(5).max(1440).default(60),
  participants: z.array(Assignee).max(20).default([]),
})

export const SendEmailAction = z.object({
  type: z.literal('send_email'),
  /** Выражения назначений (адрес берётся из профиля) или явные адреса. */
  to: z.array(Assignee).min(1).max(20),
  subject: Template.min(1),
  body: Template.min(1),
})

export const SendTelegramAction = z.object({
  type: z.literal('send_telegram'),
  to: z.array(Assignee).min(1).max(20),
  text: Template.min(1),
  object: TargetObject,
  urgent: Urgent,
})

export const WebhookAction = z.object({
  type: z.literal('webhook'),
  url: z.url().max(500),
  method: z.enum(['POST', 'PUT']).default('POST'),
  headers: z.record(z.string().max(64), Template).default({}),
  payload: z.record(z.string().max(64), Template).default({}),
  /** Подпись HMAC-SHA256 тела в заголовке `X-Kchs-Signature`. */
  secret: z.string().max(200).nullable().default(null),
})

export const AiTaskAction = z.object({
  type: z.literal('ai_task'),
  prompt: Template.min(1),
  /** Куда записать ответ: комментарий объекта или его поле. */
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('comment') }),
    z.object({ kind: z.literal('field'), key: z.string().trim().min(1).max(64) }),
  ]),
  object: TargetObject,
})

export const WaitAction = z.object({
  type: z.literal('wait'),
  minutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 30),
})

export const StopAction = z.object({
  type: z.literal('stop'),
  /** Остановить, если выражение истинно; без него — всегда. */
  when: z.string().trim().max(1000).nullable().default(null),
})

export const RuleAction = z.discriminatedUnion('type', [
  NotifyAction,
  CreateTaskAction,
  UpdateFieldsAction,
  SetStatusAction,
  AssignAction,
  CreateDocumentAction,
  StartProcessAction,
  AddLinkAction,
  AddTagAction,
  PostMessageAction,
  CreateEventAction,
  SendEmailAction,
  SendTelegramAction,
  WebhookAction,
  AiTaskAction,
  WaitAction,
  StopAction,
])
export type RuleAction = z.infer<typeof RuleAction>

// ── Правило целиком ─────────────────────────────────────────────────────────

export const RuleLimits = z.object({
  /** Больше этого числа запусков в час правило пропускает с отметкой в журнале. */
  maxRunsPerHour: z.number().int().min(1).max(10_000).default(100),
  /** Шаблон ключа: два запуска с одним ключом в окне — один. */
  dedupeKey: Template.nullable().default(null),
  dedupeWindowMinutes: z.number().int().min(1).max(1440).default(60),
})
export type RuleLimits = z.infer<typeof RuleLimits>

export const RuleDefinition = z.object({
  version: z.literal(1).default(1),
  name: LangText,
  description: z.string().max(2000).nullable().default(null),
  enabled: z.boolean().default(false),
  /**
   * Служебный пользователь правила: действия выполняются от его имени и не
   * могут выйти за его права. Администратор системы недопустим.
   */
  runAs: Uuid.nullable().default(null),
  trigger: RuleTrigger,
  conditions: RuleCondition.nullable().default(null),
  actions: z.array(RuleAction).min(1).max(20),
  limits: RuleLimits.default({ maxRunsPerHour: 100, dedupeKey: null, dedupeWindowMinutes: 60 }),
})
export type RuleDefinition = z.infer<typeof RuleDefinition>
