import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'
import type { LinkKind } from '../objects/links.js'
import { CorrespondentRef } from './correspondent.js'
import { DeliveryMethod } from './document.js'
import { DocumentDirection } from './document-type.js'
import { DocumentStatus } from './lifecycle.js'

/**
 * Связи документов (08-documents.md §11, ADR-0086) — виды связей ядра, которые
 * показывает и создаёт карточка документа. `reply_to` — «в ответ на» (от ответа
 * к входящему), `in_execution_of` — «во исполнение», `cancels`/`amends` —
 * «отменяет»/«изменяет», `source` — «создан из», `about_territory` — территория.
 */
export const DOCUMENT_LINK_KINDS = [
  'reply_to',
  'in_execution_of',
  'cancels',
  'amends',
  'related',
  'source',
  'about_territory',
] as const satisfies readonly LinkKind[]
export type DocumentLinkKind = (typeof DOCUMENT_LINK_KINDS)[number]

/**
 * Ответ на документ одним действием (08-documents.md §11): исходящий черновик
 * наследует корреспондента, подразделение и гриф и связывается `reply_to`.
 * Тип — исходящий; по умолчанию первый действующий исходящий тип.
 */
export const DocumentReplyInput = z.object({
  typeId: Uuid.optional(),
})
export type DocumentReplyInput = z.infer<typeof DocumentReplyInput>

/**
 * Отметка об отправке исходящего (08-documents.md §5, реестр отправки):
 * адресат — корреспондент справочника или свободный текст. Первая отправка
 * зарегистрированного исходящего переводит его в «Исполнен».
 */
export const DocumentDispatchInput = z
  .object({
    correspondentId: Uuid.nullable().default(null),
    addressee: z.string().trim().max(500).nullable().default(null),
    method: DeliveryMethod,
    sentOn: DateOnly,
    /** Номер почтового отправления, трек, номер в СЭД адресата. */
    tracking: z.string().trim().max(200).nullable().default(null),
    note: z.string().trim().max(1000).nullable().default(null),
  })
  .refine((input) => input.correspondentId !== null || Boolean(input.addressee), {
    message: 'required',
    path: ['addressee'],
  })
export type DocumentDispatchInput = z.infer<typeof DocumentDispatchInput>

export const DocumentDispatch = z.object({
  id: Uuid,
  correspondent: CorrespondentRef.nullable(),
  addressee: z.string().nullable(),
  method: DeliveryMethod,
  sentOn: DateOnly,
  tracking: z.string().nullable(),
  note: z.string().nullable(),
  createdBy: UserRef.nullable(),
  createdAt: Timestamp,
})
export type DocumentDispatch = z.infer<typeof DocumentDispatch>

export const DocumentDispatchList = z.object({ items: z.array(DocumentDispatch) })
export type DocumentDispatchList = z.infer<typeof DocumentDispatchList>

/**
 * Документ цепочки переписки: доступный — с реквизитами; недоступный (нет
 * права или гриф выше допуска) — только позиция в цепочке, без названия.
 */
export const CorrespondenceItem = z.object({
  id: Uuid,
  accessible: z.boolean(),
  /** Документ, на который этот отвечает (внутри цепочки). */
  replyToId: Uuid.nullable(),
  current: z.boolean(),
  direction: DocumentDirection.nullable(),
  status: DocumentStatus.nullable(),
  subject: z.string(),
  regNumber: z.string().nullable(),
  regDate: DateOnly.nullable(),
  correspondent: CorrespondentRef.nullable(),
  /** Дата первой отправки исходящего. */
  sentOn: DateOnly.nullable(),
})
export type CorrespondenceItem = z.infer<typeof CorrespondenceItem>

/** Цепочка переписки по связям `reply_to` в обе стороны — по порядку дат. */
export const CorrespondenceChain = z.object({
  items: z.array(CorrespondenceItem),
  /** Цепочка обрезана по пределу — показаны ближайшие документы. */
  truncated: z.boolean(),
})
export type CorrespondenceChain = z.infer<typeof CorrespondenceChain>
