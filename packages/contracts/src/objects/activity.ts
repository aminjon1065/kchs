import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/** Человекочитаемая запись ленты активности объекта. */
export const Activity = z.object({
  id: z.string(),
  objectId: Uuid.nullable(),
  spaceId: Uuid.nullable(),
  actorId: Uuid.nullable(),
  onBehalfOf: Uuid.nullable(),
  verb: z.string(),
  /** Ключ i18n + параметры: «Иванов изменил срок с 12.09 на 15.09». */
  summary: z.object({
    key: z.string(),
    params: z.record(z.string(), z.unknown()).default({}),
  }),
  occurredAt: Timestamp,
})
export type Activity = z.infer<typeof Activity>

export const AuditEntry = z.object({
  id: z.string(),
  occurredAt: Timestamp,
  actorId: Uuid.nullable(),
  onBehalfOf: Uuid.nullable(),
  action: z.string(),
  objectId: Uuid.nullable(),
  objectType: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).default({}),
  severity: z.enum(['info', 'notice', 'warning', 'critical']),
})
export type AuditEntry = z.infer<typeof AuditEntry>
