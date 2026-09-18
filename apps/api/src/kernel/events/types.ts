import type { EventEnvelope } from '@kchs/contracts'

/** Данные, из которых ядро собирает конверт события. */
export interface EventInput {
  type: string
  version?: number
  object?: { id: string; type: string; spaceId?: string | null; title?: string | null } | null
  target?: { id: string; type: string; spaceId?: string | null; title?: string | null } | null
  payload?: Record<string, unknown>
  changedFields?: string[] | null
  correlationId?: string | null
  causationId?: string | null
  source?: string
  /** Принципалы, которым виден факт события (заполняется ядром из ACL). */
  visibilityPrincipals?: string[] | null
}

export type EventHandler = (event: EventEnvelope) => Promise<void>

export interface Subscriber {
  /** Уникальное имя consumer group. */
  name: string
  /** Типы событий: точное имя или префикс с `*` (`object.*`). */
  types: string[]
  handle: EventHandler
  /** Сколько раз повторять до DLQ. */
  maxAttempts?: number
}
