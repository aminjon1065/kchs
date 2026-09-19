import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'

/**
 * Ознакомление с объектом (08-documents.md §10, ADR-0084) — общий механизм
 * ядра для документов и страниц базы знаний. Запрос — список лиц,
 * подразделений и групп; отметка — у каждого своя (с кодом второго фактора,
 * если запрос этого требует). Шаг маршрута `acknowledge` пишет в тот же учёт:
 * одна правда о том, кто и когда ознакомился.
 */

/** Откуда запрос: вручную из карточки, правилом типа при регистрации, шагом маршрута. */
export const ACKNOWLEDGMENT_SOURCES = ['manual', 'register', 'process'] as const
export const AcknowledgmentSource = z.enum(ACKNOWLEDGMENT_SOURCES)
export type AcknowledgmentSource = z.infer<typeof AcknowledgmentSource>

export const ACKNOWLEDGMENT_STATES = ['pending', 'acknowledged', 'cancelled'] as const
export const AcknowledgmentState = z.enum(ACKNOWLEDGMENT_STATES)
export type AcknowledgmentState = z.infer<typeof AcknowledgmentState>

/**
 * Ознакомление одного сотрудника со всеми его запросами по объекту: ждёт,
 * если открыт хотя бы один запрос; иначе — последняя отметка.
 */
export const AcknowledgmentEntry = z.object({
  user: UserRef,
  state: AcknowledgmentState,
  sources: z.array(AcknowledgmentSource),
  requiredAt: Timestamp,
  /** Ближайший срок открытого запроса. */
  dueAt: Timestamp.nullable(),
  overdue: z.boolean(),
  acknowledgedAt: Timestamp.nullable(),
  /** Отметил заместитель — кто именно. */
  actor: UserRef.nullable(),
  /** Отметка подтверждена кодом второго фактора. */
  secondFactor: z.boolean(),
  remindedAt: Timestamp.nullable(),
  reminders: z.number().int(),
})
export type AcknowledgmentEntry = z.infer<typeof AcknowledgmentEntry>

export const AcknowledgmentRequestRecord = z.object({
  id: Uuid,
  source: AcknowledgmentSource,
  requestedBy: UserRef.nullable(),
  requestedAt: Timestamp,
  dueAt: Timestamp.nullable(),
  requireSecondFactor: z.boolean(),
  note: z.string().nullable(),
  total: z.number().int(),
  acknowledged: z.number().int(),
  cancelledAt: Timestamp.nullable(),
})
export type AcknowledgmentRequestRecord = z.infer<typeof AcknowledgmentRequestRecord>

/** Вкладка «Ознакомление»: кто ознакомился и кто нет, запросы, права смотрящего. */
export const ObjectAcknowledgments = z.object({
  items: z.array(AcknowledgmentEntry),
  requests: z.array(AcknowledgmentRequestRecord),
  summary: z.object({
    total: z.number().int(),
    acknowledged: z.number().int(),
    pending: z.number().int(),
    overdue: z.number().int(),
  }),
  /** Ознакомление ждёт смотрящего (или замещаемого) и нужен ли код подтверждения. */
  mine: z.object({ pending: z.boolean(), requireSecondFactor: z.boolean() }),
  can: z.object({ request: z.boolean(), remind: z.boolean() }),
})
export type ObjectAcknowledgments = z.infer<typeof ObjectAcknowledgments>

export const AcknowledgmentRequestInput = z
  .object({
    userIds: z.array(Uuid).max(500).default([]),
    unitIds: z.array(Uuid).max(50).default([]),
    groupIds: z.array(Uuid).max(50).default([]),
    dueDate: DateOnly.nullable().default(null),
    /** Код второго фактора при отметке; по умолчанию — правило типа объекта. */
    requireSecondFactor: z.boolean().optional(),
    note: z.string().trim().max(2000).nullable().default(null),
  })
  .refine((input) => input.userIds.length + input.unitIds.length + input.groupIds.length > 0, {
    path: ['userIds'],
    message: 'Выберите сотрудников, подразделения или группы',
  })
export type AcknowledgmentRequestInput = z.infer<typeof AcknowledgmentRequestInput>

/** Почему сотрудник не попал в запрос: не видит объект по грифу или уже ждёт ознакомления. */
export const AcknowledgmentSkipReason = z.enum(['clearance', 'pending'])
export type AcknowledgmentSkipReason = z.infer<typeof AcknowledgmentSkipReason>

export const AcknowledgmentRequestResult = z.object({
  requestId: Uuid.nullable(),
  added: z.number().int(),
  skipped: z.array(z.object({ user: UserRef, reason: AcknowledgmentSkipReason })),
})
export type AcknowledgmentRequestResult = z.infer<typeof AcknowledgmentRequestResult>

export const AcknowledgeInput = z.object({
  /** Код второго фактора, если его требует запрос. */
  code: z.string().max(24).optional(),
})
export type AcknowledgeInput = z.infer<typeof AcknowledgeInput>

export const AcknowledgmentRemindInput = z.object({
  /** Кому напомнить; по умолчанию — всем, кто ещё не ознакомился. */
  userIds: z.array(Uuid).max(500).optional(),
})
export type AcknowledgmentRemindInput = z.infer<typeof AcknowledgmentRemindInput>

export const AcknowledgmentRemindResult = z.object({ reminded: z.number().int() })
export type AcknowledgmentRemindResult = z.infer<typeof AcknowledgmentRemindResult>
