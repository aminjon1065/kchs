import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'

/** Очереди BullMQ (02-platform-kernel.md §9). */
export const QUEUES = [
  'imports',
  'exports',
  'transform',
  'render',
  'media',
  'ai',
  'index',
  'notify',
  'automation',
  'process-timers',
  'maintenance',
] as const
export const QueueName = z.enum(QUEUES)
export type QueueName = z.infer<typeof QueueName>

export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
export type JobStatus = z.infer<typeof JobStatus>

export const JobRecord = z.object({
  id: Uuid,
  queue: QueueName,
  name: z.string(),
  objectId: Uuid.nullable(),
  initiatorId: Uuid.nullable(),
  status: JobStatus,
  progress: z.number().min(0).max(1),
  message: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
  attempts: z.number().int(),
  createdAt: Timestamp,
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
})
export type JobRecord = z.infer<typeof JobRecord>
