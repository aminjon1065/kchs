import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'
import { ApiScope } from './scopes.js'

/**
 * Токен публичного API (14-automation-integrations.md §3, ADR-0097).
 * Наружу отдаются только реквизиты; сам токен показывается один раз при выпуске,
 * в базе лежит его хэш.
 */
export const ApiToken = z.object({
  id: Uuid,
  name: z.string(),
  /** Владелец: его правами действует токен. */
  userId: Uuid,
  userName: z.string().nullable(),
  /** Кто выпустил токен (администратор — для служебной учётной записи). */
  createdById: Uuid.nullable(),
  createdByName: z.string().nullable(),
  scopes: z.array(ApiScope),
  /** Видимая часть токена: по ней его узнают в списке и в журнале. */
  prefix: z.string(),
  expiresAt: Timestamp.nullable(),
  lastUsedAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
  revokedById: Uuid.nullable(),
  /** Свой потолок запросов в минуту; `null` — общий лимит установки. */
  rateLimitPerMinute: z.number().int().positive().nullable(),
  createdAt: Timestamp,
  /** Рассчитанное состояние: действует / отозван / просрочен. */
  status: z.enum(['active', 'revoked', 'expired']),
})
export type ApiToken = z.infer<typeof ApiToken>

export const ApiTokenCreateInput = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(ApiScope).min(1).max(40),
  /** Срок действия: дата или `null` — бессрочно. */
  expiresAt: Timestamp.nullable().optional(),
  /** Токен служебной учётной записи: администратор выпускает его на другого. */
  userId: Uuid.optional(),
  rateLimitPerMinute: z.number().int().min(1).max(100_000).nullable().optional(),
})
export type ApiTokenCreateInput = z.infer<typeof ApiTokenCreateInput>

/** Ответ на выпуск: `token` виден один раз и больше не восстанавливается. */
export const ApiTokenCreated = z.object({
  token: ApiToken,
  secret: z.string(),
})
export type ApiTokenCreated = z.infer<typeof ApiTokenCreated>

export const ApiTokenList = z.object({ items: z.array(ApiToken) })
export type ApiTokenList = z.infer<typeof ApiTokenList>
