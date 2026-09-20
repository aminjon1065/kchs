export * from './assistant.js'

import { z } from 'zod'

/**
 * Модуль ИИ (13-search-knowledge-ai.md §3, ADR-0061): сменяемый провайдер,
 * лимиты на пользователя, аудит. Без провайдера функции ИИ скрыты.
 */
export const AI_PROVIDERS = ['anthropic', 'openai-compat'] as const
export const AiProvider = z.enum(AI_PROVIDERS)
export type AiProvider = z.infer<typeof AiProvider>

export const AiStatus = z.object({
  /** Провайдер настроен и у пользователя есть способность `ai.use`. */
  enabled: z.boolean(),
  provider: AiProvider.nullable(),
  model: z.string().nullable(),
  /** Суточные лимиты пользователя и израсходованное за сегодня. */
  limits: z.object({
    requestsPerDay: z.number().int(),
    tokensPerDay: z.number().int(),
    requestsUsed: z.number().int(),
    tokensUsed: z.number().int(),
  }),
})
export type AiStatus = z.infer<typeof AiStatus>
