import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
} from './helpers.js'

/**
 * Повторяющиеся поручения (ADR-0156): серия создаёт один экземпляр на дату правила,
 * повторный проход не дублирует, пауза и остановка работают, серия автора, который
 * больше не может создавать поручения, встаёт на паузу с причиной.
 */
registerLifecycle()

const { TaskSeriesService } = await import('../src/modules/tasks/domain/task-series.js')
const { taskSeries, tasks } = await import('../src/shared/db/schema/index.js')

let fx: TestContext
const run = Date.now().toString(36)
const today = new Date().toISOString().slice(0, 10)

beforeAll(async () => {
  fx = await setupFixture()
})

async function createSeries(as = fx.admin, title = `Еженедельный отчёт штаба ${run}`) {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/task-series',
    as,
    payload: {
      template: { kind: 'instruction', title, assigneeId: fx.users.member.id, priority: 2 },
      rule: { freq: 'daily', interval: 1, time: '09:00' },
      dueWorkingDays: 2,
      startsOn: today,
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as { id: string; nextRunAt: string; status: string }
}

describe('серия повторяющихся поручений', () => {
  it('экземпляр — один на дату правила, с отметкой серии и сроком', async () => {
    const series = await createSeries()
    expect(series.status).toBe('active')
    expect(series.nextRunAt).toBeTruthy()

    const at = new Date(new Date(series.nextRunAt).getTime() + 60_000)
    const first = await TaskSeriesService.run(at)
    expect(first.created).toBeGreaterThanOrEqual(1)
    const instances = await db()
      .select({ id: tasks.id, occurrence: tasks.occurrence, dueAt: tasks.dueAt })
      .from(tasks)
      .where(eq(tasks.seriesId, series.id))
    expect(instances).toHaveLength(1)
    expect(instances[0]?.dueAt).toBeTruthy()

    // Тот же момент ещё раз — серия уже не должна; и даже с отмотанным сроком — без дубля
    await TaskSeriesService.run(at)
    await db()
      .update(taskSeries)
      .set({ nextRunAt: series.nextRunAt })
      .where(eq(taskSeries.id, series.id))
    await TaskSeriesService.run(at)
    const again = await db()
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.seriesId, series.id))
    expect(again).toHaveLength(1)

    const record = await call(fx.app, { url: `/tasks/${instances[0]?.id}`, as: fx.users.member })
    expect(record.json()).toMatchObject({
      kind: 'instruction',
      seriesId: series.id,
      series: { id: series.id, title: `Еженедельный отчёт штаба ${run}` },
      priority: 2,
    })
    const state = await call(fx.app, { url: `/task-series/${series.id}`, as: fx.admin })
    expect(state.json()).toMatchObject({ createdCount: 1 })
    expect(new Date(state.json().nextRunAt).getTime()).toBeGreaterThan(at.getTime())
  })

  it('пауза, возобновление, остановка; остановленную не возобновить', async () => {
    const series = await createSeries(fx.admin, `Серия с паузой ${run}`)
    const paused = await call(fx.app, {
      method: 'POST',
      url: `/task-series/${series.id}/pause`,
      as: fx.admin,
    })
    expect(paused.json()).toMatchObject({ status: 'paused', nextRunAt: null })
    const resumed = await call(fx.app, {
      method: 'POST',
      url: `/task-series/${series.id}/resume`,
      as: fx.admin,
    })
    expect(resumed.json().status).toBe('active')
    const stopped = await call(fx.app, {
      method: 'POST',
      url: `/task-series/${series.id}/stop`,
      as: fx.admin,
    })
    expect(stopped.json().status).toBe('stopped')
    const back = await call(fx.app, {
      method: 'POST',
      url: `/task-series/${series.id}/resume`,
      as: fx.admin,
    })
    expect(back.statusCode).toBe(409)
    // Чужую серию посторонний не видит и не правит
    const foreign = await call(fx.app, {
      method: 'POST',
      url: `/task-series/${series.id}/pause`,
      as: fx.users.stranger,
    })
    expect([403, 404]).toContain(foreign.statusCode)
  })

  it('автор заблокирован — серия встаёт на паузу с причиной', async () => {
    const author = await createUser(fx.app, `series_${run}`)
    const series = await createSeries(author, `Серия ушедшего ${run}`)
    const blocked = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${author.id}`,
      as: fx.admin,
      payload: { status: 'blocked' },
    })
    expect(blocked.statusCode, blocked.body).toBe(200)
    await TaskSeriesService.run(new Date(new Date(series.nextRunAt).getTime() + 60_000))
    const [row] = await db()
      .select({ status: taskSeries.status, reason: taskSeries.statusReason })
      .from(taskSeries)
      .where(eq(taskSeries.id, series.id))
    expect(row?.status).toBe('paused')
    expect(row?.reason).toBeTruthy()
  })
})
