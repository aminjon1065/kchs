import type { AiProvider } from '@kchs/contracts'
import type { z } from 'zod'
import { AppError } from '~/shared/errors.js'

/** Запрос к модели со структурированным ответом по JSON-схеме. */
export interface AiCompletionRequest {
  system: string
  prompt: string
  /** Схема ответа: провайдер требует от модели JSON строго по ней. */
  schema: z.ZodType
  /** Имя схемы для провайдеров, которым оно нужно (OpenAI-совместимые). */
  schemaName: string
  maxTokens: number
}

export interface AiCompletion {
  text: string
  model: string
  inputTokens: number
  outputTokens: number
  /** `refusal` — модель отказалась отвечать, `truncated` — ответ обрезан лимитом токенов. */
  stop: 'end' | 'truncated' | 'refusal'
}

/**
 * Сменяемый провайдер (13-search-knowledge-ai.md §3): облако Anthropic или
 * свой сервер с OpenAI-совместимым API. Выбор — настройка установки.
 */
export interface AiProviderClient {
  readonly name: AiProvider
  readonly model: string
  complete(request: AiCompletionRequest): Promise<AiCompletion>
}

/**
 * Провайдер недоступен или отверг запрос (сеть, тайм-аут, ключ, перегрузка):
 * пользователь видит «сервис ИИ недоступен», подробности — только в журнале.
 */
export function providerUnavailable(details: Record<string, unknown>, cause?: unknown): AppError {
  return new AppError('dependency_failed', 'Сервис ИИ недоступен — попробуйте позже', 424, {
    details,
    data: { reason: 'ai_provider' },
    cause,
  })
}
