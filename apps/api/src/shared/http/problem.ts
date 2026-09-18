import type { ErrorCode, ProblemDetails } from '@kchs/contracts'
import { createTranslator, normalizeLocale } from '@kchs/i18n'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ResponseSerializationError } from 'fastify-type-provider-zod'
import { ZodError } from 'zod'
import { isProd } from '../config/index.js'
import { isAppError } from '../errors.js'
import { logger } from '../logger/index.js'

const TYPE_BASE = 'https://kchs.local/problems'

export function toProblem(error: unknown, request: FastifyRequest): ProblemDetails {
  const locale = normalizeLocale(request.headers['accept-language'] ?? 'ru')
  const t = createTranslator(locale)

  // Несоответствие ответа схеме — дефект контракта: логируем с деталями
  if (error instanceof ResponseSerializationError) {
    logger().error(
      {
        url: request.url,
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
      instance: request.url,
      code: 'internal_error',
    }
  }

  if (error instanceof ZodError) {
    return {
      type: `${TYPE_BASE}/validation_failed`,
      title: t('errors.validation_failed'),
      status: 400,
      code: 'validation_failed',
      instance: request.url,
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
      instance: request.url,
      code: error.code,
      ...(error.fieldErrors ? { errors: error.fieldErrors } : {}),
      ...(typeof error.details?.retryAfter === 'number'
        ? { retryAfter: error.details.retryAfter as number }
        : {}),
    }
  }

  // Ошибки валидации Fastify
  const fastifyError = error as { statusCode?: number; code?: string; message?: string }
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
      instance: request.url,
      code,
    }
  }

  logger().error({ err: error, url: request.url }, 'необработанная ошибка')
  return {
    type: `${TYPE_BASE}/internal_error`,
    title: t('errors.internal_error'),
    status: 500,
    detail: isProd() ? undefined : ((error as Error)?.message ?? String(error)),
    instance: request.url,
    code: 'internal_error',
  }
}

export function sendProblem(request: FastifyRequest, reply: FastifyReply, error: unknown): void {
  const problem = toProblem(error, request)
  if (problem.retryAfter) reply.header('retry-after', String(problem.retryAfter))
  reply.status(problem.status).type('application/problem+json').send(problem)
}
