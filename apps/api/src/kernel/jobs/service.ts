import type { JobRecord, QueueName } from '@kchs/contracts'
import { type JobsOptions, Queue } from 'bullmq'
import { desc, eq, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { actorId } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { jobs } from '~/shared/db/schema/index.js'
import { newId } from '~/shared/ids.js'
import { logger } from '~/shared/logger/index.js'
import { cacheKeys, createRedisConnection, redis } from '~/shared/redis/index.js'

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

export interface EnqueueInput {
  queue: QueueName
  name: string
  data: Record<string, unknown>
  objectId?: string | null
  idempotencyKey?: string | null
  options?: JobsOptions
}

/**
 * Реестр заданий в Postgres — для экрана «Процессы» и истории
 * (02-platform-kernel.md §9). BullMQ отвечает за доставку и повторы.
 */
export const JobService = {
  async enqueue(ctx: Ctx, input: EnqueueInput): Promise<string> {
    if (input.idempotencyKey) {
      const [existing] = await db()
        .select({ id: jobs.id, status: jobs.status })
        .from(jobs)
        .where(eq(jobs.idempotencyKey, input.idempotencyKey))
        .limit(1)
      if (existing && existing.status !== 'failed') return existing.id
    }

    const id = newId()
    await db()
      .insert(jobs)
      .values({
        id,
        queue: input.queue,
        name: input.name,
        objectId: input.objectId ?? null,
        initiatorId: actorId(ctx),
        status: 'queued',
        idempotencyKey: input.idempotencyKey ?? null,
      })

    await queue(input.queue).add(
      input.name,
      { ...input.data, jobRecordId: id, initiatorId: actorId(ctx) },
      { jobId: id, ...input.options },
    )
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
    await db()
      .update(jobs)
      .set({ status: 'succeeded', progress: 1, result, finishedAt: sql`now()` })
      .where(eq(jobs.id, id))
    await redis().publish('rt:job', JSON.stringify({ jobId: id, status: 'succeeded' }))
  },

  async fail(id: string, error: unknown): Promise<void> {
    const payload = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.slice(0, 2000) : undefined,
    }
    await db()
      .update(jobs)
      .set({ status: 'failed', error: payload, finishedAt: sql`now()` })
      .where(eq(jobs.id, id))
    await redis().publish('rt:job', JSON.stringify({ jobId: id, status: 'failed' }))
    logger().warn({ jobId: id, err: error }, 'задание завершилось ошибкой')
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

function toJobRecord(row: typeof jobs.$inferSelect): JobRecord {
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

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...queues.values()].map((q) => q.close()))
  queues.clear()
}
