import { z } from 'zod'
import { EventId, Timestamp, Uuid } from '../common/primitives.js'

/** Конверт события — contracts/events.md. Событие описывает ФАКТ. */
export const ActorKind = z.enum(['user', 'system', 'automation', 'integration'])
export type ActorKind = z.infer<typeof ActorKind>

export const EventActor = z.object({
  kind: ActorKind,
  userId: Uuid.nullable(),
  onBehalfOf: Uuid.nullable().default(null),
  sessionId: z.string().nullable().default(null),
})
export type EventActor = z.infer<typeof EventActor>

export const EventObjectRef = z.object({
  id: z.string(),
  type: z.string(),
  spaceId: Uuid.nullable().default(null),
  title: z.string().nullable().default(null),
})

export const EventEnvelope = z.object({
  id: EventId,
  type: z.string(),
  version: z.number().int().min(1).default(1),
  occurredAt: Timestamp,
  actor: EventActor,
  object: EventObjectRef.nullable().default(null),
  target: EventObjectRef.nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
  changedFields: z.array(z.string()).nullable().default(null),
  correlationId: z.string().nullable().default(null),
  causationId: z.string().nullable().default(null),
  source: z.string().default('api'),
  /** Принципалы, имеющие право видеть факт события (realtime, вебхуки). */
  visibility: z
    .object({ principals: z.array(z.string()) })
    .nullable()
    .default(null),
})
export type EventEnvelope = z.infer<typeof EventEnvelope>

/** Домен события = часть до первой точки; определяет поток Redis `events:<domain>`. */
export function eventDomain(type: string): string {
  const dot = type.indexOf('.')
  return dot > 0 ? type.slice(0, dot) : type
}
