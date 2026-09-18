import type { ErrorCode } from '@kchs/contracts'

/**
 * Единственный способ сообщить об ошибке из доменной логики.
 * `throw new Error('...')` в модулях запрещён (01-project-structure.md).
 */
export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: number
  readonly details?: Record<string, unknown>
  readonly fieldErrors?: Array<{ path: string; message: string; code?: string }>

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    options?: {
      details?: Record<string, unknown>
      fieldErrors?: Array<{ path: string; message: string; code?: string }>
      cause?: unknown
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined)
    this.name = 'AppError'
    this.code = code
    this.status = status
    this.details = options?.details
    this.fieldErrors = options?.fieldErrors
  }
}

export const errors = {
  /** Нет `view` → существование объекта не раскрывается (17-security.md §3). */
  notFound: (what = 'Объект', details?: Record<string, unknown>) =>
    new AppError('not_found', `${what} не найден`, 404, { details }),

  forbidden: (message = 'Недостаточно прав', details?: Record<string, unknown>) =>
    new AppError('forbidden', message, 403, { details }),

  unauthorized: (message = 'Требуется вход') => new AppError('unauthorized', message, 401),

  validation: (
    message = 'Проверьте заполнение полей',
    fieldErrors?: Array<{ path: string; message: string; code?: string }>,
  ) => new AppError('validation_failed', message, 400, { fieldErrors }),

  conflict: (message: string, details?: Record<string, unknown>) =>
    new AppError('conflict', message, 409, { details }),

  preconditionFailed: (
    message = 'Объект изменён другим пользователем',
    details?: Record<string, unknown>,
  ) => new AppError('precondition_failed', message, 412, { details }),

  rateLimited: (retryAfter: number) =>
    new AppError('rate_limited', 'Слишком много запросов', 429, { details: { retryAfter } }),

  dependencyFailed: (message: string, details?: Record<string, unknown>) =>
    new AppError('dependency_failed', message, 424, { details }),

  policyViolation: (message: string, details?: Record<string, unknown>) =>
    new AppError('policy_violation', message, 422, { details }),

  queryTimeout: (message = 'Запрос выполнялся слишком долго') =>
    new AppError('query_timeout', message, 504),

  payloadTooLarge: (message = 'Слишком большой объём данных') =>
    new AppError('payload_too_large', message, 413),

  mfaRequired: (details?: Record<string, unknown>) =>
    new AppError('mfa_required', 'Требуется подтверждение вторым фактором', 401, { details }),

  internal: (message = 'Внутренняя ошибка', cause?: unknown) =>
    new AppError('internal_error', message, 500, { cause }),

  unavailable: (message = 'Сервис временно недоступен') =>
    new AppError('service_unavailable', message, 503),
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
