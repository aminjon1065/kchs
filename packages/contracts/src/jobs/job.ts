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
  'data',
] as const
export const QueueName = z.enum(QUEUES)
export type QueueName = z.infer<typeof QueueName>

/**
 * Исполнитель очереди (ADR-0035). BullMQ отдаёт задание любому потребителю
 * очереди, поэтому у каждой очереди ровно один исполнитель: TypeScript-воркер
 * (`worker`) или Python-движок (`engine`). Регистрация обработчика в чужой
 * очереди падает на старте в обоих процессах.
 */
export const JobRuntime = z.enum(['worker', 'engine'])
export type JobRuntime = z.infer<typeof JobRuntime>

export const QUEUE_RUNTIME: Record<QueueName, JobRuntime> = {
  imports: 'engine',
  exports: 'worker',
  transform: 'engine',
  render: 'engine',
  media: 'engine',
  ai: 'engine',
  index: 'worker',
  notify: 'worker',
  automation: 'worker',
  'process-timers': 'worker',
  maintenance: 'worker',
  // Загрузка нормализованного импорта в таблицу датасета (ADR-0046)
  data: 'worker',
}

export function queuesOf(runtime: JobRuntime): QueueName[] {
  return QUEUES.filter((queue) => QUEUE_RUNTIME[queue] === runtime)
}

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
