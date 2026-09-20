import { eq } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { queue } from '~/kernel/jobs/service.js'
import type { EntityScheduleEntry, EntityScheduleProvider } from '~/kernel/schedules/index.js'
import { config } from '~/shared/config/index.js'
import { db } from '~/shared/db/client.js'
import { pipelines } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { PIPELINE_JOB, PipelineService } from './pipeline-service.js'

/**
 * Расписания отдельных пайплайнов (ADR-0106): планировщик BullMQ на запись, как
 * у правил автоматизации (ADR-0096). Второго планировщика не заводим — экран
 * «Расписания» показывает их через порт ядра.
 */

/** Без «:» — иначе BullMQ читает ключ как запись старого формата. */
const PREFIX = 'pipeline-'
const schedulerId = (pipelineId: string) => `${PREFIX}${pipelineId}`

/** Приводит планировщик пайплайна к его состоянию. */
export async function syncPipelineSchedule(pipelineId: string): Promise<void> {
  const [row] = await db()
    .select({ schedule: pipelines.schedule, enabled: pipelines.enabled })
    .from(pipelines)
    .where(eq(pipelines.id, pipelineId))
    .limit(1)
  const bull = queue(PIPELINE_JOB.queue)
  if (!row?.schedule || !row.enabled) {
    await bull.removeJobScheduler(schedulerId(pipelineId))
    return
  }
  await bull.upsertJobScheduler(
    schedulerId(pipelineId),
    { pattern: row.schedule, tz: config().TZ },
    {
      name: PIPELINE_SCHEDULE_JOB.name,
      data: { pipelineId },
      opts: { attempts: 1 },
    },
  )
}

/** Задание, которое ставит планировщик: ставит обычный прогон от имени владельца. */
export const PIPELINE_SCHEDULE_JOB = { queue: 'data', name: 'pipeline.scheduled' } as const

/** При старте воркера: планировщики всех пайплайнов с расписанием, лишние — снять. */
export async function syncPipelineSchedules(): Promise<number> {
  const rows = await PipelineService.scheduled()
  const wanted = new Set<string>()
  for (const row of rows) {
    await syncPipelineSchedule(row.id)
    if (row.enabled) wanted.add(schedulerId(row.id))
  }
  const bull = queue(PIPELINE_JOB.queue)
  for (const scheduler of await bull.getJobSchedulers(0, -1)) {
    const key = scheduler.key ?? scheduler.id
    if (typeof key !== 'string' || !key.startsWith(PREFIX)) continue
    if (!wanted.has(key)) await bull.removeJobScheduler(key)
  }
  logger().info({ pipelines: wanted.size }, 'расписания пайплайнов синхронизированы')
  return wanted.size
}

export const pipelineScheduleProvider: EntityScheduleProvider = {
  kind: 'pipeline',
  list: async (): Promise<EntityScheduleEntry[]> => {
    const rows = await PipelineService.scheduled()
    return rows.map((row) => ({
      objectId: row.id,
      title: row.title,
      cron: row.cron,
      timezone: config().TZ,
      enabled: row.enabled,
      queue: PIPELINE_JOB.queue,
      job: PIPELINE_JOB.name,
      lastRunAt: row.lastRunAt,
      lastStatus: row.status,
    }))
  },

  setEnabled: async (ctx, pipelineId, enabled) => {
    await authorize(ctx, 'manage', pipelineId)
    await PipelineService.setEnabled(ctx, pipelineId, enabled)
    await syncPipelineSchedule(pipelineId)
  },

  runNow: async (ctx, pipelineId) => {
    await authorize(ctx, 'run', pipelineId)
    const started = await PipelineService.run(ctx, pipelineId, 'manual')
    logger().info({ pipelineId, runId: started.runId }, 'пайплайн запущен вручную')
  },
}
