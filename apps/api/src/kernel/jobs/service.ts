import type { JobRecord, QueueName } from '@kchs/contracts'
import { type JobsOptions, Queue } from 'bullmq'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { actorId, systemCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { jobs } from '~/shared/db/schema/index.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { cacheKeys, createRedisConnection, redis } from '~/shared/redis/index.js'
import { publishEvent } from '../events/publisher.js'

const queues = new Map<QueueName, Queue>()

export function queue(name: QueueName): Queue {
  let existing = queues.get(name)
  if (!existing) {
    existing = new Queue(name, {
      connection: createRedisConnection(`queue-${name}`),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400 },
      },
    })
    queues.set(name, existing)
  }
  return existing
}

/** Параметры BullMQ, которые можно сохранить в реестре (сериализуемые). */
export type StoredJobOptions = Pick<JobsOptions, 'delay' | 'attempts' | 'priority' | 'backoff'>

export interface EnqueueInput {
  queue: QueueName
  name: string
  data: Record<string, unknown>
  objectId?: string | null
  idempotencyKey?: string | null
  options?: StoredJobOptions
}

type JobRow = typeof jobs.$inferSelect

/**
 * Реестр заданий в Postgres — для экрана «Процессы» и истории
 * (02-platform-kernel.md §9). BullMQ отвечает за доставку и повторы.
 *
 * Задание ставится в той же транзакции, что и данные, ради которых оно создано
 * (ADR-0036): запись в реестре + событие `job.queued` через outbox. В BullMQ
 * задание попадает после коммита — подписчик `kernel-jobs` вызывает `dispatch`.
 * Поэтому исполнитель никогда не увидит задание раньше его данных, а сбой между
 * коммитом и очередью не теряет задание.
 */
export const JobService = {
  async schedule(tx: Executor, ctx: Ctx, input: EnqueueInput): Promise<string> {
    if (input.idempotencyKey) {
      const [existing] = await tx
        .select({ id: jobs.id, status: jobs.status })
        .from(jobs)
        .where(eq(jobs.idempotencyKey, input.idempotencyKey))
        .limit(1)
      if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') {
        return existing.id
      }
      if (existing) {
        // Упавшее задание уступает ключ новой попытке, история остаётся в реестре
        await tx.update(jobs).set({ idempotencyKey: null }).where(eq(jobs.id, existing.id))
      }
    }

    const id = newId()
    await tx.insert(jobs).values({
      id,
      queue: input.queue,
      name: input.name,
      objectId: input.objectId ?? null,
      initiatorId: actorId(ctx),
      status: 'queued',
      idempotencyKey: input.idempotencyKey ?? null,
      payload: input.data,
      options: (input.options ?? {}) as Record<string, unknown>,
    })

    await publishEvent(tx, ctx, {
      type: 'job.queued',
      payload: { jobId: id, queue: input.queue, name: input.name },
    })
    return id
  },

  /** Постановка вне бизнес-транзакции (служебные действия администратора). */
  async enqueue(ctx: Ctx, input: EnqueueInput): Promise<string> {
    return db().transaction((tx) => JobService.schedule(tx, ctx, input))
  },

  /**
   * Передаёт задание из реестра в BullMQ. Идемпотентно: идентификатор задания
   * BullMQ совпадает с записью реестра, повторная передача не создаёт дубль.
   */
  async dispatch(id: string): Promise<boolean> {
    const [row] = await db().select().from(jobs).where(eq(jobs.id, id)).limit(1)
    if (row?.status !== 'queued') return false
    await queue(row.queue as QueueName).add(
      row.name,
      { ...row.payload, jobRecordId: row.id, initiatorId: row.initiatorId },
      { ...(row.options as StoredJobOptions), jobId: row.id },
    )
    return true
  },

  /**
   * Страховка: задания, которые остались в реестре `queued`, но не дошли до
   * BullMQ (событие в DLQ, очистка Redis), передаются повторно.
   */
  async redispatchStale(olderThanSeconds = 60): Promise<number> {
    const rows = await db()
      .select({ id: jobs.id, queue: jobs.queue })
      .from(jobs)
      .where(
        and(
          eq(jobs.status, 'queued'),
          lt(jobs.createdAt, sql`now() - make_interval(secs => ${olderThanSeconds})`),
        ),
      )
      .limit(500)
    let count = 0
    for (const row of rows) {
      const existing = await queue(row.queue as QueueName).getJob(row.id)
      if (!existing && (await JobService.dispatch(row.id))) count += 1
    }
    return count
  },

  /**
   * Запись реестра для задания, пришедшего в очередь без неё
   * (повторяемые задания по расписанию).
   */
  async recordRun(queueName: QueueName, name: string): Promise<string> {
    const id = newId()
    await db().insert(jobs).values({ id, queue: queueName, name, status: 'queued' })
    return id
  },

  async start(id: string): Promise<void> {
    await db()
      .update(jobs)
      .set({ status: 'running', startedAt: sql`now()`, attempts: sql`${jobs.attempts} + 1` })
      .where(eq(jobs.id, id))
  },

  async progress(id: string, progress: number, message?: string): Promise<void> {
    await db()
      .update(jobs)
      .set({ progress: Math.max(0, Math.min(1, progress)), message: message ?? null })
      .where(eq(jobs.id, id))
    await redis().publish(
      'rt:job',
      JSON.stringify({ jobId: id, progress, message: message ?? null }),
    )
    await redis().setex(cacheKeys.jobProgress(id), 3600, String(progress))
  },

  async finish(id: string, result: Record<string, unknown> = {}): Promise<void> {
    const row = await db().transaction(async (tx) => {
      const [updated] = await tx
        .update(jobs)
        .set({ status: 'succeeded', progress: 1, result, error: null, finishedAt: sql`now()` })
        .where(eq(jobs.id, id))
        .returning()
      if (updated) {
        await publishEvent(tx, jobCtx(updated), {
          type: 'job.finished',
          payload: { jobId: id, durationMs: durationMs(updated) },
        })
      }
      return updated
    })
    await redis().publish('rt:job', JSON.stringify({ jobId: id, status: 'succeeded' }))
    if (!row) logger().warn({ jobId: id }, 'завершено задание без записи в реестре')
  },

  /**
   * Сбой попытки. Промежуточная ошибка возвращает задание в очередь (BullMQ
   * повторит его с задержкой), окончательная — фиксирует `failed` и публикует
   * `job.failed`: инициатор получает уведомление.
   */
  async fail(id: string, error: unknown, options: { final?: boolean } = {}): Promise<void> {
    const final = options.final ?? true
    const payload = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.slice(0, 2000) : undefined,
    }
    await db().transaction(async (tx) => {
      const [updated] = await tx
        .update(jobs)
        .set(
          final
            ? { status: 'failed', error: payload, finishedAt: sql`now()` }
            : { status: 'queued', error: payload, message: payload.message.slice(0, 500) },
        )
        .where(eq(jobs.id, id))
        .returning()
      if (updated && final) {
        await publishEvent(tx, jobCtx(updated), {
          type: 'job.failed',
          payload: { jobId: id, error: payload.message.slice(0, 1000) },
        })
      }
    })
    await redis().publish(
      'rt:job',
      JSON.stringify({ jobId: id, status: final ? 'failed' : 'retrying' }),
    )
    logger().warn({ jobId: id, err: error, final }, 'задание завершилось ошибкой')
  },

  async cancel(id: string): Promise<void> {
    const [record] = await db().select().from(jobs).where(eq(jobs.id, id)).limit(1)
    if (!record) return
    const bull = await queue(record.queue as QueueName).getJob(id)
    await bull?.remove().catch(() => undefined)
    await db()
      .update(jobs)
      .set({ status: 'cancelled', finishedAt: sql`now()` })
      .where(eq(jobs.id, id))
  },

  async get(id: string): Promise<JobRecord | null> {
    const [row] = await db().select().from(jobs).where(eq(jobs.id, id)).limit(1)
    return row ? toJobRecord(row) : null
  },

  /** Данные, с которыми задание поставлено (для многошаговых операций модулей). */
  async payload(id: string): Promise<Record<string, unknown> | null> {
    const [row] = await db()
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1)
    return row ? (row.payload as Record<string, unknown>) : null
  },

  /** Задание по ключу идемпотентности: следующий шаг операции находит предыдущий. */
  async findByIdempotencyKey(key: string): Promise<JobRecord | null> {
    const [row] = await db().select().from(jobs).where(eq(jobs.idempotencyKey, key)).limit(1)
    return row ? toJobRecord(row) : null
  },

  async listForUser(userId: string, limit = 50): Promise<JobRecord[]> {
    const rows = await db()
      .select()
      .from(jobs)
      .where(eq(jobs.initiatorId, userId))
      .orderBy(desc(jobs.createdAt))
      .limit(limit)
    return rows.map(toJobRecord)
  },

  async listActive(limit = 100): Promise<JobRecord[]> {
    const rows = await db()
      .select()
      .from(jobs)
      .where(sql`${jobs.status} in ('queued','running')`)
      .orderBy(desc(jobs.createdAt))
      .limit(limit)
    return rows.map(toJobRecord)
  },

  async counts(): Promise<{ queued: number; running: number; failed: number }> {
    const rows = await db()
      .select({ status: jobs.status, count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(sql`${jobs.createdAt} > now() - interval '24 hours'`)
      .groupBy(jobs.status)
    const map = new Map(rows.map((r) => [r.status, r.count]))
    return {
      queued: map.get('queued') ?? 0,
      running: map.get('running') ?? 0,
      failed: map.get('failed') ?? 0,
    }
  },
}

/** События задания публикуются от имени инициатора: ему приходит уведомление о сбое. */
function jobCtx(row: JobRow): Ctx {
  return systemCtx(`job:${row.queue}:${row.name}`, { initiatorId: row.initiatorId })
}

function durationMs(row: JobRow): number {
  if (!row.startedAt) return 0
  return Math.max(0, Date.now() - new Date(row.startedAt).getTime())
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    queue: row.queue as QueueName,
    name: row.name,
    objectId: row.objectId,
    initiatorId: row.initiatorId,
    status: row.status as JobRecord['status'],
    progress: row.progress,
    message: row.message,
    result: row.result,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  }
}

/** Удаление завершённых записей реестра старше срока (обслуживание). */
export async function pruneFinishedJobs(olderThanDays = 30): Promise<number> {
  const deleted = await db()
    .delete(jobs)
    .where(
      and(
        sql`${jobs.status} in ('succeeded', 'failed', 'cancelled')`,
        lt(jobs.finishedAt, sql`now() - make_interval(days => ${olderThanDays})`),
      ),
    )
    .returning({ id: jobs.id })
  return deleted.length
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...queues.values()].map((q) => q.close()))
  queues.clear()
}
