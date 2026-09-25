import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Чек-лист и подзадачи (ADR-0155): у поручения шаги ведут исполнитель, автор и
 * контролёр — посторонний участник не правит; у обычной задачи — кто правит, плюс
 * подзадачи с прогрессом родителя. У поручения подзадач нет — работу делят части
 * соисполнителей.
 */
registerLifecycle()

let fx: TestContext
const run = Date.now().toString(36)
const due = new Date(Date.now() + 5 * 86_400_000).toISOString()

beforeAll(async () => {
  fx = await setupFixture()
})

type Item = { id: string; text: string; done: boolean; doneBy: { id: string } | null }

describe('чек-лист поручения', () => {
  it('исполнитель отмечает шаги, автор добавляет, порядок и прогресс видны', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: fx.admin,
      payload: {
        kind: 'instruction',
        title: `Подготовить доклад ${run}`,
        assigneeId: fx.users.member.id,
        dueAt: due,
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string

    const first = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/checklist`,
      as: fx.admin,
      payload: { text: 'Собрать сводки районов' },
    })
    expect(first.statusCode, first.body).toBe(200)
    const second = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/checklist`,
      as: fx.users.member,
      payload: { text: 'Согласовать цифры с аналитиками', position: 0 },
    })
    expect(second.statusCode, second.body).toBe(200)
    const items = second.json().checklist as Item[]
    expect(items.map((item) => item.text)).toEqual([
      'Согласовать цифры с аналитиками',
      'Собрать сводки районов',
    ])

    const checked = await call(fx.app, {
      method: 'PATCH',
      url: `/tasks/${id}/checklist/${items[1]?.id}`,
      as: fx.users.member,
      payload: { done: true },
    })
    expect(checked.statusCode, checked.body).toBe(200)
    const after = checked.json()
    expect(after.checklistProgress).toEqual({ done: 1, total: 2 })
    expect((after.checklist as Item[])[1]?.doneBy?.id).toBe(fx.users.member.id)

    const moved = await call(fx.app, {
      method: 'PATCH',
      url: `/tasks/${id}/checklist/${items[1]?.id}`,
      as: fx.admin,
      payload: { position: 0 },
    })
    expect((moved.json().checklist as Item[])[0]?.text).toBe('Собрать сводки районов')

    // Список поручений автора показывает прогресс
    const listed = await call(fx.app, {
      url: `/tasks?scope=assigned_by_me&q=${encodeURIComponent(run)}`,
      as: fx.admin,
    })
    const row = (listed.json().items as Array<{ id: string; checklistProgress: unknown }>).find(
      (item) => item.id === id,
    )
    expect(row?.checklistProgress).toEqual({ done: 1, total: 2 })

    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/tasks/${id}/checklist/${items[0]?.id}`,
      as: fx.users.member,
    })
    expect(removed.json().checklist).toHaveLength(1)
  })

  it('чужой участник пространства чек-лист не правит; у поручения подзадач нет', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: fx.admin,
      payload: {
        kind: 'instruction',
        title: `Закрытое поручение ${run}`,
        assigneeId: fx.users.member.id,
        dueAt: due,
      },
    })
    const id = created.json().id as string
    const foreign = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/checklist`,
      as: fx.users.viewer,
      payload: { text: 'Посторонний пункт' },
    })
    expect([403, 404]).toContain(foreign.statusCode)
    const subtask = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/subtasks`,
      as: fx.admin,
      payload: { title: 'Подзадача поручения' },
    })
    expect(subtask.statusCode).toBe(403)
  })
})

describe('подзадачи обычной задачи', () => {
  it('подзадачи наследуют доступ, прогресс родителя — в карточке и списке', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: fx.users.member,
      payload: { kind: 'task', title: `Обновить план эвакуации ${run}`, spaceId: fx.spaceId },
    })
    expect(created.statusCode, created.body).toBe(200)
    const parentId = created.json().id as string

    const ids: string[] = []
    for (const title of ['Сверить списки ПВР', 'Обновить схемы маршрутов']) {
      const response = await call(fx.app, {
        method: 'POST',
        url: `/tasks/${parentId}/subtasks`,
        as: fx.users.member,
        payload: { title, dueAt: due },
      })
      expect(response.statusCode, response.body).toBe(200)
      ids.push(response.json().id as string)
    }
    const child = await call(fx.app, { url: `/tasks/${ids[0]}`, as: fx.users.member })
    expect(child.json()).toMatchObject({ kind: 'subtask', parent: { id: parentId } })
    expect(child.json().can.subtasks).toBe(false)

    const done = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${ids[0]}/status`,
      as: fx.users.member,
      payload: { status: 'done' },
    })
    expect(done.statusCode, done.body).toBe(200)

    const parent = await call(fx.app, { url: `/tasks/${parentId}`, as: fx.users.member })
    expect(parent.json().subtasks).toHaveLength(2)
    expect(parent.json().subtaskProgress).toEqual({ done: 1, total: 2 })

    const listed = await call(fx.app, {
      url: `/tasks?scope=mine&q=${encodeURIComponent(`Обновить план эвакуации ${run}`)}`,
      as: fx.users.member,
    })
    const row = (listed.json().items as Array<{ id: string; subtaskProgress: unknown }>).find(
      (item) => item.id === parentId,
    )
    expect(row?.subtaskProgress).toEqual({ done: 1, total: 2 })

    // Посторонний не видит ни задачу, ни её подзадачи
    const stranger = await call(fx.app, { url: `/tasks/${ids[1]}`, as: fx.users.stranger })
    expect(stranger.statusCode).toBe(404)
  })
})
