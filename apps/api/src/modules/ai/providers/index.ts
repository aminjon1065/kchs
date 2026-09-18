import { config } from '~/shared/config/index.js'
import { anthropicProvider } from './anthropic.js'
import { openAiCompatProvider } from './openai-compat.js'
import type { AiProviderClient } from './types.js'

/** Модель Anthropic по умолчанию — для качества (13-search-knowledge-ai.md §3). */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5'

let current: { key: string; client: AiProviderClient } | null = null

/**
 * Провайдер из конфигурации установки; `null` — ИИ выключен (`AI_PROVIDER`
 * пуст). Клиент создаётся заново при смене настроек (тесты меняют их на лету).
 */
export function aiProvider(): AiProviderClient | null {
  const env = config()
  if (!env.AI_PROVIDER) return null
  const key = [
    env.AI_PROVIDER,
    env.AI_MODEL,
    env.ANTHROPIC_BASE_URL,
    env.ANTHROPIC_API_KEY,
    env.OPENAI_COMPAT_URL,
    env.OPENAI_COMPAT_API_KEY,
    env.AI_TIMEOUT_MS,
  ].join('|')
  if (current?.key === key) return current.client

  let client: AiProviderClient | null = null
  if (env.AI_PROVIDER === 'anthropic' && env.ANTHROPIC_API_KEY) {
    client = anthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
      model: env.AI_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
      timeoutMs: env.AI_TIMEOUT_MS,
    })
  } else if (env.AI_PROVIDER === 'openai-compat' && env.OPENAI_COMPAT_URL && env.AI_MODEL) {
    client = openAiCompatProvider({
      baseUrl: env.OPENAI_COMPAT_URL,
      ...(env.OPENAI_COMPAT_API_KEY ? { apiKey: env.OPENAI_COMPAT_API_KEY } : {}),
      model: env.AI_MODEL,
      timeoutMs: env.AI_TIMEOUT_MS,
    })
  }
  current = client ? { key, client } : null
  return client
}
