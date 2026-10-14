import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'
import { DocumentDispatch } from './correspondence.js'
import { CorrespondentRef } from './correspondent.js'
import { DocumentStatus } from './lifecycle.js'

/**
 * Обмен с государственной системой ЭДО (ADR-0219). Система закрыта: документы из неё
 * выгружаются вручную и заводятся в платформе входящими, а исходящие для неё
 * собираются пакетом и загружаются в неё вручную. Автоматического адаптера нет —
 * порт ЭДО (ADR-0206) работает провайдером «ручной обмен».
 */

/** SHA-256 файла в шестнадцатеричном виде. */
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/i)
  .transform((value) => value.toLowerCase())

/** Документ, уже заведённый из того же файла, — повтор не заводится вторым документом. */
export const GovEdmsDuplicate = z.object({
  id: Uuid,
  title: z.string(),
  regNumber: z.string().nullable(),
  status: DocumentStatus,
})
export type GovEdmsDuplicate = z.infer<typeof GovEdmsDuplicate>

/** Проверка файлов до загрузки: хэши основных файлов → уже заведённые документы. */
export const GovEdmsCheckInput = z.object({ sha256: z.array(Sha256Hex).min(1).max(200) })
export type GovEdmsCheckInput = z.infer<typeof GovEdmsCheckInput>

export const GovEdmsCheck = z.object({
  matches: z.array(z.object({ sha256: z.string(), document: GovEdmsDuplicate })),
})
export type GovEdmsCheck = z.infer<typeof GovEdmsCheck>

/** Черновик входящего «из госЭДО»: тема — по имени файла, если её не дали. */
export const GovEdmsIntakeInput = z.object({
  typeId: Uuid.optional(),
  subject: z.string().trim().min(1).max(1000),
  receivedDate: DateOnly.optional(),
})
export type GovEdmsIntakeInput = z.infer<typeof GovEdmsIntakeInput>

export const GovEdmsIntakeCreated = z.object({ documentId: Uuid, spaceId: Uuid })
export type GovEdmsIntakeCreated = z.infer<typeof GovEdmsIntakeCreated>

/** Файлы черновика загружены: основной и приложения — из них собирается версия. */
export const GovEdmsIntakeCompleteInput = z.object({
  mainFileId: Uuid,
  attachmentIds: z.array(Uuid).max(100).default([]),
})
export type GovEdmsIntakeCompleteInput = z.infer<typeof GovEdmsIntakeCompleteInput>

/** Реквизиты, найденные в тексте основного файла: предложение, которое правит человек. */
export const GovEdmsPrefill = z.object({
  externalNumber: z.string().nullable(),
  externalDate: DateOnly.nullable(),
  sender: z.string().nullable(),
  subject: z.string().nullable(),
  correspondent: CorrespondentRef.nullable(),
})
export type GovEdmsPrefill = z.infer<typeof GovEdmsPrefill>

/** `waiting` — текст файла ещё извлекается; `done` — реквизиты подставлены; `none` — текста нет. */
export const GovEdmsPrefillStatus = z.enum(['waiting', 'done', 'none'])
export type GovEdmsPrefillStatus = z.infer<typeof GovEdmsPrefillStatus>

export const GovEdmsIntakeRecord = z.object({
  id: Uuid,
  document: z.object({
    id: Uuid,
    title: z.string(),
    status: DocumentStatus,
    regNumber: z.string().nullable(),
    externalNumber: z.string().nullable(),
    externalDate: DateOnly.nullable(),
    correspondent: CorrespondentRef.nullable(),
  }),
  fileName: z.string().nullable(),
  sha256: z.string().nullable(),
  prefillStatus: GovEdmsPrefillStatus,
  prefill: GovEdmsPrefill.nullable(),
  /** Тот же отправитель и номер уже есть у другого документа — предупреждение. */
  duplicateOf: GovEdmsDuplicate.nullable(),
  createdBy: UserRef.nullable(),
  createdAt: Timestamp,
})
export type GovEdmsIntakeRecord = z.infer<typeof GovEdmsIntakeRecord>

export const GovEdmsIntakeListQuery = z.object({
  /** `pending` — ещё не зарегистрированные черновики, `all` — вся история. */
  state: z.enum(['pending', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
})
export type GovEdmsIntakeListQuery = z.infer<typeof GovEdmsIntakeListQuery>

export const GovEdmsIntakeList = z.object({
  items: z.array(GovEdmsIntakeRecord),
  nextCursor: z.string().nullable(),
})
export type GovEdmsIntakeList = z.infer<typeof GovEdmsIntakeList>

/** Исходящий для госЭДО: адресат обменивается через неё, передача ждёт отметки. */
export const GovEdmsOutgoingState = z.object({
  /** Адресат документа обменивается через госЭДО. */
  exchange: z.boolean(),
  recipient: CorrespondentRef.nullable(),
  /** Пакет нужно передать: исходящий зарегистрирован, отметки о передаче нет. */
  pending: z.boolean(),
  /** Отметки о передаче — записи реестра отправки способом «госЭДО». */
  transfers: z.array(DocumentDispatch),
})
export type GovEdmsOutgoingState = z.infer<typeof GovEdmsOutgoingState>

/** Пакет для ручной загрузки: ссылка на ZIP живёт 15 минут. */
export const GovEdmsPackage = z.object({
  url: z.string(),
  name: z.string(),
  size: z.number().int(),
  files: z.number().int(),
})
export type GovEdmsPackage = z.infer<typeof GovEdmsPackage>

/** Отметка «передано в госЭДО»: дата и регистрационный номер в госсистеме. */
export const GovEdmsTransferInput = z.object({
  sentOn: DateOnly,
  externalNumber: z.string().trim().min(1).max(200),
  note: z.string().trim().max(1000).nullable().default(null),
})
export type GovEdmsTransferInput = z.infer<typeof GovEdmsTransferInput>

export const GovEdmsTransferResult = z.object({ dispatchId: Uuid })
export type GovEdmsTransferResult = z.infer<typeof GovEdmsTransferResult>
