import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Массовые действия над задачами (ADR-0155): права — по каждой задаче, отказ по одной не
 * мешает остальным, итог — сделано и пропущено с причинами; перенос в проект — только
 * обычных задач.
 */
registerLifecycle()

let fx: TestContext
const run = Date.now().toString(36)
const due = new Date(Date.now() + 5 * 86_400_000).toISOString()

beforeAll(async () => {
  fx = await setupFixture()
})

async function create(payload: Record<string, unknown>): Promise<string> {
  const response = await call(fx.app, { method: 'POST', url: '/tasks', as: fx.admin, payload })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

const bulk = (ids: string[], action: Record<string, unknown>, as = fx.admin) =>
  call(fx.app, { method: 'POST', url: '/tasks/bulk', as, payload: { ids, action } })

describe('массовые действия', () => {
  it('срок и исполнитель — по каждой задаче; закрыть можно только готовое', async () => {
    const first = await create({
      kind: 'instruction',
      title: `Массовое 1 ${run}`,
      assigneeId: fx.users.member.id,
      dueAt: due,
    })
    const second = await create({
      kind: 'instruction',
      title: `Массовое 2 ${run}`,
      assigneeId: fx.users.member.id,
      dueAt: due,
    })
    const task = await create({
      kind: 'task',
      title: `Массовая задача ${run}`,
      spaceId: fx.spaceId,
    })

    const dated = await bulk([first, second, task], { kind: 'due', dueWorkingDays: 7 })
    expect(dated.statusCode, dated.body).toBe(200)
    expect(dated.json()).toEqual({ done: 3, skipped: [] })

    const moved = await bulk([first, task], { kind: 'reassign', assigneeId: fx.users.viewer.id })
    expect(moved.json().done).toBe(2)
    const record = await call(fx.app, { url: `/tasks/${first}`, as: fx.admin })
    expect(record.json().assignee.id).toBe(fx.users.viewer.id)

    // Поручение без отчёта принять нельзя — пропуск с причиной; задача закрывается
    const closed = await bulk([second, task], { kind: 'close' })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json().done).toBe(1)
    expect(closed.json().skipped).toHaveLength(1)
    expect(closed.json().skipped[0]).toMatchObject({ id: second })
    expect(closed.json().skipped[0].reason).toBeTruthy()
  })

  it('посторонний ничего не меняет; перенос в проект — только обычных задач', async () => {
    const instruction = await create({
      kind: 'instruction',
      title: `Не переносится ${run}`,
      assigneeId: fx.users.member.id,
      dueAt: due,
    })
    const task = await create({ kind: 'task', title: `Переносимая ${run}`, spaceId: fx.spaceId })

    const foreign = await bulk([instruction, task], { kind: 'cancel' }, fx.users.stranger)
    expect(foreign.json()).toMatchObject({ done: 0 })
    expect(foreign.json().skipped).toHaveLength(2)

    const project = await call(fx.app, {
      method: 'POST',
      url: '/projects',
      as: fx.admin,
      payload: {
        key: `B${run.slice(-4).toUpperCase()}`,
        name: `Проект ${run}`,
        spaceId: fx.spaceId,
      },
    })
    expect(project.statusCode, project.body).toBe(200)
    const projectId = project.json().id as string
    const moved = await bulk([instruction, task], { kind: 'project', projectId })
    expect(moved.json().done).toBe(1)
    expect(moved.json().skipped[0]).toMatchObject({ id: instruction })
    const record = await call(fx.app, { url: `/tasks/${task}`, as: fx.admin })
    expect(record.json().project?.id).toBe(projectId)
    const back = await bulk([task], { kind: 'project', projectId: null })
    expect(back.json().done).toBe(1)
    expect((await call(fx.app, { url: `/tasks/${task}`, as: fx.admin })).json().project).toBeNull()
  })

  it('плановое начало задачи сохраняется — левый край полосы таймлайна', async () => {
    const task = await create({
      kind: 'task',
      title: `Таймлайн ${run}`,
      spaceId: fx.spaceId,
      dueAt: due,
    })
    const startAt = new Date(Date.now() + 86_400_000).toISOString()
    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/tasks/${task}`,
      as: fx.admin,
      payload: { startAt },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(new Date(patched.json().startAt).getTime()).toBe(new Date(startAt).getTime())
  })
})
