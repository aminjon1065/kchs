import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * Realtime-протокол (16-api-and-events.md §3).
 * Комнаты: user:{id}, space:{id}, object:{id}, conversation:{id}, job:{id}.
 */
export const RoomName = z
  .string()
  .regex(/^(user|space|object|conversation|job):[0-9a-fA-F-]{8,36}$/, 'некорректное имя комнаты')

export const SubscribeInput = z.object({
  rooms: z.array(RoomName).min(1).max(64),
  since: z.string().optional(),
})

export const RT_SERVER_EVENTS = [
  'object.updated',
  'object.removed',
  'message.posted',
  'message.updated',
  'notification.new',
  'inbox.changed',
  'job.progress',
  'job.finished',
  'presence',
  'typing',
  'acl.revoked',
] as const
export type RtServerEvent = (typeof RT_SERVER_EVENTS)[number]

export const RtObjectUpdated = z.object({
  id: Uuid,
  type: z.string(),
  version: z.number().int(),
  changedFields: z.array(z.string()).nullable(),
  actorId: Uuid.nullable(),
})

export const RtJobProgress = z.object({
  jobId: Uuid,
  progress: z.number().min(0).max(1),
  message: z.string().nullable(),
})

export const RtPresence = z.object({
  objectId: Uuid,
  users: z.array(z.object({ id: Uuid, displayName: z.string(), avatarUrl: z.string().nullable() })),
})

export const RtInboxChanged = z.object({
  counts: z.object({ total: z.number().int(), overdue: z.number().int() }),
})
