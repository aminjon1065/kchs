import { z } from 'zod'
import { Timestamp } from '../common/primitives.js'

/**
 * Шина событий для администратора (ADR-0171): отставание подписчиков и очередь
 * сбоев (DLQ) — события, которые подписчик не обработал после всех попыток.
 */

/** Подписчик, у которого есть не полученные или не подтверждённые события. */
export const EventSubscriberLag = z.object({
  subscriber: z.string(),
  /** Не полученные события по всем потокам; `null` — Redis не может посчитать. */
  lag: z.number().int().nullable(),
  /** Полученные, но не подтверждённые. */
  pending: z.number().int(),
  oldestPendingSeconds: z.number().int().nullable(),
})
export type EventSubscriberLag = z.infer<typeof EventSubscriberLag>

/** Шина событий в «Здоровье системы»: размер DLQ и отстающие подписчики. */
export const HealthEvents = z.object({
  dlq: z.number().int(),
  lagging: z.array(EventSubscriberLag),
})
export type HealthEvents = z.infer<typeof HealthEvents>

export const EventDlqEntry = z.object({
  /** Идентификатор записи очереди сбоев. */
  id: z.string(),
  failedAt: Timestamp,
  subscriber: z.string(),
  error: z.string(),
  /** Сколько раз подписчик пытался обработать событие. */
  attempts: z.number().int().nullable(),
  event: z.object({
    id: z.string(),
    type: z.string(),
    occurredAt: z.string(),
    object: z
      .object({ id: z.string(), type: z.string(), title: z.string().nullable().optional() })
      .nullable(),
  }),
})
export type EventDlqEntry = z.infer<typeof EventDlqEntry>

export const EventDlqList = z.object({
  items: z.array(EventDlqEntry),
  total: z.number().int(),
})
export type EventDlqList = z.infer<typeof EventDlqList>

export const EventDlqRetryResult = z.object({
  retried: z.number().int(),
  skipped: z.number().int(),
})
export type EventDlqRetryResult = z.infer<typeof EventDlqRetryResult>
