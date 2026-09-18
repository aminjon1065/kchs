import { performance } from 'node:perf_hooks'
import type { AiStatus } from '@kchs/contracts'
import type { z } from 'zod'
import { hasCapability, requireCapability } from '~/kernel/access/authorize.js'
import { audit } from '~/kernel/audit/service.js'
import type { UserCtx } from '~/shared/context.js'
import { AppError, isAppError } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { aiProvider } from '../providers/index.js'
import type { AiCompletion } from '../providers/types.js'
import { AiLimits } from './limits.js'

/** Задача для модели: инструкция, вопрос и схема ответа. */
export interface AiTask<T> {
  /** Функция ИИ — для аудита и журнала, например `ask_data`. */
  feature: string
  system: string
  prompt: string
  schema: z.ZodType<T>
  schemaName: string
  maxTokens?: number
  /** Объект, к которому относится обращение, — для аудита. */
  object?: { id: string; type: string }
  /** Что ещё записать в аудит: только необходимое, без строк данных. */
  details?: Record<string, unknown>
}

function notConfigured(): AppError {
  return new AppError('service_unavailable', 'ИИ не настроен на этой установке', 503, {
    data: { reason: 'ai_not_configured' },
  })
}

/** Модель ответила не по схеме или отказалась: ничего не выполняется. */
export function invalidAnswer(message: string, issues: string[] = []): AppError {
  return new AppError('validation_failed', message, 422, {
    data: { reason: 'ai_invalid', issues: issues.slice(0, 10) },
  })
}

/**
 * Модуль ИИ (13-search-knowledge-ai.md §3, §6, ADR-0061): провайдер из
 * настроек установки, способность `ai.use`, суточные лимиты на пользователя,
 * аудит каждого обращения. Без провайдера функции скрыты, API отвечает 503.
 */
export const AiService = {
  configured(): boolean {
    return aiProvider() !== null
  },

  async status(ctx: UserCtx): Promise<AiStatus> {
    const provider = aiProvider()
    const usage = await AiLimits.usage(ctx.userId)
    return {
      enabled: provider !== null && hasCapability(ctx, 'ai.use'),
      provider: provider?.name ?? null,
      model: provider?.model ?? null,
      limits: usage,
    }
  },

  /**
   * Структурированный ответ модели, проверенный схемой, передаётся в `accept`:
   * там вызывающий модуль проверяет его по существу и исполняет. Аудит
   * записывает исход целиком — принят ответ или отклонён проверкой.
   */
  async complete<T, R>(
    ctx: UserCtx,
    task: AiTask<T>,
    accept: (answer: T) => Promise<R>,
  ): Promise<R> {
    const provider = aiProvider()
    if (!provider) throw notConfigured()
    requireCapability(ctx, 'ai.use')
    await AiLimits.reserve(ctx.userId)

    const started = performance.now()
    const record = (outcome: string, completion: AiCompletion | null, extra = {}) =>
      audit(ctx, {
        action: 'ai.request',
        objectId: task.object?.id ?? null,
        objectType: task.object?.type ?? null,
        details: {
          feature: task.feature,
          provider: provider.name,
          model: completion?.model ?? provider.model,
          outcome,
          inputTokens: completion?.inputTokens ?? 0,
          outputTokens: completion?.outputTokens ?? 0,
          durationMs: Math.round(performance.now() - started),
          ...task.details,
          ...extra,
        },
      })

    let completion: AiCompletion
    try {
      completion = await provider.complete({
        system: task.system,
        prompt: task.prompt,
        schema: task.schema,
        schemaName: task.schemaName,
        maxTokens: task.maxTokens ?? 2048,
      })
    } catch (error) {
      if (isAppError(error)) {
        logger().warn({ ...error.details, feature: task.feature }, 'ИИ: провайдер не ответил')
      }
      await record('provider_error', null)
      throw error
    }
    await AiLimits.addTokens(ctx.userId, completion.inputTokens + completion.outputTokens)

    if (completion.stop !== 'end') {
      await record(completion.stop, completion)
      throw invalidAnswer(
        completion.stop === 'refusal'
          ? 'Модель отказалась отвечать на этот вопрос'
          : 'Ответ модели оказался слишком длинным',
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(completion.text)
    } catch {
      await record('invalid_output', completion)
      throw invalidAnswer('Модель ответила не в ожидаемом формате')
    }
    const checked = task.schema.safeParse(parsed)
    if (!checked.success) {
      const issues = checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
      await record('invalid_output', completion, { issues: issues.slice(0, 5) })
      throw invalidAnswer('Модель ответила не в ожидаемом формате', issues)
    }
    try {
      const value = await accept(checked.data)
      await record('ok', completion, { answer: checked.data })
      return value
    } catch (error) {
      await record('rejected', completion, {
        answer: checked.data,
        error: isAppError(error) ? error.message : 'internal',
      })
      throw error
    }
  },
}
