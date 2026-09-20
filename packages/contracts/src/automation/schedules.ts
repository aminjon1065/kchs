import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'
import { QueueName } from '../jobs/job.js'

/**
 * Единый планировщик (14-automation-integrations.md §2): повторяемые задания
 * BullMQ — обслуживание платформы, фоновые проверки модулей, правила по cron и
 * по показателю. Экран «Расписания» в администрировании показывает их вместе.
 */

export const SCHEDULE_KINDS = ['system', 'rule', 'pipeline', 'source'] as const
export const ScheduleKind = z.enum(SCHEDULE_KINDS)
export type ScheduleKind = z.infer<typeof ScheduleKind>

export const ScheduleLastRun = z.object({
  at: Timestamp,
  status: z.string(),
  durationMs: z.number().int().nullable(),
  message: z.string().nullable(),
})
export type ScheduleLastRun = z.infer<typeof ScheduleLastRun>

export const ScheduleRecord = z.object({
  /** Ключ расписания: `system:maintenance:trash.purge`, `rule:<id>`, `pipeline:<id>`. */
  key: z.string(),
  kind: ScheduleKind,
  /** Ключ словаря для системных заданий; у правил — null (название своё). */
  labelKey: z.string().nullable(),
  title: z.string().nullable(),
  queue: QueueName,
  job: z.string(),
  cron: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  nextRunAt: Timestamp.nullable(),
  lastRun: ScheduleLastRun.nullable(),
  /** Объект, которому принадлежит расписание (правило, пайплайн, источник). */
  objectId: Uuid.nullable(),
})
export type ScheduleRecord = z.infer<typeof ScheduleRecord>

export const ScheduleList = z.object({ items: z.array(ScheduleRecord) })
export type ScheduleList = z.infer<typeof ScheduleList>

export const ScheduleEnabledInput = z.object({ enabled: z.boolean() })
export type ScheduleEnabledInput = z.infer<typeof ScheduleEnabledInput>

export const ScheduleRunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type ScheduleRunsQuery = z.infer<typeof ScheduleRunsQuery>

export const ScheduleRun = z.object({
  id: Uuid,
  status: z.string(),
  message: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: Timestamp.nullable(),
  finishedAt: Timestamp.nullable(),
  createdAt: Timestamp,
})
export type ScheduleRun = z.infer<typeof ScheduleRun>

export const ScheduleRunList = z.object({ items: z.array(ScheduleRun) })
export type ScheduleRunList = z.infer<typeof ScheduleRunList>
