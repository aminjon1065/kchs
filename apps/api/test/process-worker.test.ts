import { and, eq, isNull, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Subscriber } from '../src/kernel/events/types.js'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'
import {
  actInbox,
  activeStep,
  createDocument,
  createPeople,
  inboxOf,
  type ProcessPeople,
  publishDefinition,
  registerTestModule,
  route,
  startProcess,
  TEST_TYPE,
} from './process-fixtures.js'

/**
 * Сценарий приёмки фазы 3 №6 (ADR-0079): worker перезапущен посреди маршрута —
 * процесс продолжается. Настоящие диспетчер outbox, подписчики и обработчики
 * очереди `process-timers`; «падение» — их остановка, пока api принимает
 * решения, а срок шага истекает; задание таймера потеряно вместе с очередью —
 * просрочку находит обход таймеров по состоянию в базе.
 */
registerLifecycle()

const bus = await import('../src/kernel/events/index.js')
const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
const { registerProcessJobs, fireStepTimers, SWEEP_JOB } = await import(
  '../src/kernel/process/timers.js'
)
const { JobService, queue } = await import('../src/kernel/jobs/service.js')
const { startWorkers, stopWorkers } = await import('../src/kernel/jobs/runner.js')
const { systemCtx } = await import('../src/shared/context.js')
const schema = await import('../src/shared/db/schema/index.js')

let fx: TestContext
let people: ProcessPeople
let previousSubscribers: Subscriber[] = []
const run = Date.now().toString(36)

function startWorker(): void {
  startWorkers()
  bus.startConsumers({ blockMs: 100, retryIdleMs: 300, claimIntervalMs: 100 })
  bus.startDispatcher()
}

async function stopWorker(): Promise<void> {
  bus.stopDispatcher()
  await bus.stopConsumers()
  await stopWorkers()
  // Цикл диспетчера завершается после текущей паузы
  await new Promise((resolve) => setTimeout(resolve, 500))
}

beforeAll(async () => {
  fx = await setupFixture()
  registerTestModule()
  people = await createPeople(fx, run)
  previousSubscribers = [...bus.listSubscribers()]
  bus.clearSubscribers()
  registerKernelSubscribers()
  registerProcessJobs()
  startWorker()
})

afterAll(async () => {
  await stopWorker()
  bus.clearSubscribers()
  for (const subscriber of previousSubscribers) bus.registerSubscriber(subscriber)
})

async function until<T>(
  check: () => Promise<T | null | undefined | false>,
  what: string,
): Promise<T> {
  const started = Date.now()
  while (Date.now() - started < 30_000) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`не дождались: ${what}`)
}

async function notified(userId: string, objectId: string, titleKey: string): Promise<boolean> {
  const rows = await db()
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.userId, userId),
        eq(schema.notifications.objectId, objectId),
        eq(schema.notifications.titleKey, titleKey),
      ),
    )
  return rows.length > 0
}

/** Уведомление без содержания: объекта в нём нет (получатель объект не видит). */
async function notifiedHidden(userId: string, titleKey: string): Promise<boolean> {
  const rows = await db()
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.userId, userId),
        isNull(schema.notifications.objectId),
        eq(schema.notifications.titleKey, titleKey),
      ),
    )
  return rows.length > 0
}

describe('перезапуск worker посреди маршрута', () => {
  it('решения, принятые без worker, и истёкший срок доходят после перезапуска; маршрут завершается', async () => {
    const key = `worker_${run}`
    await publishDefinition(fx, {
      version: 1,
      key,
      objectType: TEST_TYPE(),
      name: { ru: 'Маршрут с перезапуском' },
      variables: {
        first: { type: 'user', label: { ru: 'Первый' }, required: true },
        second: { type: 'users', label: { ru: 'Второй круг' }, required: true },
      },
      start: 'review1',
      steps: {
        review1: { type: 'approval', assignees: ['var:first'], dueWorkingDays: 1, next: 'review2' },
        review2: {
          type: 'approval',
          mode: 'parallel',
          assignees: ['var:second'],
          dueWorkingDays: 1,
          next: 'end',
        },
        end: { type: 'end' },
      },
      timers: [
        {
          step: '*',
          onOverdue: [
            { action: 'notify', to: 'manager(step.assignee)' },
            { action: 'notify', to: 'author' },
          ],
        },
      ],
    })
    const doc = await createDocument(fx, people.author, `Перезапуск ${run}`)
    const instanceId = await startProcess(fx, people.author, {
      objectId: doc,
      definitionKey: key,
      variables: { first: people.a1.id, second: [people.a2.id, people.a3.id] },
    })

    // Worker работает: уведомление о назначении приходит через шину
    await until(
      () => notified(people.a1.id, doc, 'notifications.tpl.processApprove'),
      'уведомление первому согласующему',
    )
    const [first] = await inboxOf(fx, people.a1, doc)
    expect((await actInbox(fx, people.a1, first?.id ?? '', 'approve')).statusCode).toBe(200)
    const step = activeStep(await route(fx, people.author, instanceId), 'review2')
    const [timer] = await db()
      .select({ id: schema.jobs.id, status: schema.jobs.status })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.name, 'process.timer'),
          sql`${schema.jobs.payload}->>'stepId' = ${step.id}`,
        ),
      )
    expect(timer?.status).toBe('queued')
    await until(
      async () => (await queue('process-timers').getJob(timer?.id ?? '')) ?? null,
      'задание таймера в очереди',
    )

    // ── Worker упал ────────────────────────────────────────────────────────
    await stopWorker()

    // api продолжает принимать решения: a2 согласует, события копятся в outbox
    const [second] = await inboxOf(fx, people.a2, doc)
    expect((await actInbox(fx, people.a2, second?.id ?? '', 'approve')).statusCode).toBe(200)
    // Срок шага истёк, а задание таймера потеряно вместе с очередью
    const past = new Date(Date.now() - 10 * 60_000).toISOString()
    await db()
      .update(schema.processSteps)
      .set({
        timers: {
          remindBefore: { at: past },
          remindDue: { at: past },
          overdue: { at: past },
        },
        nextTimerAt: past,
        dueAt: past,
      })
      .where(eq(schema.processSteps.id, step.id))
    await (await queue('process-timers').getJob(timer?.id ?? ''))?.remove()
    const pending = await db().execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM ops.outbox WHERE published_at IS NULL`,
    )
    expect(Number(pending[0]?.count)).toBeGreaterThan(0)

    // ── Worker снова запущен ───────────────────────────────────────────────
    startWorker()
    // Обход таймеров по расписанию (как задание cron) находит просрочку в базе
    await JobService.enqueue(systemCtx('test'), {
      queue: 'process-timers',
      name: SWEEP_JOB,
      data: {},
    })
    // Получатели эскалации уведомляются по очереди — ждём обоих. Руководитель
    // не ответившего объект не видит: ему — без названия и ссылки (ADR-0083)
    await until(
      async () =>
        (await notifiedHidden(people.boss.id, 'notifications.tpl.processEscalationHidden')) &&
        (await notified(people.author.id, doc, 'notifications.tpl.processEscalation')),
      'эскалация руководителю не ответившего и автору',
    )
    expect(await notified(people.boss.id, doc, 'notifications.tpl.processEscalation')).toBe(false)
    expect(await notified(people.a3.id, doc, 'notifications.tpl.processOverdue')).toBe(true)
    expect(await notified(people.a3.id, doc, 'notifications.tpl.processDueSoon')).toBe(true)
    // Ответивший до просрочки о ней не уведомлён
    expect(await notified(people.a2.id, doc, 'notifications.tpl.processOverdue')).toBe(false)

    // События, накопленные без worker, обработаны: лента содержит решение a2
    await until(async () => {
      const rows = await db()
        .select({ id: schema.activities.id })
        .from(schema.activities)
        .where(
          and(
            eq(schema.activities.objectId, doc),
            eq(schema.activities.actorId, people.a2.id),
            sql`${schema.activities.summary}->>'key' = 'activity.process.decided.approve'`,
          ),
        )
      return rows.length > 0
    }, 'лента: решение, принятое без worker')

    // Повтор срабатывания ничего не дублирует
    expect(await fireStepTimers(step.id)).toBe(0)
    const overdue = await db().execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM ops.outbox
           WHERE type = 'process.step_overdue' AND event->'payload'->>'stepId' = ${step.id}`,
    )
    expect(Number(overdue[0]?.count)).toBe(1)
    const view = await route(fx, people.author, instanceId)
    expect(activeStep(view, 'review2').overdue).toBe(true)

    // Маршрут продолжается и завершается
    const [third] = await inboxOf(fx, people.a3, doc)
    expect((await actInbox(fx, people.a3, third?.id ?? '', 'approve')).statusCode).toBe(200)
    expect((await route(fx, people.author, instanceId)).status).toBe('finished')
    await until(
      () => notified(people.author.id, doc, 'notifications.tpl.processFinished'),
      'уведомление о завершении маршрута',
    )
    // Всё опубликовано
    await until(async () => {
      const rows = await db().execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM ops.outbox WHERE published_at IS NULL`,
      )
      return Number(rows[0]?.count) === 0
    }, 'outbox опубликован')
  })

  it('таймер срабатывает заданием очереди: ожидание по сроку продолжает маршрут', async () => {
    const key = `wait_${run}`
    await publishDefinition(fx, {
      version: 1,
      key,
      objectType: TEST_TYPE(),
      name: { ru: 'Ожидание срока' },
      start: 'pause',
      steps: {
        pause: { type: 'wait', until: '2026-01-01T00:00:00Z', next: 'ack' },
        ack: { type: 'acknowledge', assignees: ['author'], next: 'end' },
        end: { type: 'end' },
      },
    })
    const doc = await createDocument(fx, people.author, `Ожидание ${run}`)
    const instanceId = await startProcess(fx, people.author, { objectId: doc, definitionKey: key })
    // Срок в прошлом: задание таймера без задержки завершает ожидание
    await until(async () => {
      const view = await route(fx, people.author, instanceId)
      return view.steps.some(
        (item: { key: string; status: string }) => item.key === 'ack' && item.status === 'active',
      )
    }, 'ожидание завершено таймером')
    const view = await route(fx, people.author, instanceId)
    expect(view.steps.find((item: { key: string }) => item.key === 'pause').outcome).toBe('timeout')
    const ack = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/steps/${activeStep(view, 'ack').id}/act`,
      as: people.author,
      payload: { action: 'acknowledge' },
    })
    expect(ack.statusCode, ack.body).toBe(200)
    expect((await route(fx, people.author, instanceId)).status).toBe('finished')
  })
})
