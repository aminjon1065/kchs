import { z } from 'zod'
import { Confidentiality } from '../access/confidentiality.js'
import { CorrespondentRef } from './correspondent.js'

/**
 * ИИ в документах (08-documents.md §5, 13-search-knowledge-ai.md §4, ADR-0088):
 * реквизиты из скана при регистрации, краткое содержание, черновик ответа.
 * Модель только предлагает — человек принимает каждое значение сам.
 */

/** Почему помощь недоступна для этого документа. */
export const DOCUMENT_ASSIST_BLOCKERS = [
  /** Провайдер ИИ не настроен или нет способности `ai.use`. */
  'ai_disabled',
  /** Гриф документа выше порога установки для передачи модели. */
  'confidentiality',
  /** У документа нет основного файла текущей версии. */
  'no_file',
  /** Текст файла ещё извлекается (OCR). */
  'text_pending',
  /** Текст извлечь не удалось или он пуст. */
  'no_text',
] as const
export const DocumentAssistBlocker = z.enum(DOCUMENT_ASSIST_BLOCKERS)
export type DocumentAssistBlocker = z.infer<typeof DocumentAssistBlocker>

export const DocumentAssistStatus = z.object({
  /** Помощь доступна: провайдер, способность, гриф и текст — в порядке. */
  available: z.boolean(),
  blocker: DocumentAssistBlocker.nullable(),
  /** Порог грифа установки: документы строже в модель не уходят. */
  maxConfidentiality: Confidentiality,
  /** Длина извлечённого текста основного файла. */
  textChars: z.number().int(),
})
export type DocumentAssistStatus = z.infer<typeof DocumentAssistStatus>

/** Реквизиты, которые предлагает извлечение; поля карточки типа — `fields.<ключ>`. */
export const DOCUMENT_EXTRACT_KEYS = [
  'subject',
  'summary',
  'externalNumber',
  'externalDate',
  'receivedDate',
] as const
export const DocumentExtractKey = z.union([
  z.enum(DOCUMENT_EXTRACT_KEYS),
  z.string().regex(/^fields\.[a-z][a-z0-9_]{0,63}$/),
])
export type DocumentExtractKey = z.infer<typeof DocumentExtractKey>

export const DocumentExtractedField = z.object({
  key: DocumentExtractKey,
  /** Значение в виде поля формы: даты — `ГГГГ-ММ-ДД`, числа — строкой. */
  value: z.string(),
  /** Уверенность модели 0…1: подсветка в форме. */
  confidence: z.number().min(0).max(1),
  /** Фрагмент текста скана, на котором основано предложение. */
  quote: z.string().nullable(),
})
export type DocumentExtractedField = z.infer<typeof DocumentExtractedField>

export const DocumentExtraction = z.object({
  fields: z.array(DocumentExtractedField),
  /** Отправитель по тексту и найденная запись справочника корреспондентов. */
  correspondent: z
    .object({
      name: z.string(),
      confidence: z.number().min(0).max(1),
      quote: z.string().nullable(),
      match: CorrespondentRef.nullable(),
    })
    .nullable(),
  /** Текст длиннее предела и передан модели не целиком. */
  truncated: z.boolean(),
})
export type DocumentExtraction = z.infer<typeof DocumentExtraction>

export const DocumentSummaryDraft = z.object({
  summary: z.string(),
  truncated: z.boolean(),
})
export type DocumentSummaryDraft = z.infer<typeof DocumentSummaryDraft>

export const DocumentReplyDraftInput = z.object({
  /** Что сказать в ответе: «согласны, срок — до 1 октября». */
  instructions: z.string().trim().max(2000).optional(),
})
export type DocumentReplyDraftInput = z.infer<typeof DocumentReplyDraftInput>

export const DocumentReplyDraft = z.object({
  subject: z.string(),
  body: z.string(),
  truncated: z.boolean(),
})
export type DocumentReplyDraft = z.infer<typeof DocumentReplyDraft>
