import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Ассистент в контекстной панели (13-search-knowledge-ai.md §5, ADR-0100):
 * диалог по текущему объекту с инструментами. Инструменты вызывают те же
 * сервисы, что и интерфейс, от имени пользователя — ассистент не видит
 * больше, чем он. Создание объектов — только предложением, которое
 * подтверждает человек.
 */

/** Что ассистент умеет делать сам: чтение, ничего меняющего. */
export const ASSISTANT_TOOLS = ['search', 'similar', 'get_object', 'file_text', 'ask_data'] as const
export const AssistantTool = z.enum(ASSISTANT_TOOLS)
export type AssistantTool = z.infer<typeof AssistantTool>

/** Шаг рассуждения: что ассистент сделал, прежде чем ответить. */
export const AssistantStep = z.object({
  tool: AssistantTool,
  /** Человекочитаемо: «искал: паводок в Хатлоне». */
  summary: z.string(),
  /** Сколько нашлось — для честности ответа «ничего не нашёл». */
  found: z.number().int(),
})
export type AssistantStep = z.infer<typeof AssistantStep>

/** Ссылка-чип на объект: ответ опирается на то, что пользователю доступно. */
export const AssistantCitation = z.object({
  objectId: Uuid,
  type: z.string(),
  title: z.string(),
  url: z.string(),
  snippet: z.string().nullable(),
})
export type AssistantCitation = z.infer<typeof AssistantCitation>

/** Предложение действия: выполняет его человек нажатием, не модель. */
export const AssistantProposal = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('task'),
    title: z.string().min(1).max(300),
    description: z.string().max(4000).default(''),
    /** Объект-источник поручения, если ассистент на него опирался. */
    sourceId: Uuid.nullable().default(null),
  }),
  z.object({
    kind: z.literal('document'),
    subject: z.string().min(1).max(500),
    summary: z.string().max(4000).default(''),
  }),
])
export type AssistantProposal = z.infer<typeof AssistantProposal>

export const AssistantMessage = z.object({
  id: Uuid,
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  steps: z.array(AssistantStep).default([]),
  citations: z.array(AssistantCitation).default([]),
  proposals: z.array(AssistantProposal).default([]),
  createdAt: Timestamp,
})
export type AssistantMessage = z.infer<typeof AssistantMessage>

export const AssistantThread = z.object({
  id: Uuid,
  /** Объект, о котором идёт разговор; null — общий диалог из палитры. */
  objectId: Uuid.nullable(),
  messages: z.array(AssistantMessage),
})
export type AssistantThread = z.infer<typeof AssistantThread>

export const AssistantAskInput = z.object({
  objectId: Uuid.nullable().default(null),
  question: z.string().trim().min(2).max(2000),
})
export type AssistantAskInput = z.infer<typeof AssistantAskInput>

export const AssistantThreadQuery = z.object({
  objectId: Uuid.optional(),
})
export type AssistantThreadQuery = z.infer<typeof AssistantThreadQuery>

/** Предел шагов на один вопрос: ассистент не ходит по кругу. */
export const ASSISTANT_MAX_STEPS = 4

/** Перевод текста между языками интерфейса (13-search-knowledge-ai.md §4). */
export const TRANSLATE_LANGUAGES = ['ru', 'tg', 'en'] as const
export const TranslateLanguage = z.enum(TRANSLATE_LANGUAGES)
export type TranslateLanguage = z.infer<typeof TranslateLanguage>

export const TranslateInput = z.object({
  text: z.string().trim().min(1).max(8000),
  to: TranslateLanguage,
})
export type TranslateInput = z.infer<typeof TranslateInput>

export const TranslateResult = z.object({
  text: z.string(),
  /** Язык оригинала, как его определила модель. */
  from: z.string(),
})
export type TranslateResult = z.infer<typeof TranslateResult>
