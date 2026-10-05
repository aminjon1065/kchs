import { type QueueName, queuesOf } from '@kchs/contracts'
import { type Job, QueueEvents } from 'bullmq'
import { and, eq, lt, or, sql } from 'drizzle-orm'
import { db } from '~/shared/db/client.js'
import { logger } from '~/shared/logger/index.js'
import { createRedisConnection } from '~/shared/redis/index.js'
import { jobs } from './schema.js'
import { bullJobIdOf, JobService, queue } from './service.js'

/**
 * Сверка реестра заданий с BullMQ (ADR-0172). Исход задания движка приходит
 * в реестр его отчётом по HTTP; если отчёт потерялся, исход всё равно есть в
 * очереди — его доводят события очереди (`QueueEvents`) и периодическая
 * сверка зависших записей. Переходы реестра идут только из незавершённых
 * состояний, поэтому оба пути и отчёт движка не задваивают события.
 */

/** Запись `running` моложе этого не сверяется: отчёт о начале мог обогнать очередь. */
const RUNNING_GRACE_SECONDS = 120
/** Запись `queued` моложе этого не трогается: задание только что поставлено. */
const QUEUED_GRACE_SECONDS = 60
/**
 * Задания нет в очереди дольше этого — исход потерян. Больше срока, сколько
 * BullMQ хранит выполненные (`removeOnComplete`, час): выполненное успели бы
 * найти раньше.
 */
const LOST_AFTER_SECONDS = 2 * 3600
const BATCH = 500

type Row = Pick<typeof jobs.$inferSelect, 'id' | 'queue' | 'status' | 'options' | 'startedAt'>
export type Settled = 'settled' | 'requeued' | 'active' | 'waiting' | 'missing' | 'closed'

/** Довести запись реестра до состояния задания в очереди. */
async function settle(row: Row, bull: Job | undefined): Promise<Settled> {
  if (!bull) return 'missing'
  const state = await bull.getState()
  switch (state) {
    case 'completed':
      await JobService.finish(row.id, asResult(bull.returnvalue))
      return 'settled'
    case 'failed':
      await JobService.fail(row.id, new Error(bull.failedReason || 'задание не выполнено'), {
        final: true,
      })
      return 'settled'
    case 'active':
      return 'active'
    case 'unknown':
      return 'missing'
    default:
      // Ждёт повтора (delayed, waiting…): запись «выполняется» возвращается в очередь
      if (row.status === 'running' && (await JobService.requeue(row.id))) return 'requeued'
      return 'waiting'
  }
}

function asResult(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return value === null || value === undefined ? {} : { value }
}

/** Исход одного задания очереди — по событию `QueueEvents`. */
export async function settleFromQueue(queueName: QueueName, bullJobId: string): Promise<Settled> {
  const bull = await queue(queueName).getJob(bullJobId)
  const recordId = (bull?.data as { jobRecordId?: unknown } | undefined)?.jobRecordId
  const id = typeof recordId === 'string' && recordId ? recordId : bullJobId
  const [row] = await db()
    .select({
      id: jobs.id,
      queue: jobs.queue,
      status: jobs.status,
      options: jobs.options,
      startedAt: jobs.startedAt,
    })
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1)
  if (!row || (row.status !== 'queued' && row.status !== 'running')) return 'closed'
  return settle(row, bull)
}

export interface ReconcileReport {
  redispatched: number
  settled: number
  requeued: number
  lost: number
}

/**
 * Периодическая страховка: запись без задания в очереди передаётся заново,
 * завершённое в очереди — закрывается в реестре, давно пропавшее из очереди —
 * помечается сбоем: инициатор узнаёт об этом, а не ждёт вечно.
 */
export async function reconcileJobs(): Promise<ReconcileReport> {
  const report: ReconcileReport = { redispatched: 0, settled: 0, requeued: 0, lost: 0 }
  const rows = await db()
    .select({
      id: jobs.id,
      queue: jobs.queue,
      status: jobs.status,
      options: jobs.options,
      startedAt: jobs.startedAt,
    })
    .from(jobs)
    .where(
      or(
        and(
          eq(jobs.status, 'queued'),
          lt(jobs.createdAt, sql`now() - make_interval(secs => ${QUEUED_GRACE_SECONDS})`),
        ),
        and(
          eq(jobs.status, 'running'),
          lt(jobs.startedAt, sql`now() - make_interval(secs => ${RUNNING_GRACE_SECONDS})`),
        ),
      ),
    )
    .orderBy(jobs.createdAt)
    .limit(BATCH)

  for (const row of rows) {
    try {
      const bull = await queue(row.queue as QueueName).getJob(bullJobIdOf(row))
      const outcome = await settle(row, bull)
      if (outcome === 'settled') report.settled += 1
      else if (outcome === 'requeued') report.requeued += 1
      else if (outcome === 'missing') {
        if (row.status === 'queued') {
          // Не дошло до очереди (событие в DLQ, очистка Redis) — передать снова
          if (await JobService.dispatch(row.id)) report.redispatched += 1
        } else if (isLost(row)) {
          await JobService.fail(
            row.id,
            new Error('Исход задания потерян: в очереди его больше нет'),
            { final: true },
          )
          report.lost += 1
        }
      }
    } catch (error) {
      logger().warn({ err: error, jobId: row.id }, 'сверка задания не удалась')
    }
  }
  if (report.settled + report.requeued + report.lost + report.redispatched > 0) {
    logger().info(report, 'реестр заданий сверен с очередью')
  }
  return report
}

function isLost(row: Row): boolean {
  if (!row.startedAt) return false
  return Date.now() - new Date(row.startedAt).getTime() > LOST_AFTER_SECONDS * 1000
}

const listeners: QueueEvents[] = []

/**
 * События очередей движка в процессе worker: исход задания закрывает запись
 * реестра сразу, даже если отчёт движка по HTTP не дошёл. Несколько реплик
 * worker слушают одни и те же события — защищает переход только из
 * незавершённых состояний.
 */
export function startEngineJobEvents(): void {
  if (listeners.length > 0) return
  for (const name of queuesOf('engine')) {
    const events = new QueueEvents(name, {
      connection: createRedisConnection(`queue-events-${name}`),
    })
    const onOutcome = ({ jobId }: { jobId: string }) => {
      settleFromQueue(name, jobId).catch((error) => {
        logger().warn({ err: error, queue: name, jobId }, 'исход задания движка не сверен')
      })
    }
    events.on('completed', onOutcome)
    events.on('failed', onOutcome)
    events.on('error', (error) => {
      logger().warn({ err: error, queue: name }, 'события очереди движка не читаются')
    })
    listeners.push(events)
  }
}

export async function stopEngineJobEvents(): Promise<void> {
  await Promise.allSettled(listeners.map((events) => events.close()))
  listeners.length = 0
}

/** Для тестов: дождаться, пока подписки на события очередей готовы. */
export async function engineJobEventsReady(): Promise<void> {
  await Promise.all(listeners.map((events) => events.waitUntilReady()))
}
