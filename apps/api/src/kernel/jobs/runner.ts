import { performance } from 'node:perf_hooks'
import { QUEUE_RUNTIME, type QueueName } from '@kchs/contracts'
import { SpanKind } from '@opentelemetry/api'
import { type Job, type Processor, UnrecoverableError, Worker } from 'bullmq'
import { logger } from '~/shared/logger/index.js'
import { createRedisConnection } from '~/shared/redis/index.js'
import { meter } from '~/shared/telemetry/metrics.js'
import { contextFromMetadata, withSpan } from '~/shared/telemetry/tracing.js'
import { isCancelRequested, JobCancelledError, watchCancellation } from './cancellation.js'
import { startEngineJobEvents, stopEngineJobEvents } from './reconcile.js'
import { closeQueues, JobService } from './service.js'

export interface JobHandler {
  queue: QueueName
  name: string
  concurrency?: number
  /** Свой предел времени, мс, если работа заведомо дольше предела очереди. */
  timeoutMs?: number
  handle: (job: Job, helpers: JobHelpers) => Promise<Record<string, unknown> | undefined>
}

export interface JobHelpers {
  recordId: string
  progress: (value: number, message?: string) => Promise<void>
  log: ReturnType<typeof logger>
  /**
   * Отмена или истёкший предел времени. Долгий обработчик проверяет сигнал в
   * естественных точках (между пачками, перед фиксацией результата); не
   * проверивший — воркер всё равно освобождает слот и закрывает запись.
   */
  signal: AbortSignal
}

const MINUTE = 60_000

/**
 * Предел времени TS-задания по очередям (ADR-0172): зависший вызов наружу не
 * держит слот воркера вечно. Очереди движка здесь не участвуют — их задания
 * исполняет движок.
 */
export const QUEUE_TIMEOUT_MS: Partial<Record<QueueName, number>> = {
  // Загрузка и сравнение импорта, пакеты строк, пайплайны и источники
  data: 120 * MINUTE,
  exports: 120 * MINUTE,
  index: 60 * MINUTE,
  maintenance: 60 * MINUTE,
  automation: 15 * MINUTE,
  notify: 10 * MINUTE,
  'process-timers': 5 * MINUTE,
}
const DEFAULT_TIMEOUT_MS = 30 * MINUTE

/** Задание не уложилось в предел времени. */
export class JobTimeoutError extends Error {
  constructor(readonly limitMs: number) {
    super(`Превышено время выполнения задания: ${formatLimit(limitMs)}`)
    this.name = 'JobTimeoutError'
  }
}

function formatLimit(ms: number): string {
  return ms >= MINUTE ? `${Math.round(ms / MINUTE)} мин` : `${Math.max(1, Math.round(ms / 1000))} с`
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

      // Отменённое или уже завершённое задание не исполняется повторно
      if (!(await JobService.start(recordId))) {
        log.info('задание закрыто до начала — пропускаем')
        return { skipped: true }
      }

      const controller = new AbortController()
      const limitMs = handler.timeoutMs ?? QUEUE_TIMEOUT_MS[queueName] ?? DEFAULT_TIMEOUT_MS
      const timer = setTimeout(() => controller.abort(new JobTimeoutError(limitMs)), limitMs)
      const unwatch = watchCancellation(recordId, controller)
      try {
        // Отмена могла прийти между постановкой и подпиской на сигнал
        if (await isCancelRequested(recordId)) controller.abort(new JobCancelledError())
        const result = await untilAborted(
          handler.handle(job, {
            recordId,
            progress: (value, message) => JobService.progress(recordId, value, message),
            log,
            signal: controller.signal,
          }),
          controller.signal,
        )
        await JobService.finish(recordId, result ?? {})
        record('succeeded')
        return result
      } catch (error) {
        const reason = controller.signal.aborted ? controller.signal.reason : null
        if (reason instanceof JobCancelledError) {
          // Запись уже `cancelled`; очередь считает задание завершённым — без повторов
          log.info('задание отменено')
          record('cancelled')
          return { cancelled: true }
        }
        const failure = reason instanceof JobTimeoutError ? reason : error
        const final = isFinalAttempt(job, failure)
        await JobService.fail(recordId, failure, { final })
        record(final ? 'failed' : 'retry')
        throw failure
      } finally {
        clearTimeout(timer)
        unwatch()
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

  // Исход заданий движка доходит до реестра и без его отчёта (ADR-0172)
  startEngineJobEvents()

  logger().info(
    { queues: [...byQueue.keys()], handlers: handlers.size },
    'обработчики заданий запущены',
  )
}

/**
 * Ждать обработчик, пока сигнал не прерван. Прерванный обработчик, который
 * сигнал не проверил, дорабатывает в фоне, но слот воркера и запись реестра
 * освобождаются сразу; его поздняя ошибка не всплывает необработанной.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => undefined)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Запись реестра задания. Повторяемые задания по расписанию приходят без неё —
 * создаём и запоминаем в данных задания, чтобы повторы попали в ту же запись.
 */
async function ensureRecord(queueName: QueueName, job: Job): Promise<string> {
  const existing = (job.data as { jobRecordId?: string }).jobRecordId
  if (existing) return existing
  const recordId = await JobService.recordRun(queueName, job.name, job.id)
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
  await stopEngineJobEvents()
  await closeQueues()
}
