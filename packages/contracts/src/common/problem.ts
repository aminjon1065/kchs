import { z } from 'zod'

/** Коды ошибок API (16-api-and-events.md §1). Стабильны; тексты — по локали. */
export const ERROR_CODES = [
  'validation_failed',
  'not_found',
  'forbidden',
  'unauthorized',
  'conflict',
  'rate_limited',
  'dependency_failed',
  'query_timeout',
  'policy_violation',
  'precondition_failed',
  'payload_too_large',
  'unsupported_media_type',
  'internal_error',
  'service_unavailable',
  'mfa_required',
  'password_change_required',
] as const

export const ErrorCode = z.enum(ERROR_CODES)
export type ErrorCode = z.infer<typeof ErrorCode>

/** application/problem+json (RFC 9457). */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: ErrorCode,
  errors: z
    .array(z.object({ path: z.string(), message: z.string(), code: z.string().optional() }))
    .optional(),
  retryAfter: z.number().int().optional(),
})
export type ProblemDetails = z.infer<typeof ProblemDetails>
