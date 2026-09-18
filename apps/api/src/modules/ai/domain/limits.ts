import { config } from '~/shared/config/index.js'
import { AppError } from '~/shared/errors.js'
import { redis } from '~/shared/redis/index.js'

/** Счётчики живут двое суток: хватает на сутки по поясу установки с запасом. */
const USAGE_TTL_SECONDS = 2 * 24 * 60 * 60

/** Сутки по часовому поясу установки: лимит обнуляется в полночь по местному времени. */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config().TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

const usageKey = (userId: string) => `kchs:ai:usage:${today()}:${userId}`

export interface AiUsage {
  requestsPerDay: number
  tokensPerDay: number
  requestsUsed: number
  tokensUsed: number
}

function limitReached(): AppError {
  return new AppError('rate_limited', 'Дневной лимит запросов к ИИ исчерпан', 429, {
    data: { reason: 'ai_limit' },
  })
}

/**
 * Суточные лимиты ИИ на пользователя (13-search-knowledge-ai.md §6): число
 * обращений к модели и токены (вход + выход). Запрос резервируется до вызова
 * провайдера, токены добавляются по факту ответа.
 */
export const AiLimits = {
  async usage(userId: string): Promise<AiUsage> {
    const row = await redis().hgetall(usageKey(userId))
    return {
      requestsPerDay: config().AI_DAILY_REQUESTS,
      tokensPerDay: config().AI_DAILY_TOKENS,
      requestsUsed: Number(row.requests ?? 0),
      tokensUsed: Number(row.tokens ?? 0),
    }
  },

  async reserve(userId: string): Promise<void> {
    const { AI_DAILY_REQUESTS: requests, AI_DAILY_TOKENS: tokens } = config()
    const key = usageKey(userId)
    const used = Number((await redis().hget(key, 'tokens')) ?? 0)
    if (used >= tokens) throw limitReached()
    const count = await redis().hincrby(key, 'requests', 1)
    await redis().expire(key, USAGE_TTL_SECONDS)
    if (count > requests) {
      // Параллельный запрос успел раньше: резерв возвращается
      await redis().hincrby(key, 'requests', -1)
      throw limitReached()
    }
  },

  async addTokens(userId: string, tokens: number): Promise<void> {
    if (tokens <= 0) return
    const key = usageKey(userId)
    await redis().hincrby(key, 'tokens', tokens)
    await redis().expire(key, USAGE_TTL_SECONDS)
  },
}
