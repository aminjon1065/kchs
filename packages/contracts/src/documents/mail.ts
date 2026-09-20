import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Timestamp, Uuid } from '../common/primitives.js'
import { CorrespondentRef } from './correspondent.js'
import { DocumentStatus } from './lifecycle.js'

/**
 * Регистрация входящих из почтового ящика канцелярии (08-documents.md §5,
 * 14-automation-integrations.md §5, ADR-0113). Ящик описывает интеграция
 * `imap`: её конфигурация — `MailboxConfig`, пароль лежит в секретах.
 */

/** Правила отбора писем: пустой список — берём всё, что в папке. */
export const MailboxFilters = z.object({
  /** Письмо берётся, если адрес отправителя содержит одну из строк. */
  fromContains: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  /** …и тема содержит одну из строк. */
  subjectContains: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  /** Письма без вложений пропускать. */
  requireAttachment: z.boolean().default(false),
  /** Отправители, письма которых не регистрируются (рассылки, автоответы). */
  fromExcludes: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
})
export type MailboxFilters = z.infer<typeof MailboxFilters>

/** Конфигурация интеграции `imap` (секрет `password` — отдельно, зашифрован). */
export const MailboxConfig = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535).default(993),
  /** TLS с первого байта (993). Для 143 — `false` плюс STARTTLS. */
  secure: z.boolean().default(true),
  /** Проверять сертификат сервера; выключается только для своего центра сертификации. */
  tlsRejectUnauthorized: z.boolean().default(true),
  user: z.string().trim().min(1).max(320),
  folder: z.string().trim().min(1).max(255).default('INBOX'),
  /** Как часто опрашивать ящик; единый планировщик проверяет раз в 5 минут. */
  pollMinutes: z.number().int().min(5).max(1440).default(10),
  /** Сколько писем забирать за один проход. */
  batchSize: z.number().int().min(1).max(200).default(25),
  /** От чьего имени заводятся черновики: сотрудник канцелярии, не администратор. */
  runAsUserId: Uuid,
  /** Тип создаваемого документа (ключ справочника типов). */
  documentTypeKey: z.string().trim().min(1).max(64).default('incoming_letter'),
  /** Журнал регистрации; пусто — журнал по умолчанию у типа. */
  journalId: Uuid.nullable().default(null),
  /** Помечать разобранное письмо прочитанным в ящике. */
  markSeen: z.boolean().default(true),
  filters: MailboxFilters.prefault({}),
})
export type MailboxConfig = z.infer<typeof MailboxConfig>

/**
 * Состояние письма в очереди «Из почты»:
 *  - `draft` — черновик заведён, ждёт регистрации;
 *  - `registered` — документ зарегистрирован;
 *  - `rejected` — делопроизводитель отклонил письмо с причиной;
 *  - `failed` — письмо не разобралось; оно помечено, но не потеряно.
 */
export const MAIL_MESSAGE_STATUSES = ['draft', 'registered', 'rejected', 'failed'] as const
export const MailMessageStatus = z.enum(MAIL_MESSAGE_STATUSES)
export type MailMessageStatus = z.infer<typeof MailMessageStatus>

export const MailAttachmentRef = z.object({
  id: Uuid,
  name: z.string(),
  mime: z.string(),
  size: z.number().int(),
})
export type MailAttachmentRef = z.infer<typeof MailAttachmentRef>

export const MailMessageRecord = z.object({
  id: Uuid,
  integrationId: Uuid.nullable(),
  integrationName: z.string().nullable(),
  /** `Message-ID` письма или суррогат из UID ящика, если заголовка нет. */
  messageKey: z.string(),
  fromEmail: z.string(),
  fromName: z.string().nullable(),
  toEmail: z.string().nullable(),
  subject: z.string(),
  /** Текст письма — то же, что попало в «суть» карточки. */
  body: z.string(),
  sentAt: Timestamp.nullable(),
  receivedAt: Timestamp,
  status: MailMessageStatus,
  /** Черновик входящего; `null` — письмо не разобралось. */
  documentId: Uuid.nullable(),
  documentStatus: DocumentStatus.nullable(),
  documentRegNumber: z.string().nullable(),
  /** Найденный по адресу корреспондент; `null` — предлагаем завести. */
  correspondent: CorrespondentRef.nullable(),
  /** Адрес, по которому корреспондент не нашёлся. */
  suggestedCorrespondentName: z.string().nullable(),
  attachments: z.array(MailAttachmentRef),
  error: z.string().nullable(),
  rejectReason: z.string().nullable(),
  decidedBy: UserRef.nullable(),
  decidedAt: Timestamp.nullable(),
  createdAt: Timestamp,
})
export type MailMessageRecord = z.infer<typeof MailMessageRecord>

export const MailMessageListQuery = z.object({
  status: MailMessageStatus.optional(),
  integrationId: Uuid.optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
})
export type MailMessageListQuery = z.infer<typeof MailMessageListQuery>

export const MailMessageList = z.object({
  items: z.array(MailMessageRecord),
  nextCursor: z.string().nullable(),
  /** Сколько писем ждёт решения — счётчик в навигаторе. */
  pending: z.number().int(),
})
export type MailMessageList = z.infer<typeof MailMessageList>

export const MailRejectInput = z.object({
  reason: z.string().trim().min(3).max(1000),
})
export type MailRejectInput = z.infer<typeof MailRejectInput>

/** Итог одного прохода по ящику — он же запись журнала синхронизаций. */
export const MailPollResult = z.object({
  fetched: z.number().int(),
  created: z.number().int(),
  duplicates: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
})
export type MailPollResult = z.infer<typeof MailPollResult>

export const MailPollReport = z.object({
  mailboxes: z.number().int(),
  result: MailPollResult,
  errors: z.array(z.object({ integrationId: Uuid, message: z.string() })),
})
export type MailPollReport = z.infer<typeof MailPollReport>
