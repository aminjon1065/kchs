import { z } from 'zod'
import { Confidentiality } from '../access/confidentiality.js'
import { UserRef } from '../auth/session.js'
import { DateOnly, LangText, Timestamp, Uuid } from '../common/primitives.js'
import { CorrespondentRef } from './correspondent.js'
import { DocumentCardSchema, DocumentDirection, DocumentTypeSettings } from './document-type.js'
import { DocumentStatus } from './lifecycle.js'
import { DocumentRouteBrief } from './route.js'

/** Контроль исполнения (04-domain-model.md): не на контроле, на контроле, снят с контроля. */
export const DOCUMENT_CONTROLS = ['none', 'on', 'done'] as const
export const DocumentControl = z.enum(DOCUMENT_CONTROLS)
export type DocumentControl = z.infer<typeof DocumentControl>

/** Способ доставки входящего (08-documents.md §5). */
export const DELIVERY_METHODS = [
  'post',
  'courier',
  'email',
  'fax',
  'edms',
  'hand',
  'other',
] as const
export const DeliveryMethod = z.enum(DELIVERY_METHODS)
export type DeliveryMethod = z.infer<typeof DeliveryMethod>

export const DocumentFileRef = z.object({
  id: Uuid,
  name: z.string(),
  mime: z.string(),
  size: z.number().int(),
})
export type DocumentFileRef = z.infer<typeof DocumentFileRef>

/**
 * PDF-представление версии для просмотра, штампов и подписи (08-documents.md §8):
 * PDF — сам основной файл; DOCX и изображения движок переводит в PDF заданием.
 */
export const PDF_STATUSES = ['none', 'pending', 'ready', 'failed', 'unsupported'] as const
export const PdfStatus = z.enum(PDF_STATUSES)
export type PdfStatus = z.infer<typeof PdfStatus>

export const DocumentVersionRecord = z.object({
  id: Uuid,
  number: z.number().int(),
  mainFile: DocumentFileRef.nullable(),
  pdfFile: DocumentFileRef.nullable(),
  pdfStatus: PdfStatus,
  attachments: z.array(DocumentFileRef),
  /** SHA-256 содержимого основного файла и приложений версии. */
  hash: z.string().nullable(),
  note: z.string().nullable(),
  /** Версия заморожена (отправлена на согласование) — вторая волна. */
  isFinal: z.boolean(),
  createdBy: UserRef.nullable(),
  createdAt: Timestamp,
})
export type DocumentVersionRecord = z.infer<typeof DocumentVersionRecord>

export const DocumentVersionList = z.object({ items: z.array(DocumentVersionRecord) })
export type DocumentVersionList = z.infer<typeof DocumentVersionList>

export const DocumentVersionInput = z.object({
  mainFileId: Uuid,
  attachmentIds: z.array(Uuid).max(50).default([]),
  note: z.string().trim().max(1000).nullable().default(null),
})
export type DocumentVersionInput = z.infer<typeof DocumentVersionInput>

export const DocumentRegistration = z.object({
  journalId: Uuid,
  journalName: z.string(),
  number: z.string(),
  sequence: z.number().int(),
  year: z.number().int(),
  registeredAt: Timestamp,
  registeredBy: UserRef.nullable(),
  /** Номер взят из резерва (бумажный документ). */
  reserved: z.boolean(),
})
export type DocumentRegistration = z.infer<typeof DocumentRegistration>

/** Что текущий пользователь может сделать с документом — считает сервер. */
export const DocumentPermissions = z.object({
  edit: z.boolean(),
  register: z.boolean(),
  cancel: z.boolean(),
  addVersion: z.boolean(),
  changeConfidentiality: z.boolean(),
  share: z.boolean(),
  /** Отправить на согласование или подпись по маршруту (ADR-0083). */
  startRoute: z.boolean(),
})
export type DocumentPermissions = z.infer<typeof DocumentPermissions>

export const DocumentTypeBrief = z.object({
  id: Uuid,
  key: z.string(),
  name: LangText,
  direction: DocumentDirection,
  settings: DocumentTypeSettings,
  cardSchema: DocumentCardSchema,
  confidentialityAllowed: z.array(Confidentiality),
  journalId: Uuid.nullable(),
})
export type DocumentTypeBrief = z.infer<typeof DocumentTypeBrief>

/** Карточка документа (08-documents.md §1, 03-screens.md §12). */
export const DocumentRecord = z.object({
  id: Uuid,
  spaceId: Uuid,
  type: DocumentTypeBrief,
  status: DocumentStatus,
  subject: z.string(),
  summary: z.string().nullable(),
  regNumber: z.string().nullable(),
  regDate: DateOnly.nullable(),
  registration: DocumentRegistration.nullable(),
  correspondent: CorrespondentRef.nullable(),
  /** Исходящие реквизиты отправителя (для входящих). */
  externalNumber: z.string().nullable(),
  externalDate: DateOnly.nullable(),
  receivedDate: DateOnly.nullable(),
  deliveryMethod: DeliveryMethod.nullable(),
  author: UserRef.nullable(),
  responsible: UserRef.nullable(),
  signer: UserRef.nullable(),
  controller: UserRef.nullable(),
  deadline: DateOnly.nullable(),
  control: DocumentControl,
  overdue: z.boolean(),
  confidentiality: Confidentiality,
  territoryId: Uuid.nullable(),
  unit: z.object({ id: Uuid, name: z.string() }).nullable(),
  /** Поля карточки типа (cardSchema). */
  fields: z.record(z.string(), z.unknown()),
  currentVersion: DocumentVersionRecord.nullable(),
  versionCount: z.number().int(),
  cancelReason: z.string().nullable(),
  cancelledAt: Timestamp.nullable(),
  /** Идущий маршрут: текущие шаги и кто ждёт решения (ADR-0083). */
  route: DocumentRouteBrief.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  version: z.number().int(),
  can: DocumentPermissions,
})
export type DocumentRecord = z.infer<typeof DocumentRecord>

/** Реквизиты карточки, общие для создания и правки. */
const CardFields = {
  subject: z.string().trim().max(1000),
  summary: z.string().trim().max(20_000).nullable(),
  correspondentId: Uuid.nullable(),
  externalNumber: z.string().trim().max(120).nullable(),
  externalDate: DateOnly.nullable(),
  receivedDate: DateOnly.nullable(),
  deliveryMethod: DeliveryMethod.nullable(),
  responsibleId: Uuid.nullable(),
  signerId: Uuid.nullable(),
  deadline: DateOnly.nullable(),
  control: DocumentControl,
  controllerId: Uuid.nullable(),
  confidentiality: Confidentiality,
  territoryId: Uuid.nullable(),
  unitId: Uuid.nullable(),
  fields: z.record(z.string(), z.unknown()),
}

export const DocumentCreateInput = z.object({
  typeId: Uuid,
  subject: CardFields.subject.optional(),
  summary: CardFields.summary.optional(),
  correspondentId: CardFields.correspondentId.optional(),
  externalNumber: CardFields.externalNumber.optional(),
  externalDate: CardFields.externalDate.optional(),
  receivedDate: CardFields.receivedDate.optional(),
  deliveryMethod: CardFields.deliveryMethod.optional(),
  responsibleId: CardFields.responsibleId.optional(),
  signerId: CardFields.signerId.optional(),
  deadline: CardFields.deadline.optional(),
  control: CardFields.control.optional(),
  controllerId: CardFields.controllerId.optional(),
  confidentiality: CardFields.confidentiality.optional(),
  territoryId: CardFields.territoryId.optional(),
  unitId: CardFields.unitId.optional(),
  fields: CardFields.fields.optional(),
})
export type DocumentCreateInput = z.infer<typeof DocumentCreateInput>

export const DocumentUpdateInput = z.object({
  subject: CardFields.subject.optional(),
  summary: CardFields.summary.optional(),
  correspondentId: CardFields.correspondentId.optional(),
  externalNumber: CardFields.externalNumber.optional(),
  externalDate: CardFields.externalDate.optional(),
  receivedDate: CardFields.receivedDate.optional(),
  deliveryMethod: CardFields.deliveryMethod.optional(),
  responsibleId: CardFields.responsibleId.optional(),
  signerId: CardFields.signerId.optional(),
  deadline: CardFields.deadline.optional(),
  control: CardFields.control.optional(),
  controllerId: CardFields.controllerId.optional(),
  confidentiality: CardFields.confidentiality.optional(),
  territoryId: CardFields.territoryId.optional(),
  unitId: CardFields.unitId.optional(),
  fields: CardFields.fields.optional(),
})
export type DocumentUpdateInput = z.infer<typeof DocumentUpdateInput>

/**
 * Регистрация (08-documents.md §5): номер из журнала типа (или выбранного) в
 * транзакции с блокировкой счётчика; бумажному документу — номер из резерва.
 */
export const DocumentRegisterInput = z.object({
  journalId: Uuid.optional(),
  reservationId: Uuid.optional(),
})
export type DocumentRegisterInput = z.infer<typeof DocumentRegisterInput>

/** Аннулирование — со способностью и обоснованием (08-documents.md §3). */
export const DocumentCancelInput = z.object({
  reason: z.string().trim().min(5).max(2000),
})
export type DocumentCancelInput = z.infer<typeof DocumentCancelInput>

/** Счётчики навигатора «Документы». */
export const DocumentSummary = z.object({
  mine: z.number().int(),
  onControl: z.number().int(),
  overdue: z.number().int(),
  drafts: z.number().int(),
})
export type DocumentSummary = z.infer<typeof DocumentSummary>

/**
 * Ответ движка о версии (внутренний маршрут): SHA-256 основного файла и, если
 * просили перевод, PDF-представление под ключом заранее выданного файла.
 */
export const DocumentPdfResult = z.object({
  status: z.enum(['ready', 'failed', 'unsupported', 'skipped']),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  pdfFileId: Uuid.nullable().default(null),
  pdfVersionId: Uuid.nullable().default(null),
  storageKey: z.string().max(1024).nullable().default(null),
  size: z.number().int().min(0).nullable().default(null),
  pages: z.number().int().min(0).nullable().default(null),
  error: z.string().max(4000).nullable().default(null),
})
export type DocumentPdfResult = z.infer<typeof DocumentPdfResult>
