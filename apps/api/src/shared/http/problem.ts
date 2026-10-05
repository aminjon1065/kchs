import type { ErrorCode, ProblemDetails } from '@kchs/contracts'
import { createTranslator, normalizeLocale } from '@kchs/i18n'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ResponseSerializationError } from 'fastify-type-provider-zod'
import { ZodError } from 'zod'
import { isProd } from '../config/index.js'
import { isAppError } from '../errors.js'
import { logger, redactUrl } from '../logger/index.js'

const TYPE_BASE = 'https://kchs.local/problems'
/** Через сколько повторить запрос, если Redis недоступен: переподключение — секунды. */
const REDIS_RETRY_AFTER_SECONDS = 5

/**
 * Сбой соединения с Redis (ioredis): исчерпаны попытки команды, истёк её тайм-аут
 * или соединение закрыто. Ответы самого Redis (ошибки команд) сюда не относятся.
 */
export function isRedisUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'MaxRetriesPerRequestError') return true
  return (
    error.message === 'Command timed out' ||
    error.message === 'Connection is closed.' ||
    error.message.startsWith("Stream isn't writeable")
  )
}

export function toProblem(error: unknown, request: FastifyRequest): ProblemDetails {
  const locale = normalizeLocale(request.headers['accept-language'] ?? 'ru')
  const t = createTranslator(locale)

  // Несоответствие ответа схеме — дефект контракта: логируем с деталями
  if (error instanceof ResponseSerializationError) {
    logger().error(
      {
        url: redactUrl(request.url),
        method: request.method,
        issues: error.cause?.issues?.map((i) => ({
          path: i.path.join('.'),
          code: i.code,
          message: i.message,
        })),
      },
      'ответ не соответствует схеме контракта',
    )
    return {
      type: `${TYPE_BASE}/internal_error`,
      title: t('errors.internal_error'),
      status: 500,
      detail: isProd()
        ? undefined
        : `Ответ не соответствует схеме: ${error.cause?.issues
            ?.map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
      instance: redactUrl(request.url),
      code: 'internal_error',
    }
  }

  if (error instanceof ZodError) {
    return {
      type: `${TYPE_BASE}/validation_failed`,
      title: t('errors.validation_failed'),
      status: 400,
      code: 'validation_failed',
      instance: redactUrl(request.url),
      errors: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    }
  }

  if (isAppError(error)) {
    return {
      type: `${TYPE_BASE}/${error.code}`,
      title: t(`errors.${error.code}`),
      status: error.status,
      detail: error.message,
      instance: redactUrl(request.url),
      code: error.code,
      ...(error.fieldErrors ? { errors: error.fieldErrors } : {}),
      ...(typeof error.details?.retryAfter === 'number'
        ? { retryAfter: error.details.retryAfter as number }
        : {}),
      ...(error.data ? { data: error.data } : {}),
    }
  }

  // Ошибки валидации Fastify
  const fastifyError = error as { statusCode?: number; code?: string; message?: string }
  // Сброс нагрузки (@fastify/under-pressure, Retry-After уже в ответе): «временно недоступен»,
  // а не «внутренняя ошибка» — клиент повторит запрос
  if (fastifyError?.statusCode === 503) {
    return {
      type: `${TYPE_BASE}/service_unavailable`,
      title: t('errors.service_unavailable'),
      status: 503,
      detail: fastifyError.message,
      instance: redactUrl(request.url),
      code: 'service_unavailable',
    }
  }
  if (fastifyError?.statusCode && fastifyError.statusCode < 500) {
    const code: ErrorCode =
      fastifyError.statusCode === 429
        ? 'rate_limited'
        : fastifyError.statusCode === 413
          ? 'payload_too_large'
          : fastifyError.statusCode === 415
            ? 'unsupported_media_type'
            : 'validation_failed'
    return {
      type: `${TYPE_BASE}/${code}`,
      title: t(`errors.${code}`),
      status: fastifyError.statusCode,
      detail: fastifyError.message,
      instance: redactUrl(request.url),
      code,
    }
  }

  // Основной Redis недоступен (ADR-0175): клиент пути запроса падает быстро, а
  // ответ — «временно недоступен» с повтором, как при сбросе нагрузки
  if (isRedisUnavailable(error)) {
    logger().error({ err: error, url: redactUrl(request.url) }, 'Redis недоступен')
    return {
      type: `${TYPE_BASE}/service_unavailable`,
      title: t('errors.service_unavailable'),
      status: 503,
      instance: redactUrl(request.url),
      code: 'service_unavailable',
      retryAfter: REDIS_RETRY_AFTER_SECONDS,
    }
  }

  logger().error({ err: error, url: redactUrl(request.url) }, 'необработанная ошибка')
  return {
    type: `${TYPE_BASE}/internal_error`,
    title: t('errors.internal_error'),
    status: 500,
    detail: isProd() ? undefined : ((error as Error)?.message ?? String(error)),
    instance: redactUrl(request.url),
    code: 'internal_error',
  }
}

export function sendProblem(request: FastifyRequest, reply: FastifyReply, error: unknown): void {
  const problem = toProblem(error, request)
  if (problem.retryAfter) reply.header('retry-after', String(problem.retryAfter))
  reply.status(problem.status).type('application/problem+json').send(problem)
}
