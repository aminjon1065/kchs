import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/** Корреспондент — организация или лицо (04-domain-model.md, 08-documents.md §5). */
export const CORRESPONDENT_KINDS = ['organization', 'person'] as const
export const CorrespondentKind = z.enum(CORRESPONDENT_KINDS)
export type CorrespondentKind = z.infer<typeof CorrespondentKind>

/** Реквизиты: адрес, ИНН, руководитель; свободные ключи — справочник их не ограничивает. */
export const CorrespondentDetails = z
  .object({
    shortName: z.string().max(200).optional(),
    address: z.string().max(500).optional(),
    taxId: z.string().max(32).optional(),
    head: z.string().max(200).optional(),
    note: z.string().max(2000).optional(),
  })
  .catchall(z.string().max(500))
export type CorrespondentDetails = z.infer<typeof CorrespondentDetails>

export const CorrespondentContacts = z.object({
  email: z.string().max(200).optional(),
  phone: z.string().max(64).optional(),
  fax: z.string().max(64).optional(),
  website: z.string().max(200).optional(),
})
export type CorrespondentContacts = z.infer<typeof CorrespondentContacts>

export const CorrespondentRecord = z.object({
  id: Uuid,
  kind: CorrespondentKind,
  name: z.string(),
  details: CorrespondentDetails,
  contacts: CorrespondentContacts,
  externalId: z.string().nullable(),
  documentCount: z.number().int(),
  canEdit: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type CorrespondentRecord = z.infer<typeof CorrespondentRecord>

/** Короткая ссылка для карточки и списка документов. */
export const CorrespondentRef = z.object({ id: Uuid, kind: CorrespondentKind, name: z.string() })
export type CorrespondentRef = z.infer<typeof CorrespondentRef>

export const CorrespondentInput = z.object({
  kind: CorrespondentKind.default('organization'),
  name: z.string().trim().min(1).max(300),
  details: CorrespondentDetails.default({}),
  contacts: CorrespondentContacts.default({}),
  externalId: z.string().max(120).nullable().default(null),
})
export type CorrespondentInput = z.infer<typeof CorrespondentInput>

export const CorrespondentUpdateInput = z.object({
  kind: CorrespondentKind.optional(),
  name: z.string().trim().min(1).max(300).optional(),
  details: CorrespondentDetails.optional(),
  contacts: CorrespondentContacts.optional(),
  externalId: z.string().max(120).nullable().optional(),
})
export type CorrespondentUpdateInput = z.infer<typeof CorrespondentUpdateInput>

export const CorrespondentListQuery = z.object({
  q: z.string().max(200).optional(),
  kind: CorrespondentKind.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
})
export type CorrespondentListQuery = z.infer<typeof CorrespondentListQuery>

export const CorrespondentList = z.object({
  items: z.array(CorrespondentRecord),
  nextCursor: z.string().nullable(),
})
export type CorrespondentList = z.infer<typeof CorrespondentList>
