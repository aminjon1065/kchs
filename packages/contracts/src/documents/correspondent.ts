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

/**
 * Общие почтовые сервисы: их домен не принадлежит ведомству, по нему корреспондента не
 * подставляют (ADR-0136). Поддомены сервисов — тоже.
 */
export const PUBLIC_MAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'mail.ru',
  'bk.ru',
  'inbox.ru',
  'list.ru',
  'internet.ru',
  'yandex.ru',
  'yandex.com',
  'ya.ru',
  'rambler.ru',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.net',
  'zoho.com',
  'mail.com',
  'ukr.net',
] as const

export function isPublicMailDomain(domain: string): boolean {
  const value = domain.toLowerCase()
  return PUBLIC_MAIL_DOMAINS.some((item) => value === item || value.endsWith(`.${item}`))
}

const MAIL_DOMAIN_RE =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/

/**
 * Почтовый домен ведомства (ADR-0136): `mvd.tj` — письма с адресов `…@mvd.tj` и
 * `…@dushanbe.mvd.tj` получают этого корреспондента. «@» в начале снимается.
 */
export const CorrespondentMailDomain = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/^@/, ''))
  .pipe(
    z
      .string()
      .regex(MAIL_DOMAIN_RE, 'Домен вида mvd.tj — без адреса и «@»')
      .refine(
        (value) => !isPublicMailDomain(value),
        'Домен общего почтового сервиса не принадлежит ведомству',
      ),
  )

/** Домены корреспондента: без повторов, не больше 20. */
const CorrespondentMailDomains = z
  .array(CorrespondentMailDomain)
  .max(20)
  .transform((values) => [...new Set(values)])

export const CorrespondentRecord = z.object({
  id: Uuid,
  kind: CorrespondentKind,
  name: z.string(),
  details: CorrespondentDetails,
  contacts: CorrespondentContacts,
  externalId: z.string().nullable(),
  /** Почтовые домены ведомства — по ним приём из почты подставляет корреспондента. */
  mailDomains: z.array(z.string()),
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
  mailDomains: CorrespondentMailDomains.default([]),
})
export type CorrespondentInput = z.infer<typeof CorrespondentInput>

export const CorrespondentUpdateInput = z.object({
  kind: CorrespondentKind.optional(),
  name: z.string().trim().min(1).max(300).optional(),
  details: CorrespondentDetails.optional(),
  contacts: CorrespondentContacts.optional(),
  externalId: z.string().max(120).nullable().optional(),
  mailDomains: CorrespondentMailDomains.optional(),
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
