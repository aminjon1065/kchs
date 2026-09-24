import { and, eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'
import {
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
 * Сроки шагов в календарных часах (ADR-0131): момент срока — активация плюс N
 * часов без производственного календаря, во Входящих — тот же момент; одно
 * напоминание незадолго до срока, просрочка и эскалация по `timers` в момент
 * срока; ожидание в часах; оба способа срока сразу не публикуются.
 */
registerLifecycle()

const { matchesType } = await import('../src/kernel/events/bus.js')
const { processSubscribers } = await import('../src/kernel/process/subscribers.js')
const { fireStepTimers } = await import('../src/kernel/process/timers.js')
const schema = await import('../src/shared/db/schema/index.js')

const HOUR = 3_600_000

let fx: TestContext
let people: ProcessPeople
const run = Date.now().toString(36)

beforeAll(async () => {
  fx = await setupFixture()
  registerTestModule()
  people = await createPeople(fx, run)
})

/** Подписчики движка по неопубликованным событиям outbox — как воркер. */
async function drain(): Promise<void> {
  const subscribers = processSubscribers()
  for (let round = 0; round < 5; round++) {
    const rows = await db().execute<{ id: number; event: { type: string } }>(
      sql`SELECT id, event FROM ops.outbox WHERE published_at IS NULL ORDER BY id LIMIT 1000`,
    )
    if (rows.length === 0) return
    for (const row of rows) {
      for (const subscriber of subscribers) {
        if (!matchesType(subscriber.types, row.event.type)) continue
        await subscriber.handle(row.event as never)
      }
      await db().execute(sql`UPDATE ops.outbox SET published_at = now() WHERE id = ${row.id}`)
    }
  }
}

async function titlesOf(userId: string, objectId: string): Promise<string[]> {
  const rows = await db()
    .select({ titleKey: schema.notifications.titleKey })
    .from(schema.notifications)
    .where(
      and(eq(schema.notifications.userId, userId), eq(schema.notifications.objectId, objectId)),
    )
  return rows.map((row) => row.titleKey)
}

/** Строка шага в базе: момент активации, срок, таймеры. */
async function stepRow(instanceId: string, key: string) {
  const [row] = await db()
    .select({
      id: schema.processSteps.id,
      status: schema.processSteps.status,
      outcome: schema.processSteps.outcome,
      startedAt: schema.processSteps.startedAt,
      dueAt: schema.processSteps.dueAt,
      timers: schema.processSteps.timers,
      nextTimerAt: schema.processSteps.nextTimerAt,
    })
    .from(schema.processSteps)
    .where(
      and(eq(schema.processSteps.instanceId, instanceId), eq(schema.processSteps.stepKey, key)),
    )
  if (!row) throw new Error(`нет шага ${key}`)
  return row as typeof row & { timers: Record<string, { at: string; firedAt?: string | null }> }
}

/** Экстренный маршрут: согласование со сроком в часах и эскалация автору по просрочке. */
function urgentRoute(key: string, dueHours: number) {
  return {
    version: 1,
    key,
    objectType: TEST_TYPE(),
    name: { ru: 'Экстренное донесение' },
    start: 'review',
    steps: {
      review: {
        type: 'approval',
        assignees: [`user:${people.a1.id}`],
        dueHours,
        next: 'end',
      },
      end: { type: 'end' },
    },
    timers: [{ step: '*', onOverdue: [{ action: 'notify', to: 'author' }] }],
  }
}

describe('срок шага в часах', () => {
  it('срок — активация плюс N часов; во Входящих тот же момент; напоминание за час; просрочка с эскалацией', async () => {
    const key = `urgent_${run}`
    await publishDefinition(fx, urgentRoute(key, 3))
    const doc = await createDocument(fx, people.author, `Донесение ${run}`)
    const instanceId = await startProcess(fx, people.author, { objectId: doc, definitionKey: key })
    await drain()

    const step = await stepRow(instanceId, 'review')
    const activated = Date.parse(step.startedAt as string)
    const due = Date.parse(step.dueAt as string)
    expect(due - activated).toBe(3 * HOUR)
    // Часовой срок — одно напоминание за час, без утренних напоминаний дневного срока
    expect(Object.keys(step.timers).sort()).toEqual(['overdue', 'remindSoon'])
    expect(Date.parse(step.timers.remindSoon?.at ?? '')).toBe(due - HOUR)
    expect(Date.parse(step.timers.overdue?.at ?? '')).toBe(due)
    expect(Date.parse(step.nextTimerAt as string)).toBe(due - HOUR)

    // Входящие и маршрут показывают момент срока со временем, а не конец дня
    const [item] = await inboxOf(fx, people.a1, doc)
    expect(Date.parse(item?.dueAt ?? '')).toBe(due)
    const view = await route(fx, people.author, instanceId)
    const review = view.steps.find((entry: { key: string }) => entry.key === 'review')
    expect(Date.parse(review.dueAt)).toBe(due)

    // До момента напоминания ничего не срабатывает
    expect(await fireStepTimers(step.id, new Date(due - 2 * HOUR))).toBe(0)
    // Незадолго до срока — «скоро срок» согласующему
    expect(await fireStepTimers(step.id, new Date(due - 30 * 60_000))).toBe(1)
    await drain()
    const soon = await db().execute<{ when: string }>(
      sql`SELECT event->'payload'->>'when' AS when FROM ops.outbox
           WHERE type = 'process.step_due_soon' AND event->'payload'->>'stepId' = ${step.id}`,
    )
    expect(soon.map((row) => row.when)).toEqual(['soon'])
    expect(await titlesOf(people.a1.id, doc)).toContain('notifications.tpl.processDueHours')

    // Срок прошёл: просрочка согласующему, эскалация автору по timers определения
    expect(await fireStepTimers(step.id, new Date(due + 60_000))).toBe(1)
    await drain()
    expect(await titlesOf(people.a1.id, doc)).toContain('notifications.tpl.processOverdue')
    expect(await titlesOf(people.author.id, doc)).toContain('notifications.tpl.processEscalation')
    const overdue = await db().execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM ops.outbox
           WHERE type = 'process.step_overdue' AND event->'payload'->>'stepId' = ${step.id}`,
    )
    expect(Number(overdue[0]?.count)).toBe(1)
    // Повтор ничего не дублирует
    expect(await fireStepTimers(step.id, new Date(due + 2 * 60_000))).toBe(0)
  })

  it('срок короче двух часов — напоминание посередине', async () => {
    const key = `urgent_short_${run}`
    await publishDefinition(fx, urgentRoute(key, 1))
    const doc = await createDocument(fx, people.author, `Короткий срок ${run}`)
    const instanceId = await startProcess(fx, people.author, { objectId: doc, definitionKey: key })
    const step = await stepRow(instanceId, 'review')
    const activated = Date.parse(step.startedAt as string)
    expect(Date.parse(step.dueAt as string) - activated).toBe(HOUR)
    expect(Date.parse(step.timers.remindSoon?.at ?? '') - activated).toBe(HOUR / 2)
  })

  it('ожидание в часах: срок ожидания — активация плюс N часов, по нему шаг завершается', async () => {
    const key = `hold_${run}`
    await publishDefinition(fx, {
      version: 1,
      key,
      objectType: TEST_TYPE(),
      name: { ru: 'Пауза в часах' },
      start: 'hold',
      steps: {
        hold: { type: 'wait', durationHours: 2, next: 'end' },
        end: { type: 'end' },
      },
    })
    const doc = await createDocument(fx, people.author, `Пауза ${run}`)
    const instanceId = await startProcess(fx, people.author, { objectId: doc, definitionKey: key })
    const hold = await stepRow(instanceId, 'hold')
    const at = Date.parse(hold.timers.wait?.at ?? '')
    expect(at - Date.parse(hold.startedAt as string)).toBe(2 * HOUR)

    expect(await fireStepTimers(hold.id, new Date(at + 60_000))).toBe(1)
    const done = await stepRow(instanceId, 'hold')
    expect(done).toMatchObject({ status: 'completed', outcome: 'timeout' })
    expect((await route(fx, people.author, instanceId)).status).toBe('finished')
  })

  it('дни и часы сразу — публикация отклоняется; предпросмотр считает срок в часах', async () => {
    const key = `conflict_${run}`
    const definition = urgentRoute(key, 2)
    ;(definition.steps.review as Record<string, unknown>).dueWorkingDays = 1
    const created = await call(fx.app, {
      method: 'POST',
      url: '/process-definitions',
      as: fx.admin,
      payload: { definition },
    })
    expect(created.statusCode, created.body).toBe(200)
    const published = await call(fx.app, {
      method: 'POST',
      url: `/process-definitions/${key}/publish`,
      as: fx.admin,
    })
    expect(published.statusCode).toBe(400)
    expect(published.body).toContain('due_conflict')

    const doc = await createDocument(fx, people.author, `Предпросмотр ${run}`)
    const before = Date.now()
    const preview = await call(fx.app, {
      method: 'POST',
      url: '/process-definitions/preview',
      as: fx.admin,
      payload: { definition: urgentRoute(`preview_${run}`, 5), objectId: doc },
    })
    expect(preview.statusCode, preview.body).toBe(200)
    const review = preview.json().steps.find((entry: { key: string }) => entry.key === 'review')
    const due = Date.parse(review.dueAt)
    expect(due - before).toBeGreaterThanOrEqual(5 * HOUR)
    expect(due - Date.now()).toBeLessThanOrEqual(5 * HOUR)
  })
})
