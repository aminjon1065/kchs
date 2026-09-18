import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Задачи и поручения (P1-E08, ADR-0060): поручение из строки датасета проходит
 * Входящие исполнителя и автора (сценарий приёмки фазы 1 №6 без Telegram),
 * обычная задача — рабочий процесс, проект — ключи и наследование доступа,
 * системный датасет `tasks` — строки с правами смотрящего.
 */
registerLifecycle()

let fx: TestContext
let datasetId: string
let rowId: string
const run = Date.now().toString(36)
const due = new Date(Date.now() + 3 * 86_400_000).toISOString()

beforeAll(async () => {
  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Происшествия ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'district', label: { ru: 'Район' }, type: 'text' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: { rows: [{ values: { code: 'INC-1', district: 'Хатлон' } }] },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
  rowId = inserted.json().items[0]._id
})

/** Подписчики ядра и модуля задач по неопубликованным событиям outbox — как воркер. */
async function drainOutbox(): Promise<void> {
  const { listSubscribers, matchesType } = await import('../src/kernel/events/bus.js')
  if (!listSubscribers().some((subscriber) => subscriber.name === 'kernel-notifications')) {
    const { registerKernelSubscribers } = await import('../src/kernel/subscribers.js')
    registerKernelSubscribers()
  }
  if (!listSubscribers().some((subscriber) => subscriber.name === 'tasks-notifications')) {
    const { registerTasksBackground } = await import('../src/modules/tasks/module.js')
    registerTasksBackground()
  }
  const rows = await db().execute<{ id: number; event: unknown }>(
    sql`SELECT id, event FROM ops.outbox WHERE published_at IS NULL ORDER BY id LIMIT 1000`,
  )
  for (const row of rows) {
    const event = row.event as { type: string }
    for (const subscriber of listSubscribers()) {
      if (!matchesType(subscriber.types, event.type)) continue
      await subscriber.handle(event as never)
    }
    await db().execute(sql`UPDATE ops.outbox SET published_at = now() WHERE id = ${row.id}`)
  }
}

const task = (id: string, as: TestUser = fx.admin) => call(fx.app, { url: `/tasks/${id}`, as })

async function inboxOf(user: TestUser, taskId: string) {
  const response = await call(fx.app, { url: '/inbox?state=open', as: user })
  expect(response.statusCode, response.body).toBe(200)
  return (
    response.json().items as Array<{
      id: string
      kind: string
      title: string
      object: { id: string } | null
      actions: Array<{ key: string; requiresComment: boolean }>
    }>
  ).filter((item) => item.object?.id === taskId)
}

const act = (user: TestUser, itemId: string, action: string, comment?: string) =>
  call(fx.app, {
    method: 'POST',
    url: `/inbox/${itemId}/act`,
    as: user,
    payload: { action, ...(comment ? { comment } : {}) },
  })

describe('поручение из строки датасета', () => {
  it('Входящие: принять → отчитаться → вернуть → отчитаться → принять; Входящие закрыты', async () => {
    const member = fx.users.member
    const created = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: fx.admin,
      payload: {
        kind: 'instruction',
        title: `Проверить происшествие INC-1 ${run}`,
        assigneeId: member.id,
        dueAt: due,
        priority: 2,
        source: { kind: 'dataset_row', datasetId, rowId, label: 'INC-1 · Хатлон' },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string

    const card = await task(id)
    expect(card.statusCode, card.body).toBe(200)
    expect(card.json()).toMatchObject({
      kind: 'instruction',
      status: 'assigned',
      priority: 2,
      assignee: { id: member.id },
      author: { id: fx.admin.id },
      source: { kind: 'dataset_row', datasetId, rowId, label: 'INC-1 · Хатлон' },
      can: { edit: true, accept: false, cancel: true },
    })
    expect(card.json().key).toMatch(/^П-\d{2}-\d+$/)

    // Поручение видят только участники: читатель пространства и посторонний — нет
    expect((await task(id, fx.users.viewer)).statusCode).toBe(404)
    expect((await task(id, fx.users.stranger)).statusCode).toBe(404)
    const byMember = await task(id, member)
    expect(byMember.json().can).toMatchObject({ start: true, report: false, edit: false })

    // Исполнитель: «принять» во Входящих
    const [accept] = await inboxOf(member, id)
    expect(accept).toMatchObject({ kind: 'accept_instruction' })
    expect(accept?.title).toContain('Проверить происшествие')
    // Автор не может принять за исполнителя
    expect(
      (await call(fx.app, { method: 'POST', url: `/tasks/${id}/start`, as: fx.admin })).statusCode,
    ).toBe(403)
    expect((await act(member, accept!.id, 'accept')).statusCode).toBe(200)
    expect((await task(id)).json()).toMatchObject({ status: 'in_progress' })
    expect((await act(member, accept!.id, 'accept')).statusCode).toBe(409)

    // Отчёт: без текста — 400, с текстом — приёмка у автора
    const [report] = await inboxOf(member, id)
    expect(report).toMatchObject({ kind: 'report_instruction' })
    expect((await act(member, report!.id, 'report')).statusCode).toBe(400)
    expect((await act(member, report!.id, 'report', 'Выехали, проверили')).statusCode).toBe(200)
    const reported = (await task(id)).json()
    expect(reported).toMatchObject({
      status: 'reported',
      result: { text: 'Выехали, проверили', reportedBy: { id: member.id } },
      can: { accept: true, return: true },
    })
    expect(await inboxOf(member, id)).toEqual([])
    // Исполнитель не принимает свой отчёт
    expect(
      (await call(fx.app, { method: 'POST', url: `/tasks/${id}/accept`, as: member })).statusCode,
    ).toBe(403)

    // Автор возвращает на доработку с новым сроком
    const [review] = await inboxOf(fx.admin, id)
    expect(review).toMatchObject({ kind: 'accept_result' })
    expect(review?.actions.map((action) => action.key)).toEqual(['accept', 'return'])
    expect((await act(fx.admin, review!.id, 'return')).statusCode).toBe(400)
    expect((await act(fx.admin, review!.id, 'return', 'Нужен акт осмотра')).statusCode).toBe(200)
    expect((await task(id)).json()).toMatchObject({
      status: 'returned',
      returnComment: 'Нужен акт осмотра',
    })
    const [rework] = await inboxOf(member, id)
    expect(rework).toMatchObject({ kind: 'report_instruction' })

    // Повторный отчёт — из карточки, приёмка — из карточки автора
    const again = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/report`,
      as: member,
      payload: { text: 'Акт приложен' },
    })
    expect(again.statusCode, again.body).toBe(200)
    const accepted = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/accept`,
      as: fx.admin,
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json()).toMatchObject({ status: 'accepted', overdue: false })
    expect(accepted.json().completedAt).not.toBeNull()

    // Все дела по поручению во Входящих закрыты
    const open = await db().execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM inbox_items
           WHERE object_id = ${id} AND state IN ('open', 'snoozed')`,
    )
    expect(open[0]?.count).toBe(0)

    const events = await db().execute<{ type: string }>(
      sql`SELECT type FROM ops.outbox WHERE event->'object'->>'id' = ${id}
           AND type LIKE 'task.%' ORDER BY id`,
    )
    expect(events.map((row) => row.type)).toEqual(
      expect.arrayContaining([
        'task.created',
        'task.assigned',
        'task.accepted',
        'task.reported',
        'task.returned',
        'task.completed',
      ]),
    )

    // Источник — связь с датасетом, поручение видно в карточке строки
    const links = await db().execute<{ meta: Record<string, unknown> }>(
      sql`SELECT meta FROM links WHERE source_id = ${id} AND target_id = ${datasetId} AND kind = 'source'`,
    )
    expect(links[0]?.meta).toMatchObject({ rowId })
    const byRow = await call(fx.app, {
      url: `/tasks/by-row?datasetId=${datasetId}&rowId=${rowId}`,
      as: member,
    })
    expect(byRow.statusCode, byRow.body).toBe(200)
    expect(byRow.json().items.map((item: { id: string }) => item.id)).toContain(id)

    // Уведомления — «поручил вам», «отчитался», «принял», без «поделились»
    await drainOutbox()
    const notes = await db().execute<{ user_id: string; title_key: string }>(
      sql`SELECT user_id, title_key FROM notifications WHERE object_id = ${id}`,
    )
    const keys = (userId: string) =>
      notes.filter((note) => note.user_id === userId).map((note) => note.title_key)
    expect(keys(member.id)).toEqual(
      expect.arrayContaining([
        'notifications.tpl.taskAssigned',
        'notifications.tpl.taskReturned',
        'notifications.tpl.taskCompleted',
      ]),
    )
    expect(keys(member.id)).not.toContain('notifications.tpl.objectShared')
    expect(keys(fx.admin.id)).toEqual(
      expect.arrayContaining(['notifications.tpl.taskAccepted', 'notifications.tpl.taskReported']),
    )
    // Лента: шаги поручения своими словами
    const activity = await db().execute<{ summary: { key: string } }>(
      sql`SELECT summary FROM activities WHERE object_id = ${id}`,
    )
    expect(activity.map((row) => row.summary.key)).toEqual(
      expect.arrayContaining([
        'activity.task.accepted',
        'activity.task.reported',
        'activity.task.returned',
      ]),
    )
  })

  it('переназначение: новый исполнитель получает доступ и Входящие, прежний теряет', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: fx.admin,
      payload: {
        kind: 'instruction',
        title: `Переназначаемое ${run}`,
        assigneeId: fx.users.member.id,
        dueAt: due,
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string
    const moved = await call(fx.app, {
      method: 'PATCH',
      url: `/tasks/${id}`,
      as: fx.admin,
      payload: { assigneeId: fx.users.viewer.id },
    })
    expect(moved.statusCode, moved.body).toBe(200)
    expect(moved.json()).toMatchObject({ status: 'assigned', assignee: { id: fx.users.viewer.id } })
    expect((await task(id, fx.users.member)).statusCode).toBe(404)
    expect(await inboxOf(fx.users.member, id)).toEqual([])
    expect((await task(id, fx.users.viewer)).statusCode).toBe(200)
    expect((await inboxOf(fx.users.viewer, id)).map((item) => item.kind)).toEqual([
      'accept_instruction',
    ])
    // Исполнитель не правит поручение и не отменяет его
    const edit = await call(fx.app, {
      method: 'PATCH',
      url: `/tasks/${id}`,
      as: fx.users.viewer,
      payload: { title: 'Моё' },
    })
    expect(edit.statusCode).toBe(403)
    const cancel = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/cancel`,
      as: fx.admin,
      payload: { comment: 'Не требуется' },
    })
    expect(cancel.statusCode, cancel.body).toBe(200)
    expect(cancel.json().status).toBe('cancelled')
    expect(await inboxOf(fx.users.viewer, id)).toEqual([])
  })

  it('проверки: поручению нужны исполнитель и срок; источник — видимый датасет', async () => {
    const noAssignee = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: fx.admin,
      payload: { kind: 'instruction', title: 'Без исполнителя', dueAt: due },
    })
    expect(noAssignee.statusCode).toBe(400)
    const hidden = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: fx.users.stranger,
      payload: {
        title: 'Чужая строка',
        source: { kind: 'dataset_row', datasetId, rowId },
      },
    })
    expect(hidden.statusCode).toBe(404)
  })
})

describe('обычная задача и проект', () => {
  it('задача: рабочий процесс, ключ З-yy-N, личное пространство автора', async () => {
    const member = fx.users.member
    const created = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: member,
      payload: { title: `Подготовить сводку ${run}` },
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string
    const card = (await task(id, member)).json()
    expect(card).toMatchObject({ kind: 'task', status: 'todo', assignee: { id: member.id } })
    expect(card.key).toMatch(/^З-\d{2}-\d+$/)
    expect(card.can.transitions).toEqual(['in_progress', 'review', 'done', 'cancelled'])
    expect((await task(id, fx.users.viewer)).statusCode).toBe(404)

    const status = (value: string) =>
      call(fx.app, {
        method: 'POST',
        url: `/tasks/${id}/status`,
        as: member,
        payload: { status: value },
      })
    expect((await status('in_progress')).json()).toMatchObject({ status: 'in_progress' })
    expect((await status('in_progress')).statusCode).toBe(409)
    const done = await status('done')
    expect(done.json()).toMatchObject({ status: 'done' })
    expect(done.json().completedAt).not.toBeNull()
    // Действия поручения у задачи недоступны
    expect(
      (await call(fx.app, { method: 'POST', url: `/tasks/${id}/start`, as: member })).statusCode,
    ).toBe(400)
  })

  it('проект: ключ FLD-N, задачи наследуют доступ, счётчики', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/projects',
      as: fx.admin,
      payload: {
        key: `P${run
          .slice(-4)
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, 'X')}`,
        name: `Паводок ${run}`,
        spaceId: fx.spaceId,
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const projectId = created.json().id as string
    const project = (await call(fx.app, { url: `/projects/${projectId}`, as: fx.admin })).json()
    const duplicate = await call(fx.app, {
      method: 'POST',
      url: '/projects',
      as: fx.admin,
      payload: { key: project.key, name: 'Дубль', spaceId: fx.spaceId },
    })
    expect(duplicate.statusCode).toBe(409)

    const first = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: fx.admin,
      payload: {
        title: 'Мониторинг уровня воды',
        projectId,
        assigneeId: fx.users.member.id,
        dueAt: due,
      },
    })
    expect(first.statusCode, first.body).toBe(200)
    const id = first.json().id as string
    expect((await task(id)).json().key).toBe(`${project.key}-1`)
    // Читатель пространства видит задачу проекта, но не двигает её
    const seen = await task(id, fx.users.viewer)
    expect(seen.statusCode).toBe(200)
    expect(seen.json().can.transitions).toEqual([])
    const denied = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/status`,
      as: fx.users.viewer,
      payload: { status: 'in_progress' },
    })
    expect(denied.statusCode).toBe(403)
    expect((await task(id, fx.users.stranger)).statusCode).toBe(404)

    const counts = (await call(fx.app, { url: `/projects/${projectId}`, as: fx.admin })).json()
      .counts
    expect(counts).toEqual({ open: 1, overdue: 0, closed: 0 })
    const listed = await call(fx.app, {
      url: `/tasks?scope=all&projectId=${projectId}`,
      as: fx.users.viewer,
    })
    expect(listed.json().items.map((item: { id: string }) => item.id)).toEqual([id])
  })
})

describe('списки, сводка и системный датасет', () => {
  it('«мои», «поручил я», сводка', async () => {
    const mine = await call(fx.app, { url: '/tasks?scope=mine&state=all', as: fx.users.member })
    expect(mine.statusCode, mine.body).toBe(200)
    expect(
      mine
        .json()
        .items.every(
          (item: { assignee: { id: string } | null }) => item.assignee?.id === fx.users.member.id,
        ),
    ).toBe(true)
    const byMe = await call(fx.app, { url: '/tasks?scope=assigned_by_me&state=all', as: fx.admin })
    expect(byMe.json().total).toBeGreaterThanOrEqual(3)
    const summary = await call(fx.app, { url: '/tasks/summary', as: fx.users.member })
    expect(summary.statusCode, summary.body).toBe(200)
    expect(summary.json()).toMatchObject({ open: expect.any(Number), overdue: 0 })
  })

  it('системный датасет tasks: строки по правам смотрящего, служебный столбец скрыт', async () => {
    const query = (as: TestUser) =>
      call(fx.app, {
        method: 'POST',
        url: '/queries/run',
        as,
        payload: {
          spec: { version: 1, source: { kind: 'system', name: 'tasks' }, steps: [] },
        },
      })
    // Личная задача администратора — участнику её не видно
    const own = await call(fx.app, {
      method: 'POST',
      url: '/tasks',
      as: fx.admin,
      payload: { title: `Личное ${run}` },
    })
    expect(own.statusCode, own.body).toBe(200)
    const admin = await query(fx.admin)
    expect(admin.statusCode, admin.body).toBe(200)
    const names = admin.json().fields.map((field: { name: string }) => field.name)
    expect(names).toEqual(expect.arrayContaining(['key', 'title', 'status', 'assignee', 'overdue']))
    expect(names).not.toContain('viewers')
    const total = admin.json().rows.length
    expect(total).toBeGreaterThanOrEqual(4)

    const member = await query(fx.users.member)
    expect(member.statusCode, member.body).toBe(200)
    expect(member.json().rows.length).toBeGreaterThan(0)
    expect(member.json().rows.length).toBeLessThan(total)
    const stranger = await query(fx.users.stranger)
    expect(stranger.json().rows).toEqual([])
  })
})
