import { systemCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { pruneOutbox } from '../events/dispatcher.js'
import { InboxService } from '../inbox/service.js'
import { sendEmailDigest } from '../notifications/service.js'
import { expiredTrash, ObjectService, trimRecentViews } from '../objects/service.js'
import { reindexAll, reindexSubtree } from '../search/index-service.js'
import { registerJobHandler } from './runner.js'
import { JobService, pruneFinishedJobs, queue } from './service.js'

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
}

/** Расписания: повторяемые задания BullMQ. Идемпотентны по ключу. */
export async function scheduleMaintenance(): Promise<void> {
  const maintenance = queue('maintenance')
  await maintenance.add(
    'inbox.wake-snoozed',
    {},
    { repeat: { pattern: '*/5 * * * *' }, jobId: 'cron:inbox.wake-snoozed' },
  )
  await maintenance.add(
    'notifications.digest',
    {},
    { repeat: { pattern: '*/15 * * * *' }, jobId: 'cron:notifications.digest' },
  )
  await maintenance.add(
    'outbox.prune',
    {},
    { repeat: { pattern: '17 3 * * *' }, jobId: 'cron:outbox.prune' },
  )
  await maintenance.add(
    'jobs.redispatch',
    {},
    { repeat: { pattern: '*/2 * * * *' }, jobId: 'cron:jobs.redispatch' },
  )
  await maintenance.add(
    'jobs.prune',
    {},
    { repeat: { pattern: '41 3 * * *' }, jobId: 'cron:jobs.prune' },
  )
  await maintenance.add(
    'trash.purge',
    {},
    { repeat: { pattern: '23 3 * * *' }, jobId: 'cron:trash.purge' },
  )
  await maintenance.add(
    'recent.trim',
    {},
    { repeat: { pattern: '31 3 * * *' }, jobId: 'cron:recent.trim' },
  )
  logger().info('расписания обслуживания зарегистрированы')
}
