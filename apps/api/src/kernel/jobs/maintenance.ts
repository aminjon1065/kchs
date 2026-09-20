import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { remindDueAcknowledgments } from '../acknowledgments/index.js'
import { pruneOutbox } from '../events/dispatcher.js'
import { InboxService } from '../inbox/service.js'
import { sendEmailDigest } from '../notifications/service.js'
import { expiredTrash, ObjectService, trimRecentViews } from '../objects/service.js'
import { declareSchedule } from '../schedules/registry.js'
import { reindexAll, reindexSubtree } from '../search/index-service.js'
import { registerJobHandler } from './runner.js'
import { JobService, pruneFinishedJobs } from './service.js'

/** Регулярные задания обслуживания (02-platform-kernel.md §9). */
export function registerMaintenanceJobs(): void {
  registerJobHandler({
    queue: 'index',
    name: 'search.reindex',
    concurrency: 1,
    handle: async (_job, helpers) => {
      const count = await reindexAll()
      await helpers.progress(1, `переиндексировано объектов: ${count}`)
      return { count }
    },
  })

  registerJobHandler({
    queue: 'index',
    name: 'search.reindex-subtree',
    concurrency: 2,
    handle: async (job, helpers) => {
      const objectId = String(job.data.objectId)
      const count = await reindexSubtree(objectId)
      await helpers.progress(1, `переиндексировано объектов: ${count}`)
      return { count }
    },
  })

  registerJobHandler({
    queue: 'maintenance',
    name: 'trash.purge',
    concurrency: 1,
    handle: async () => {
      const ctx = systemCtx('maintenance.trash')
      const ids = await expiredTrash(30)
      for (const id of ids) {
        await db().transaction((tx) => ObjectService.purge(tx, ctx, id))
      }
      return { purged: ids.length }
    },
  })

  registerJobHandler({
    queue: 'maintenance',
    name: 'outbox.prune',
    concurrency: 1,
    handle: async () => ({ deleted: await pruneOutbox(72) }),
  })

  registerJobHandler({
    queue: 'maintenance',
    name: 'notifications.digest',
    concurrency: 1,
    handle: async () => ({ sent: await sendEmailDigest(5) }),
  })

  registerJobHandler({
    queue: 'maintenance',
    name: 'jobs.redispatch',
    concurrency: 1,
    handle: async () => ({ redispatched: await JobService.redispatchStale(60) }),
  })

  registerJobHandler({
    queue: 'maintenance',
    name: 'jobs.prune',
    concurrency: 1,
    handle: async () => ({ deleted: await pruneFinishedJobs(30) }),
  })

  registerJobHandler({
    queue: 'maintenance',
    name: 'inbox.wake-snoozed',
    concurrency: 1,
    handle: async () => ({ woken: await InboxService.wakeSnoozed() }),
  })

  registerJobHandler({
    queue: 'maintenance',
    name: 'recent.trim',
    concurrency: 1,
    handle: async () => ({ deleted: await trimRecentViews() }),
  })

  // Ознакомление (ADR-0084): напоминание в день срока и после него
  registerJobHandler({
    queue: 'maintenance',
    name: 'acknowledgments.remind',
    concurrency: 1,
    handle: async () => ({ reminded: await remindDueAcknowledgments() }),
  })
}

/**
 * Расписания обслуживания объявляются в едином планировщике
 * (14-automation-integrations.md §2): экран «Расписания» показывает их
 * ближайший запуск и историю, а администратор может выключить проверку.
 */
export function scheduleMaintenance(): void {
  declareSchedule({
    queue: 'maintenance',
    name: 'inbox.wake-snoozed',
    pattern: '*/5 * * * *',
    labelKey: 'schedules.jobs.inboxWakeSnoozed',
  })
  declareSchedule({
    queue: 'maintenance',
    name: 'notifications.digest',
    pattern: '*/15 * * * *',
    labelKey: 'schedules.jobs.notificationsDigest',
  })
  declareSchedule({
    queue: 'maintenance',
    name: 'outbox.prune',
    pattern: '17 3 * * *',
    labelKey: 'schedules.jobs.outboxPrune',
  })
  declareSchedule({
    queue: 'maintenance',
    name: 'jobs.redispatch',
    pattern: '*/2 * * * *',
    labelKey: 'schedules.jobs.jobsRedispatch',
  })
  declareSchedule({
    queue: 'maintenance',
    name: 'jobs.prune',
    pattern: '41 3 * * *',
    labelKey: 'schedules.jobs.jobsPrune',
  })
  declareSchedule({
    queue: 'maintenance',
    name: 'trash.purge',
    pattern: '23 3 * * *',
    labelKey: 'schedules.jobs.trashPurge',
  })
  declareSchedule({
    queue: 'maintenance',
    name: 'recent.trim',
    pattern: '31 3 * * *',
    labelKey: 'schedules.jobs.recentTrim',
  })
  declareSchedule({
    queue: 'maintenance',
    name: 'acknowledgments.remind',
    pattern: '5 9 * * *',
    labelKey: 'schedules.jobs.acknowledgmentsRemind',
  })
}
