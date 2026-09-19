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
] as const
export const InboxKind = z.enum(INBOX_KINDS)
export type InboxKind = z.infer<typeof InboxKind>

export const InboxState = z.enum(['open', 'resolved', 'dismissed', 'snoozed'])
export type InboxState = z.infer<typeof InboxState>

export const InboxPriority = z.enum(['low', 'normal', 'high', 'urgent'])

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
  actions: z
    .array(
      z.object({
        key: z.string(),
        labelKey: z.string(),
        variant: z.enum(['primary', 'secondary', 'danger', 'ghost']).default('secondary'),
        requiresComment: z.boolean().default(false),
        /** Действие подтверждается кодом второго фактора (`payload.code`), подпись с MFA. */
        requiresSecondFactor: z.boolean().optional(),
      }),
    )
    .default([]),
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
