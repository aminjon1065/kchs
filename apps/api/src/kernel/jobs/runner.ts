import { performance } from 'node:perf_hooks'
import { QUEUE_RUNTIME, type QueueName } from '@kchs/contracts'
import { SpanKind } from '@opentelemetry/api'
import { type Job, type Processor, UnrecoverableError, Worker } from 'bullmq'
import { logger } from '~/shared/logger/index.js'
import { createRedisConnection } from '~/shared/redis/index.js'
import { meter } from '~/shared/telemetry/metrics.js'
import { contextFromMetadata, withSpan } from '~/shared/telemetry/tracing.js'
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
  if (QUEUE_RUNTIME[handler.queue] !== 'worker') {
    // Очередь принадлежит движку: воркер TypeScript перехватывал бы его задания (ADR-0035)
    throw new Error(`Очередь ${handler.queue} исполняет движок, обработчик ${key} недопустим`)
  }
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

  // Длительность и исход заданий по очередям (15-admin-operations.md §4)
  const duration = meter().createHistogram('kchs.job.duration', {
    unit: 's',
    description: 'Длительность выполнения задания',
  })

  for (const [queueName, queueHandlers] of byQueue) {
    const concurrency = Math.max(...queueHandlers.map((h) => h.concurrency ?? 4))
    const run = async (job: Job, handler: JobHandler) => {
      const recordId = await ensureRecord(queueName, job)
      const log = logger().child({ queue: queueName, job: job.name, jobId: recordId })
      const started = performance.now()
      const record = (outcome: string) =>
        duration.record((performance.now() - started) / 1000, {
          queue: queueName,
          job: job.name,
          outcome,
        })

      await JobService.start(recordId)
      try {
        const result = await handler.handle(job, {
          recordId,
          progress: (value, message) => JobService.progress(recordId, value, message),
          log,
        })
        await JobService.finish(recordId, result ?? {})
        record('succeeded')
        return result
      } catch (error) {
        const final = isFinalAttempt(job, error)
        await JobService.fail(recordId, error, { final })
        record(final ? 'failed' : 'retry')
        throw error
      }
    }

    const processor: Processor = async (job) => {
      const handler = handlers.get(`${queueName}:${job.name}`)
      if (!handler) throw new UnrecoverableError(`Нет обработчика для ${queueName}:${job.name}`)
      // Задание продолжает трассу запроса, который его поставил (`JobService.schedule`)
      return withSpan(
        `job ${queueName} ${job.name}`,
        {
          kind: SpanKind.CONSUMER,
          parent: contextFromMetadata(job.opts.telemetry?.metadata),
          attributes: {
            'messaging.system': 'bullmq',
            'messaging.operation.type': 'process',
            'messaging.destination.name': queueName,
            'messaging.message.id': job.id ?? '',
            'kchs.job.name': job.name,
            'kchs.job.attempt': job.attemptsMade + 1,
          },
        },
        () => run(job, handler),
      )
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

/**
 * Запись реестра задания. Повторяемые задания по расписанию приходят без неё —
 * создаём и запоминаем в данных задания, чтобы повторы попали в ту же запись.
 */
async function ensureRecord(queueName: QueueName, job: Job): Promise<string> {
  const existing = (job.data as { jobRecordId?: string }).jobRecordId
  if (existing) return existing
  const recordId = await JobService.recordRun(queueName, job.name)
  await job.updateData({ ...(job.data as Record<string, unknown>), jobRecordId: recordId })
  return recordId
}

/** Последняя ли это попытка: после неё BullMQ задание больше не повторит. */
function isFinalAttempt(job: Job, error: unknown): boolean {
  if (error instanceof UnrecoverableError) return true
  const attempts = job.opts.attempts ?? 1
  return job.attemptsMade + 1 >= attempts
}

export async function stopWorkers(): Promise<void> {
  await Promise.allSettled(workers.map((w) => w.close()))
  workers.length = 0
  await closeQueues()
}
