import type { QueueName } from '@kchs/contracts'
import { type Job, type Processor, Worker } from 'bullmq'
import { logger } from '~/shared/logger/index.js'
import { createRedisConnection } from '~/shared/redis/index.js'
import { closeQueues, JobService } from './service.js'

export interface JobHandler {
  queue: QueueName
  name: string
  concurrency?: number
  handle: (job: Job, helpers: JobHelpers) => Promise<Record<string, unknown> | undefined>
}

export interface JobHelpers {
  recordId: string
  progress: (value: number, message?: string) => Promise<void>
  log: ReturnType<typeof logger>
}

const handlers = new Map<string, JobHandler>()
const workers: Worker[] = []

export function registerJobHandler(handler: JobHandler): void {
  const key = `${handler.queue}:${handler.name}`
  if (handlers.has(key)) throw new Error(`Обработчик задания ${key} уже зарегистрирован`)
  handlers.set(key, handler)
}

export function listJobHandlers(): JobHandler[] {
  return [...handlers.values()]
}

/** Запускает по одному воркеру на очередь, в которой есть обработчики. */
export function startWorkers(): void {
  const byQueue = new Map<QueueName, JobHandler[]>()
  for (const handler of handlers.values()) {
    const list = byQueue.get(handler.queue) ?? []
    list.push(handler)
    byQueue.set(handler.queue, list)
  }

  for (const [queueName, queueHandlers] of byQueue) {
    const concurrency = Math.max(...queueHandlers.map((h) => h.concurrency ?? 4))
    const processor: Processor = async (job) => {
      const handler = handlers.get(`${queueName}:${job.name}`)
      if (!handler) throw new Error(`Нет обработчика для ${queueName}:${job.name}`)

      const recordId = (job.data as { jobRecordId?: string }).jobRecordId ?? job.id ?? ''
      const log = logger().child({ queue: queueName, job: job.name, jobId: recordId })

      await JobService.start(recordId)
      try {
        const result = await handler.handle(job, {
          recordId,
          progress: (value, message) => JobService.progress(recordId, value, message),
          log,
        })
        await JobService.finish(recordId, result ?? {})
        return result
      } catch (error) {
        await JobService.fail(recordId, error)
        throw error
      }
    }

    const worker = new Worker(queueName, processor, {
      connection: createRedisConnection(`worker-${queueName}`),
      concurrency,
    })
    worker.on('failed', (job, err) =>
      logger().warn({ queue: queueName, jobId: job?.id, err }, 'задание не выполнено'),
    )
    workers.push(worker)
  }

  logger().info(
    { queues: [...byQueue.keys()], handlers: handlers.size },
    'обработчики заданий запущены',
  )
}

export async function stopWorkers(): Promise<void> {
  await Promise.allSettled(workers.map((w) => w.close()))
  workers.length = 0
  await closeQueues()
}
