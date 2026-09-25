import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Timestamp, Uuid } from '../common/primitives.js'
import { ObjectSummary } from '../objects/object.js'

/** Виды элементов Входящих (12-calendar-notifications-home.md §3). */
export const INBOX_KINDS = [
  'approve',
  'sign',
  'resolve',
  'acknowledge',
  'accept_instruction',
  'report_instruction',
  'accept_result',
  'respond_invite',
  'review_protocol',
  'submit_form',
  'access_request',
  'alert',
  'import_error',
  /** Правка объектов модерируемого слоя ждёт проверки (ADR-0076). */
  'review_edit',
  /** Отчёт по расписанию готов (ADR-0078): ознакомиться, файл — в истории запусков. */
  'report',
  /** Шаг маршрута `register`: зарегистрировать объект в журнале (ADR-0079). */
  'register',
  /** Шаг маршрута `return`: доработать и отправить повторно или отозвать (ADR-0079). */
  'revise',
  /** Исполнитель просит продлить срок поручения: согласовать или отказать (ADR-0082). */
  'extend_due',
  /** Подошёл срок пересмотра страницы базы знаний: проверить и опубликовать (ADR-0095). */
  'review_page',
  /** Сводка формы сдана: принять или вернуть с комментарием (ADR-0103). */
  'review_form',
] as const
export const InboxKind = z.enum(INBOX_KINDS)
export type InboxKind = z.infer<typeof InboxKind>

/**
 * Группы Входящих (экран, фильтр, счётчики; 12-calendar-notifications-home.md §3): решения,
 * ознакомления, поручения, приглашения, данные и алерты. Группа выводится из вида дела.
 */
export const INBOX_GROUPS = ['decide', 'acknowledge', 'instructions', 'invites', 'data'] as const
export const InboxGroup = z.enum(INBOX_GROUPS)
export type InboxGroup = z.infer<typeof InboxGroup>

const DECIDE_KINDS: readonly string[] = ['approve', 'sign', 'resolve', 'register', 'revise']
const INSTRUCTION_KINDS: readonly string[] = [
  'accept_instruction',
  'report_instruction',
  'accept_result',
  'extend_due',
]

export function inboxGroupOf(kind: string): InboxGroup {
  if (DECIDE_KINDS.includes(kind)) return 'decide'
  if (kind === 'acknowledge' || kind === 'report') return 'acknowledge'
  if (INSTRUCTION_KINDS.includes(kind)) return 'instructions'
  if (kind === 'respond_invite') return 'invites'
  return 'data'
}

/** Виды дел группы — для фильтра списка по группе. */
export function inboxKindsOf(group: InboxGroup): InboxKind[] {
  return INBOX_KINDS.filter((kind) => inboxGroupOf(kind) === group)
}

export const InboxState = z.enum(['open', 'resolved', 'dismissed', 'snoozed'])
export type InboxState = z.infer<typeof InboxState>

export const InboxPriority = z.enum(['low', 'normal', 'high', 'urgent'])

/**
 * Что действие просит, кроме комментария: `due_date` — дату (запрос продления,
 * ADR-0082), она приходит в `payload.dueDate` (`ГГГГ-ММ-ДД`).
 */
export const INBOX_ACTION_INPUTS = ['due_date'] as const
export const InboxActionInputKind = z.enum(INBOX_ACTION_INPUTS)
export type InboxActionInputKind = z.infer<typeof InboxActionInputKind>

/** Действие элемента Входящих: ключ, подпись, вид кнопки, что нужно ввести. */
export const InboxAction = z.object({
  key: z.string(),
  labelKey: z.string(),
  variant: z.enum(['primary', 'secondary', 'danger', 'ghost']).default('secondary'),
  requiresComment: z.boolean().default(false),
  input: InboxActionInputKind.optional(),
  /** Действие подтверждается кодом второго фактора (`payload.code`), подпись с MFA (ADR-0079). */
  requiresSecondFactor: z.boolean().optional(),
  /**
   * Действие выполняется в карточке объекта (форма резолюции, ADR-0084):
   * Входящие открывают объект и передают ему ключ действия; кнопкой в
   * Telegram такое действие не показывается.
   */
  openObject: z.boolean().optional(),
})
export type InboxAction = z.infer<typeof InboxAction>

export const InboxItem = z.object({
  id: Uuid,
  userId: Uuid,
  kind: InboxKind,
  title: z.string(),
  body: z.string().nullable(),
  object: ObjectSummary.nullable(),
  actor: UserRef.nullable(),
  /** Элемент пришёл через замещение: показываем «от имени». */
  onBehalfOf: UserRef.nullable(),
  processStepId: Uuid.nullable(),
  dueAt: Timestamp.nullable(),
  priority: InboxPriority,
  state: InboxState,
  openedAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
  snoozedUntil: Timestamp.nullable(),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Доступные действия: ключ, подпись, вид кнопки. */
  actions: z.array(InboxAction).default([]),
})
export type InboxItem = z.infer<typeof InboxItem>

export const InboxCounts = z.object({
  total: z.number().int(),
  overdue: z.number().int(),
  dueToday: z.number().int(),
  delegated: z.number().int(),
  byKind: z.record(z.string(), z.number().int()).default({}),
})
export type InboxCounts = z.infer<typeof InboxCounts>

export const InboxQuery = z.object({
  state: InboxState.default('open'),
  kind: InboxKind.optional(),
  /** Все виды дел группы (экран Входящих, ADR-0153). */
  group: InboxGroup.optional(),
  scope: z.enum(['all', 'mine', 'delegated']).default('all'),
  due: z.enum(['any', 'overdue', 'today', 'week']).default('any'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type InboxQuery = z.infer<typeof InboxQuery>

export const InboxActionInput = z.object({
  action: z.string().min(1).max(64),
  comment: z.string().max(4000).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
})
export type InboxActionInput = z.infer<typeof InboxActionInput>

export const InboxSnoozeInput = z.object({
  until: Timestamp,
})

/**
 * Массовое действие над выбранными делами (ADR-0153) — только то, что не требует
 * комментария, кода или формы: «Ознакомлен» (ключ `acknowledge`), «Отметить выполненным»
 * для информационных дел (ключ `dismiss`, алерты), «Отложить». Каждое дело выполняет тот же
 * модуль, что и одиночная кнопка; неподходящие пропускаются.
 */
export const INBOX_BULK_OPERATIONS = ['acknowledge', 'done', 'snooze'] as const
export const InboxBulkOperation = z.enum(INBOX_BULK_OPERATIONS)
export type InboxBulkOperation = z.infer<typeof InboxBulkOperation>

/** Ключ действия дела, которым выполняется массовая операция. */
export const INBOX_BULK_ACTION_KEY: Record<Exclude<InboxBulkOperation, 'snooze'>, string> = {
  acknowledge: 'acknowledge',
  done: 'dismiss',
}

export const InboxBulkInput = z.object({
  ids: z.array(Uuid).min(1).max(100),
  operation: InboxBulkOperation,
  /** До какого момента отложить (`snooze`); без него — на сутки. */
  until: Timestamp.optional(),
})
export type InboxBulkInput = z.infer<typeof InboxBulkInput>

export const InboxBulkResult = z.object({
  done: z.number().int(),
  skipped: z.number().int(),
  results: z.array(
    z.object({
      id: Uuid,
      ok: z.boolean(),
      /** Почему пропущено: `not_applicable` — у дела нет такого действия; иначе текст ошибки. */
      reason: z.string().nullable(),
    }),
  ),
})
export type InboxBulkResult = z.infer<typeof InboxBulkResult>
