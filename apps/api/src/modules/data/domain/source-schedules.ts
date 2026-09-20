import { eq } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { queue } from '~/kernel/jobs/service.js'
import type { EntityScheduleEntry, EntityScheduleProvider } from '~/kernel/schedules/index.js'
import { config } from '~/shared/config/index.js'
import { db } from '~/shared/db/client.js'
import { sources } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { SOURCE_SYNC_JOB, SourceService } from './source-service.js'

/**
 * Расписания синхронизации внешних источников (ADR-0107): планировщик BullMQ на
 * запись, как у правил (ADR-0096) и пайплайнов (ADR-0106). Второго планировщика
 * не заводим — экран «Расписания» показывает их через порт ядра.
 */
const PREFIX = 'source-'
const schedulerId = (sourceId: string) => `${PREFIX}${sourceId}`

/** Служебное задание планировщика: ставит обычную синхронизацию. */
export const SOURCE_SCHEDULE_JOB = { queue: 'data', name: 'source.scheduled' } as const

export async function syncSourceSchedule(sourceId: string): Promise<void> {
  const [row] = await db()
    .select({ schedule: sources.schedule, enabled: sources.enabled })
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1)
  const bull = queue(SOURCE_SYNC_JOB.queue)
  if (!row?.schedule || !row.enabled) {
    await bull.removeJobScheduler(schedulerId(sourceId))
    return
  }
  await bull.upsertJobScheduler(
    schedulerId(sourceId),
    { pattern: row.schedule, tz: config().TZ },
    { name: SOURCE_SCHEDULE_JOB.name, data: { sourceId }, opts: { attempts: 1 } },
  )
}

export async function syncSourceSchedules(): Promise<number> {
  const rows = await SourceService.scheduled()
  const wanted = new Set<string>()
  for (const row of rows) {
    await syncSourceSchedule(row.id)
    if (row.enabled) wanted.add(schedulerId(row.id))
  }
  const bull = queue(SOURCE_SYNC_JOB.queue)
  for (const scheduler of await bull.getJobSchedulers(0, -1)) {
    const key = scheduler.key ?? scheduler.id
    if (typeof key !== 'string' || !key.startsWith(PREFIX)) continue
    if (!wanted.has(key)) await bull.removeJobScheduler(key)
  }
  logger().info({ sources: wanted.size }, 'расписания источников синхронизированы')
  return wanted.size
}

export const sourceScheduleProvider: EntityScheduleProvider = {
  kind: 'source',
  list: async (): Promise<EntityScheduleEntry[]> => {
    const rows = await SourceService.scheduled()
    return rows.map((row) => ({
      objectId: row.id,
      title: row.title,
      cron: row.cron,
      timezone: config().TZ,
      enabled: row.enabled,
      queue: SOURCE_SYNC_JOB.queue,
      job: SOURCE_SYNC_JOB.name,
      lastRunAt: row.lastRunAt,
      lastStatus: row.status,
    }))
  },

  setEnabled: async (ctx, sourceId, enabled) => {
    await authorize(ctx, 'manage', sourceId)
    await SourceService.setEnabled(ctx, sourceId, enabled)
    await syncSourceSchedule(sourceId)
  },

  runNow: async (ctx, sourceId) => {
    await authorize(ctx, 'sync', sourceId)
    const started = await SourceService.run(ctx, sourceId)
    logger().info({ sourceId, runId: started.runId }, 'источник синхронизируется вручную')
  },
}
