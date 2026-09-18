import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Subscriber } from '../src/kernel/events/types.js'
import { db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Задания (P0-E07 S03, ADR-0035/0036): постановка в транзакции, передача в BullMQ
 * после коммита, исполнение настоящим воркером, повторы и окончательный сбой.
 */
registerLifecycle()

const bus = await import('../src/kernel/events/index.js')
const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
const { JobService, queue } = await import('../src/kernel/jobs/service.js')
const { registerJobHandler, startWorkers, stopWorkers } = await import(
  '../src/kernel/jobs/runner.js'
)
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
let previousSubscribers: Subscriber[] = []
const run = Date.now().toString(36)
const calls = { ok: 0, flaky: 0, broken: 0 }

beforeAll(async () => {
  fx = await setupFixture()
  previousSubscribers = [...bus.listSubscribers()]
  bus.clearSubscribers()
  registerKernelSubscribers()

  registerJobHandler({
    queue: 'maintenance',
    name: `test.ok.${run}`,
    handle: async (job) => {
      calls.ok += 1
      return { echo: (job.data as { value?: number }).value ?? null }
    },
  })
  registerJobHandler({
    queue: 'maintenance',
    name: `test.flaky.${run}`,
    handle: async () => {
      calls.flaky += 1
      if (calls.flaky === 1) throw new Error('временный сбой')
      return { ok: true }
    },
  })
  registerJobHandler({
    queue: 'maintenance',
    name: `test.broken.${run}`,
    handle: async () => {
      calls.broken += 1
      throw new Error('задание всегда падает')
    },
  })

  startWorkers()
  bus.startConsumers({ blockMs: 100, retryIdleMs: 300, claimIntervalMs: 100 })
  bus.startDispatcher()
})

afterEach(async () => {
  // события публикуются фоновым диспетчером; ничего не чистим между тестами
})

afterAll(async () => {
  bus.stopDispatcher()
  await bus.stopConsumers()
  await stopWorkers()
  bus.clearSubscribers()
  for (const subscriber of previousSubscribers) bus.registerSubscriber(subscriber)
})

async function waitForStatus(id: string, statuses: string[], timeoutMs = 20_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const job = await JobService.get(id)
    if (job && statuses.includes(job.status)) return job
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const job = await JobService.get(id)
  throw new Error(`задание ${id} не перешло в ${statuses.join('|')}: ${job?.status}`)
}

describe('задания', () => {
  it('задание из откатившейся транзакции не существует и не исполняется', async () => {
    let jobId = ''
    await expect(
      db().transaction(async (tx) => {
        jobId = await JobService.schedule(tx, systemCtx('test'), {
          queue: 'maintenance',
          name: `test.ok.${run}`,
          data: { value: 1 },
        })
        throw new Error('откат')
      }),
    ).rejects.toThrow('откат')

    expect(jobId).not.toBe('')
    expect(await JobService.get(jobId)).toBeNull()
    const events = await db().execute(
      sql`SELECT 1 FROM ops.outbox WHERE type = 'job.queued' AND event->'payload'->>'jobId' = ${jobId}`,
    )
    expect(events.length).toBe(0)
  })

  it('задание уходит в BullMQ после коммита и исполняется воркером', async () => {
    const id = await JobService.enqueue(systemCtx('test', { initiatorId: fx.admin.id }), {
      queue: 'maintenance',
      name: `test.ok.${run}`,
      data: { value: 42 },
    })
    const job = await waitForStatus(id, ['succeeded'])
    expect(job.result).toEqual({ echo: 42 })
    expect(job.attempts).toBe(1)
  })

  it('временный сбой повторяется BullMQ и не считается окончательным', async () => {
    const id = await JobService.enqueue(systemCtx('test'), {
      queue: 'maintenance',
      name: `test.flaky.${run}`,
      data: {},
      options: { attempts: 3, backoff: { type: 'fixed', delay: 100 } },
    })
    const job = await waitForStatus(id, ['succeeded'])
    expect(job.attempts).toBe(2)
    expect(calls.flaky).toBe(2)
  })

  it('окончательный сбой фиксируется и уведомляет инициатора', async () => {
    const id = await JobService.enqueue(systemCtx('test', { initiatorId: fx.admin.id }), {
      queue: 'maintenance',
      name: `test.broken.${run}`,
      data: {},
      options: { attempts: 2, backoff: { type: 'fixed', delay: 100 } },
    })
    const job = await waitForStatus(id, ['failed'])
    expect(job.attempts).toBe(2)
    expect((job.error as { message?: string } | null)?.message).toContain('всегда падает')

    const started = Date.now()
    let notified = false
    while (!notified && Date.now() - started < 10_000) {
      const rows = await db().execute(
        sql`SELECT 1 FROM notifications
             WHERE user_id = ${fx.admin.id} AND category = 'system'
               AND created_at > now() - interval '1 minute'`,
      )
      notified = rows.length > 0
      if (!notified) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(notified).toBe(true)
  })

  it('задание по расписанию без записи реестра получает запись и выполняется', async () => {
    const bull = await queue('maintenance').add(`test.ok.${run}`, { value: 7 })
    const started = Date.now()
    let recordId: string | undefined
    while (!recordId && Date.now() - started < 10_000) {
      const fresh = await queue('maintenance').getJob(bull.id ?? '')
      recordId = (fresh?.data as { jobRecordId?: string } | undefined)?.jobRecordId
      if (!recordId) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(recordId).toBeDefined()
    const job = await waitForStatus(recordId ?? '', ['succeeded'])
    expect(job.result).toEqual({ echo: 7 })
  })

  it('обработчик в очереди движка регистрировать нельзя', () => {
    expect(() =>
      registerJobHandler({ queue: 'imports', name: 'test.misplaced', handle: async () => ({}) }),
    ).toThrow('исполняет движок')
  })
})
