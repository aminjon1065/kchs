import { Worker } from 'bullmq'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Subscriber } from '../src/kernel/events/types.js'
import {
  call,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Надёжность заданий (ADR-0172): исход задания движка доходит до реестра и без
 * его отчёта, отмена прерывает выполняющееся задание и не перезаписывается
 * поздним отчётом, у TS-задания есть предел времени, системное задание видит
 * только тот, кому виден его объект. «Движок» здесь — настоящий воркер BullMQ
 * очереди движка, который отчётов в api не шлёт.
 */
registerLifecycle()

const bus = await import('../src/kernel/events/index.js')
const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
const { JobService, queue } = await import('../src/kernel/jobs/service.js')
const { registerJobHandler, startWorkers, stopWorkers } = await import(
  '../src/kernel/jobs/runner.js'
)
const { engineJobEventsReady, reconcileJobs, startEngineJobEvents, stopEngineJobEvents } =
  await import('../src/kernel/jobs/reconcile.js')
const { canJoin } = await import('../src/kernel/realtime/gateway.js')
const { buildUserCtx } = await import('../src/kernel/context-builder.js')
const { systemCtx } = await import('../src/shared/context.js')
const { createRedisConnection } = await import('../src/shared/redis/index.js')

let fx: TestContext
let previousSubscribers: Subscriber[] = []
let engine: Worker | null = null
const run = Date.now().toString(36)
const slow = { started: false, aborted: false }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error('условие не выполнено вовремя')
    await sleep(100)
  }
}

async function waitForStatus(id: string, statuses: string[], timeoutMs = 20_000) {
  await waitUntil(
    async () => statuses.includes((await JobService.get(id))?.status ?? ''),
    timeoutMs,
  )
  const job = await JobService.get(id)
  if (!job) throw new Error(`нет задания ${id}`)
  return job
}

async function outboxTypes(jobId: string): Promise<string[]> {
  const rows = await db().execute<{ type: string }>(
    sql`SELECT type FROM ops.outbox WHERE event->'payload'->>'jobId' = ${jobId} ORDER BY id`,
  )
  return rows.map((row) => row.type)
}

async function userCtx(user: TestUser) {
  return buildUserCtx(
    { sessionId: `test-${user.id}`, userId: user.id, onBehalfOf: null, mfaEnrolled: true },
    { id: 'test', ip: null, headers: {} } as never,
  )
}

beforeAll(async () => {
  fx = await setupFixture()
  previousSubscribers = [...bus.listSubscribers()]
  bus.clearSubscribers()
  registerKernelSubscribers()

  registerJobHandler({
    queue: 'maintenance',
    name: `test.quick.${run}`,
    handle: async () => ({ ok: true }),
  })
  registerJobHandler({
    queue: 'maintenance',
    name: `test.slow.${run}`,
    handle: async (_job, helpers) => {
      slow.started = true
      try {
        for (let i = 0; i < 300; i++) {
          await sleep(50)
          helpers.signal.throwIfAborted()
        }
      } catch (error) {
        slow.aborted = true
        throw error
      }
      return { finished: true }
    },
  })
  registerJobHandler({
    queue: 'maintenance',
    name: `test.hang.${run}`,
    timeoutMs: 300,
    // Обработчик сигнал не проверяет: вызов наружу завис
    handle: () => new Promise(() => undefined),
  })

  startWorkers()
  bus.startConsumers({ blockMs: 100, retryIdleMs: 300, claimIntervalMs: 100 })
  bus.startDispatcher()

  // «Движок»: исполняет задания очереди движка, отчётов в api не шлёт
  engine = new Worker(
    'transform',
    async (job) => {
      if (job.name === `test.engine.broken.${run}`) throw new Error('движок упал')
      return { done: (job.data as { value?: number }).value ?? null }
    },
    { connection: createRedisConnection('test-engine') },
  )
  await engineJobEventsReady()
})

afterAll(async () => {
  await engine?.close()
  bus.stopDispatcher()
  await bus.stopConsumers()
  await stopWorkers()
  bus.clearSubscribers()
  for (const subscriber of previousSubscribers) bus.registerSubscriber(subscriber)
})

describe('исход задания движка', () => {
  it('без отчёта движка доходит до реестра из событий очереди', async () => {
    const ctx = systemCtx('test', { initiatorId: fx.admin.id })
    const ok = await JobService.enqueue(ctx, {
      queue: 'transform',
      name: `test.engine.ok.${run}`,
      data: { value: 5 },
    })
    const job = await waitForStatus(ok, ['succeeded'])
    expect(job.result).toEqual({ done: 5 })
    await waitUntil(async () => (await outboxTypes(ok)).includes('job.finished'))

    const broken = await JobService.enqueue(ctx, {
      queue: 'transform',
      name: `test.engine.broken.${run}`,
      data: {},
      options: { attempts: 1 },
    })
    const failed = await waitForStatus(broken, ['failed'])
    expect((failed.error as { message?: string } | null)?.message).toContain('движок упал')
    // Подписчики `job.failed` (уведомление инициатору, модули) узнают о сбое
    await waitUntil(async () => (await outboxTypes(broken)).includes('job.failed'))
  })

  it('сверка закрывает задание, исход которого события пропустили, и потерянное', async () => {
    await stopEngineJobEvents()
    try {
      const id = await JobService.enqueue(systemCtx('test'), {
        queue: 'transform',
        name: `test.engine.ok.${run}`,
        data: { value: 9 },
      })
      await waitUntil(
        async () => (await (await queue('transform').getJob(id))?.getState()) === 'completed',
      )
      expect((await JobService.get(id))?.status).toBe('queued')
      await db().execute(
        sql`UPDATE jobs SET created_at = now() - interval '5 minutes' WHERE id = ${id}`,
      )

      // «Выполняется» третий час, а в очереди задания нет — исход потерян
      const lost = await JobService.recordRun('maintenance', `test.lost.${run}`)
      await db().execute(
        sql`UPDATE jobs SET status = 'running', started_at = now() - interval '3 hours',
                           created_at = now() - interval '3 hours'
             WHERE id = ${lost}`,
      )

      const report = await reconcileJobs()
      expect(report.settled).toBeGreaterThanOrEqual(1)
      expect(report.lost).toBeGreaterThanOrEqual(1)
      const settled = await JobService.get(id)
      expect(settled?.status).toBe('succeeded')
      expect(settled?.result).toEqual({ done: 9 })
      const missing = await JobService.get(lost)
      expect(missing?.status).toBe('failed')
      expect((missing?.error as { message?: string } | null)?.message).toContain('потерян')
    } finally {
      startEngineJobEvents()
      await engineJobEventsReady()
    }
  })
})

describe('отмена', () => {
  it('выполняющееся задание прерывается и не становится выполненным', async () => {
    const id = await JobService.enqueue(systemCtx('test', { initiatorId: fx.admin.id }), {
      queue: 'maintenance',
      name: `test.slow.${run}`,
      data: {},
    })
    await waitForStatus(id, ['running'])
    await waitUntil(() => slow.started)

    expect(await JobService.cancel(systemCtx('test'), id)).toBe('cancelled')
    await waitUntil(() => slow.aborted, 10_000)
    // Очередь закрыла задание без повторов, запись осталась отменённой
    await waitUntil(
      async () => (await (await queue('maintenance').getJob(id))?.getState()) === 'completed',
    )
    const job = await JobService.get(id)
    expect(job?.status).toBe('cancelled')
    expect(job?.result).toBeNull()
    expect(await outboxTypes(id)).toContain('job.cancelled')
    expect(await outboxTypes(id)).not.toContain('job.finished')
  })

  it('поздний отчёт не перезаписывает отмену и не публикует событий', async () => {
    const id = await JobService.recordRun('maintenance', `test.none.${run}`)
    expect(await JobService.cancel(systemCtx('test'), id)).toBe('cancelled')
    await JobService.start(id)
    await JobService.progress(id, 0.5, 'поздно')
    await JobService.finish(id, { late: true })
    await JobService.fail(id, new Error('поздний сбой'), { final: true })
    const job = await JobService.get(id)
    expect(job?.status).toBe('cancelled')
    expect(job?.result).toBeNull()
    expect(job?.progress).toBe(0)
    expect(await outboxTypes(id)).toEqual(['job.cancelled'])
  })

  it('завершённое задание не отменяется: 409', async () => {
    const id = await JobService.enqueue(systemCtx('test', { initiatorId: fx.admin.id }), {
      queue: 'maintenance',
      name: `test.quick.${run}`,
      data: {},
    })
    await waitForStatus(id, ['succeeded'])
    const response = await call(fx.app, { method: 'POST', url: `/jobs/${id}/cancel`, as: fx.admin })
    expect(response.statusCode).toBe(409)
    expect((await JobService.get(id))?.status).toBe('succeeded')
  })
})

describe('предел времени', () => {
  it('зависшее задание закрывается сбоем с причиной, слот освобождается', async () => {
    const id = await JobService.enqueue(systemCtx('test', { initiatorId: fx.admin.id }), {
      queue: 'maintenance',
      name: `test.hang.${run}`,
      data: {},
      options: { attempts: 1 },
    })
    const job = await waitForStatus(id, ['failed'])
    expect((job.error as { message?: string } | null)?.message).toContain(
      'Превышено время выполнения',
    )
    await waitUntil(async () => (await outboxTypes(id)).includes('job.failed'))

    const next = await JobService.enqueue(systemCtx('test'), {
      queue: 'maintenance',
      name: `test.quick.${run}`,
      data: {},
    })
    await waitForStatus(next, ['succeeded'])
  })
})

describe('видимость заданий', () => {
  it('системное задание видит тот, кому виден его объект, и администратор', async () => {
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: `Папка задания ${run}`, spaceId: fx.spaceId },
    })
    expect(folder.statusCode, folder.body).toBe(200)
    const objectId = folder.json().id as string

    const system = await db().transaction((tx) =>
      JobService.schedule(tx, systemCtx('test'), {
        queue: 'maintenance',
        name: `test.quick.${run}`,
        data: {},
        objectId,
      }),
    )
    const orphan = await JobService.enqueue(systemCtx('test'), {
      queue: 'maintenance',
      name: `test.quick.${run}`,
      data: {},
    })
    await waitForStatus(system, ['succeeded'])
    await waitForStatus(orphan, ['succeeded'])

    const read = (id: string, as: TestUser) => call(fx.app, { url: `/jobs/${id}`, as })
    expect((await read(system, fx.users.stranger)).statusCode).toBe(404)
    expect((await read(system, fx.users.member)).statusCode).toBe(200)
    expect((await read(system, fx.admin)).statusCode).toBe(200)
    expect((await read(orphan, fx.users.member)).statusCode).toBe(404)
    expect((await read(orphan, fx.admin)).statusCode).toBe(200)

    // Видеть — не значит отменять: отменяет инициатор или администратор
    const cancel = await call(fx.app, {
      method: 'POST',
      url: `/jobs/${system}/cancel`,
      as: fx.users.member,
    })
    expect(cancel.statusCode).toBe(403)
    const hidden = await call(fx.app, {
      method: 'POST',
      url: `/jobs/${orphan}/cancel`,
      as: fx.users.stranger,
    })
    expect(hidden.statusCode).toBe(404)

    // Комната задания — по тому же правилу
    expect(await canJoin(await userCtx(fx.users.member), `job:${system}`)).toBe(true)
    expect(await canJoin(await userCtx(fx.users.stranger), `job:${system}`)).toBe(false)
    expect(await canJoin(await userCtx(fx.users.member), `job:${orphan}`)).toBe(false)
  })
})
