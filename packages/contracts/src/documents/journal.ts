import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'
import { DEFAULT_NUMBER_FORMAT, numberFormatIssue } from './numbering.js'

/** Сброс счётчика журнала: с нового года или никогда (08-documents.md §5). */
export const JOURNAL_RESETS = ['year', 'never'] as const
export const JournalReset = z.enum(JOURNAL_RESETS)
export type JournalReset = z.infer<typeof JournalReset>

const NumberFormat = z
  .string()
  .max(64)
  .refine((value) => numberFormatIssue(value) === null, {
    message: 'шаблон номера: известные подстановки и ровно один {seq}',
  })

export const JournalUnitRef = z.object({ id: Uuid, name: z.string(), code: z.string() })
export type JournalUnitRef = z.infer<typeof JournalUnitRef>

/**
 * Журнал регистрации (08-documents.md §5) — объект реестра; зарегистрированные
 * документы — его дочерние объекты: делопроизводители журнала (права на журнал)
 * видят его документы по наследованию (ADR-0080).
 */
export const JournalRecord = z.object({
  id: Uuid,
  name: z.string(),
  prefix: z.string(),
  format: z.string(),
  reset: JournalReset,
  unit: JournalUnitRef.nullable(),
  typeIds: z.array(Uuid),
  isActive: z.boolean(),
  /** Счётчик текущего периода: последний выданный порядковый номер. */
  lastSequence: z.number().int(),
  /** Как будет выглядеть следующий номер (без резервирования). */
  nextNumber: z.string(),
  /** Зарезервировано и ещё не использовано. */
  openReservations: z.number().int(),
  documentCount: z.number().int(),
  canManage: z.boolean(),
  canRegister: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type JournalRecord = z.infer<typeof JournalRecord>

export const JournalCreateInput = z.object({
  name: z.string().trim().min(1).max(200),
  prefix: z.string().trim().max(32).default(''),
  format: NumberFormat.default(DEFAULT_NUMBER_FORMAT),
  reset: JournalReset.default('year'),
  unitId: Uuid.nullable().default(null),
  typeIds: z.array(Uuid).max(50).default([]),
})
export type JournalCreateInput = z.infer<typeof JournalCreateInput>

export const JournalUpdateInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  prefix: z.string().trim().max(32).optional(),
  format: NumberFormat.optional(),
  reset: JournalReset.optional(),
  unitId: Uuid.nullable().optional(),
  typeIds: z.array(Uuid).max(50).optional(),
  isActive: z.boolean().optional(),
})
export type JournalUpdateInput = z.infer<typeof JournalUpdateInput>

/**
 * Резервирование номеров для бумажных документов (08-documents.md §5):
 * номера выдаются из того же счётчика заранее и помечаются примечанием;
 * при регистрации бумажного документа выбирается резерв.
 */
export const JournalReserveInput = z.object({
  count: z.number().int().min(1).max(50).default(1),
  note: z.string().trim().min(1).max(500),
  /** Дата, на которую резервируются номера (год счётчика); по умолчанию — сегодня. */
  date: DateOnly.optional(),
})
export type JournalReserveInput = z.infer<typeof JournalReserveInput>

export const JOURNAL_RESERVATION_STATES = ['open', 'used', 'cancelled'] as const
export const JournalReservationState = z.enum(JOURNAL_RESERVATION_STATES)
export type JournalReservationState = z.infer<typeof JournalReservationState>

export const JournalReservation = z.object({
  id: Uuid,
  journalId: Uuid,
  number: z.string(),
  sequence: z.number().int(),
  year: z.number().int(),
  note: z.string(),
  state: JournalReservationState,
  reservedBy: UserRef.nullable(),
  reservedAt: Timestamp,
  documentId: Uuid.nullable(),
  usedAt: Timestamp.nullable(),
})
export type JournalReservation = z.infer<typeof JournalReservation>

export const JournalReservationList = z.object({ items: z.array(JournalReservation) })
export type JournalReservationList = z.infer<typeof JournalReservationList>
