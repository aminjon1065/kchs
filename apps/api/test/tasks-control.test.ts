import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Поручения в полном режиме и контроль исполнения (P3-E03, ADR-0082): сроки в
 * рабочих днях с праздником, продление, переназначение, части соисполнителей,
 * руководитель видит поручения подчинённых (и не видит чужие), напоминания и
 * эскалация без дублей после перезапуска, закрытие источника, экран «Контроль»,
 * нагрузка и «Мой день», замещение исполнителя.
 */
registerLifecycle()

const { OrgService } = await import('../src/modules/identity/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const { BusinessCalendar } = await import('../src/kernel/business-calendar/service.js')
const { endOfLocalDay, localDate } = await import('../src/kernel/business-calendar/working-days.js')
const { TaskReminders } = await import('../src/modules/tasks/domain/task-reminders.js')
const { stageMoments } = await import('../src/modules/tasks/domain/task-deadlines.js')
const { Instructions } = await import('../src/modules/tasks/public.js')
const { ensureControlMetrics } = await import('../src/modules/tasks/domain/control-metrics.js')
const { redis } = await import('../src/shared/redis/index.js')

const TZ = 'Asia/Dushanbe'
const run = Date.now().toString(36)

let fx: TestContext
/** Автор поручений — обычный сотрудник, чтобы права проверялись без роли администратора. */
let boss: TestUser
/** Глава управления CTRL и глава отдела CTRL-DIV внутри него. */
let head: TestUser
let divHead: TestUser
/** Сотрудники отдела CTRL-DIV. */
let worker: TestUser
let coWorker: TestUser
/** Сотрудник другого подразделения — не подчинённый. */
let outsider: TestUser
let deputy: TestUser
let unitCtrl: string
let unitDiv: string
let unitOther: string

beforeAll(async () => {
  fx = await setupFixture()
  const ctx = systemCtx('test')
  const unit = (code: string, parentId: string | null) =>
    db().transaction((tx) =>
      OrgService.createUnit(tx, ctx, {
        code: `${code}-${run}`,
        name: { ru: `Подразделение ${code}` },
        kind: 'department',
        parentId,
        sort: 0,
        isActive: true,
        createSpace: false,
      }),
    )
  unitCtrl = await unit('CTRL', null)
  unitDiv = await unit('DIV', unitCtrl)
  unitOther = await unit('OTHER', null)
  boss = await createUser(fx.app, `boss_${run}`, ['employee'])
  head = await createUser(fx.app, `head_${run}`, ['employee'], unitCtrl)
  divHead = await createUser(fx.app, `divhead_${run}`, ['employee'], unitDiv)
  worker = await createUser(fx.app, `worker_${run}`, ['employee'], unitDiv)
  coWorker = await createUser(fx.app, `coworker_${run}`, ['employee'], unitDiv)
  outsider = await createUser(fx.app, `outsider_${run}`, ['employee'], unitOther)
  deputy = await createUser(fx.app, `deputy_${run}`, ['employee'], unitOther)
  await db().transaction(async (tx) => {
    await OrgService.updateUnit(tx, ctx, unitCtrl, { headUserId: head.id })
    await OrgService.updateUnit(tx, ctx, unitDiv, { headUserId: divHead.id })
  })
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
  for (let round = 0; round < 5; round++) {
    const rows = await db().execute<{ id: number; event: unknown }>(
      sql`SELECT id, event FROM ops.outbox WHERE published_at IS NULL ORDER BY id LIMIT 1000`,
    )
    if (rows.length === 0) return
    for (const row of rows) {
      const event = row.event as { type: string }
      for (const subscriber of listSubscribers()) {
        if (!matchesType(subscriber.types, event.type)) continue
        await subscriber.handle(event as never)
      }
      await db().execute(sql`UPDATE ops.outbox SET published_at = now() WHERE id = ${row.id}`)
    }
  }
}

const task = (id: string, as: TestUser) => call(fx.app, { url: `/tasks/${id}`, as })

async function createInstruction(as: TestUser, payload: Record<string, unknown>): Promise<string> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/tasks',
    as,
    payload: { kind: 'instruction', title: `Поручение ${run}`, ...payload },
  })
  expect(created.statusCode, created.body).toBe(200)
  return created.json().id as string
}

async function inboxOf(user: TestUser, taskId: string, headers: Record<string, string> = {}) {
  const response = await call(fx.app, { url: '/inbox?state=open', as: user, headers })
  expect(response.statusCode, response.body).toBe(200)
  return (
    response.json().items as Array<{
      id: string
      kind: string
      dueAt: string | null
      onBehalfOf: { id: string } | null
      object: { id: string } | null
      payload: Record<string, unknown>
      actions: Array<{ key: string; requiresComment: boolean; input?: string }>
    }>
  ).filter((item) => item.object?.id === taskId)
}

const act = (
  user: TestUser,
  itemId: string,
  action: string,
  extra: { comment?: string; payload?: Record<string, unknown> } = {},
) =>
  call(fx.app, {
    method: 'POST',
    url: `/inbox/${itemId}/act`,
    as: user,
    payload: { action, ...extra },
  })

async function outboxEvents(taskId: string, type: string) {
  return db().execute<{ event: { payload: Record<string, unknown> } }>(
    sql`SELECT event FROM ops.outbox WHERE type = ${type}
         AND event->'object'->>'id' = ${taskId} ORDER BY id`,
  )
}

const inWorkingDays = (days: number) =>
  call(fx.app, { url: `/business-calendar/deadline?workingDays=${days}`, as: fx.admin })

describe('сроки в рабочих днях', () => {
  it('«N рабочих дней» пропускает праздник производственного календаря; история сроков', async () => {
    // Первый рабочий день после сегодняшнего становится праздником — срок сдвигается на день
    const today = localDate(new Date(), TZ)
    const holiday = await BusinessCalendar.addWorkingDays(today, 1)
    const before = (await inWorkingDays(3)).json().date as string
    const set = await call(fx.app, {
      method: 'PUT',
      url: `/admin/business-calendar/${holiday}`,
      as: fx.admin,
      payload: { kind: 'holiday', note: { ru: `Проверка ${run}` } },
    })
    expect(set.statusCode, set.body).toBe(200)
    try {
      const expected = (await inWorkingDays(3)).json()
      expect(expected.date).toBe(await BusinessCalendar.addWorkingDays(before, 1))

      const id = await createInstruction(boss, { assigneeId: worker.id, dueWorkingDays: 3 })
      const card = (await task(id, boss)).json()
      expect(card).toMatchObject({
        dueAt: expected.dueAt,
        dueWorkingDays: 3,
        originalDueAt: expected.dueAt,
        extensions: 0,
      })
      expect(card.dueHistory).toEqual([
        expect.objectContaining({
          reason: 'set',
          from: null,
          to: expected.dueAt,
          workingDays: 3,
          actor: expect.objectContaining({ id: boss.id }),
        }),
      ])
      // Срок и дату, и рабочими днями сразу — ошибка поля
      const both = await call(fx.app, {
        method: 'POST',
        url: '/tasks',
        as: boss,
        payload: {
          kind: 'instruction',
          title: 'Два срока',
          assigneeId: worker.id,
          dueAt: expected.dueAt,
          dueWorkingDays: 2,
        },
      })
      expect(both.statusCode).toBe(400)
    } finally {
      await call(fx.app, {
        method: 'DELETE',
        url: `/admin/business-calendar/${holiday}`,
        as: fx.admin,
      })
    }
  })

  it('автор меняет срок с основанием — запись истории; исполнитель срок не меняет', async () => {
    const id = await createInstruction(boss, { assigneeId: worker.id, dueWorkingDays: 5 })
    const next = endOfLocalDay(
      await BusinessCalendar.addWorkingDays(localDate(new Date(), TZ), 8),
      TZ,
    )
    const edited = await call(fx.app, {
      method: 'PATCH',
      url: `/tasks/${id}`,
      as: boss,
      payload: { dueAt: next.toISOString(), dueComment: 'Уточнены вводные' },
    })
    expect(edited.statusCode, edited.body).toBe(200)
    expect(edited.json().dueHistory.map((row: { reason: string }) => row.reason)).toEqual([
      'set',
      'edit',
    ])
    expect(edited.json().dueHistory[1]).toMatchObject({ comment: 'Уточнены вводные' })
    const denied = await call(fx.app, {
      method: 'PATCH',
      url: `/tasks/${id}`,
      as: worker,
      payload: { dueWorkingDays: 30 },
    })
    expect(denied.statusCode).toBe(403)
  })
})

describe('продление срока', () => {
  it('запрос исполнителя → Входящие автора → согласовано; второй запрос — отказ с причиной', async () => {
    const id = await createInstruction(boss, { assigneeId: worker.id, dueWorkingDays: 2 })
    const original = (await task(id, boss)).json().dueAt as string
    // Исполнитель принимает к исполнению — время принятия фиксируется
    const [acceptItem] = await inboxOf(worker, id)
    expect(acceptItem?.actions.map((action) => action.key)).toEqual(['accept', 'extend'])
    expect((await act(worker, acceptItem!.id, 'accept')).statusCode).toBe(200)
    expect((await task(id, worker)).json().startedAt).not.toBeNull()

    // Запрос продления: желаемый срок — рабочими днями, обоснование обязательно
    const noReason = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/extension`,
      as: worker,
      payload: { dueWorkingDays: 6 },
    })
    expect(noReason.statusCode).toBe(400)
    const earlier = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/extension`,
      as: worker,
      payload: { dueWorkingDays: 0, reason: 'Раньше' },
    })
    expect(earlier.statusCode).toBe(400)
    const requested = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/extension`,
      as: worker,
      payload: { dueWorkingDays: 6, reason: 'Ждём данные районов' },
    })
    expect(requested.statusCode, requested.body).toBe(200)
    expect(requested.json()).toMatchObject({
      extension: { status: 'pending', reason: 'Ждём данные районов' },
      can: { requestExtension: false },
    })
    const wanted = requested.json().extension.requestedDueAt as string
    // Второй запрос, пока первый ждёт решения, — конфликт
    const twice = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/extension`,
      as: worker,
      payload: { dueWorkingDays: 7, reason: 'Ещё' },
    })
    expect(twice.statusCode).toBe(409)
    // Посторонний не видит поручение, исполнитель не решает за автора
    expect(
      (
        await call(fx.app, {
          method: 'POST',
          url: `/tasks/${id}/extension/decide`,
          as: outsider,
          payload: { decision: 'approve' },
        })
      ).statusCode,
    ).toBe(404)
    expect(
      (
        await call(fx.app, {
          method: 'POST',
          url: `/tasks/${id}/extension/decide`,
          as: worker,
          payload: { decision: 'approve' },
        })
      ).statusCode,
    ).toBe(403)

    // Автору — дело «продление»: согласовать из Входящих
    const [review] = await inboxOf(boss, id)
    expect(review).toMatchObject({ kind: 'extend_due' })
    expect(review?.payload).toMatchObject({ requestedDueAt: wanted, reason: 'Ждём данные районов' })
    expect(review?.actions.map((action) => action.key)).toEqual(['approve', 'reject'])
    expect((await act(boss, review!.id, 'approve')).statusCode).toBe(200)
    const approved = (await task(id, boss)).json()
    expect(approved).toMatchObject({
      dueAt: wanted,
      originalDueAt: original,
      extensions: 1,
      extension: { status: 'approved', approvedDueAt: wanted, decidedBy: { id: boss.id } },
    })
    expect(approved.dueHistory.at(-1)).toMatchObject({
      reason: 'extension',
      from: original,
      to: wanted,
      comment: 'Ждём данные районов',
    })
    // Дело исполнителя «отчитаться» — с новым сроком
    const [report] = await inboxOf(worker, id)
    expect(report).toMatchObject({ kind: 'report_instruction', dueAt: wanted })

    // Второй запрос — из Входящих исполнителя с датой; автор отказывает с причиной
    const date = await BusinessCalendar.addWorkingDays(localDate(new Date(wanted), TZ), 3)
    expect(
      (
        await act(worker, report!.id, 'extend', {
          comment: 'Нужна неделя',
          payload: { dueDate: date },
        })
      ).statusCode,
    ).toBe(200)
    const noComment = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/extension/decide`,
      as: boss,
      payload: { decision: 'reject' },
    })
    expect(noComment.statusCode).toBe(400)
    const rejected = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/extension/decide`,
      as: boss,
      payload: { decision: 'reject', comment: 'Срок не переносится' },
    })
    expect(rejected.statusCode, rejected.body).toBe(200)
    expect(rejected.json()).toMatchObject({
      dueAt: wanted,
      extensions: 1,
      extension: { status: 'rejected', decisionComment: 'Срок не переносится' },
    })
    expect(await inboxOf(boss, id)).toEqual([])

    // События и аудит
    expect(await outboxEvents(id, 'task.extension_requested')).toHaveLength(2)
    const decided = await outboxEvents(id, 'task.extension_decided')
    expect(decided.map((row) => row.event.payload.decision)).toEqual(['approved', 'rejected'])
    const audit = await db().execute<{ action: string }>(
      sql`SELECT action FROM audit_log WHERE object_id = ${id} ORDER BY id`,
    )
    expect(audit.map((row) => row.action)).toEqual([
      'task.extension_requested',
      'task.extension_decided',
      'task.extension_requested',
      'task.extension_decided',
    ])
  })
})

describe('переназначение и замещение', () => {
  it('контролёр переназначает: новый исполнитель заново принимает, прежний теряет доступ', async () => {
    const id = await createInstruction(boss, {
      assigneeId: worker.id,
      controllerId: divHead.id,
      dueWorkingDays: 4,
    })
    const [item] = await inboxOf(worker, id)
    await act(worker, item!.id, 'accept')
    // Исполнитель не переназначает сам себя
    const self = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/reassign`,
      as: worker,
      payload: { assigneeId: coWorker.id },
    })
    expect(self.statusCode).toBe(403)
    const moved = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/reassign`,
      as: divHead,
      payload: { assigneeId: coWorker.id, comment: 'Иванов в командировке' },
    })
    expect(moved.statusCode, moved.body).toBe(200)
    expect(moved.json()).toMatchObject({
      status: 'assigned',
      startedAt: null,
      assignee: { id: coWorker.id },
    })
    expect((await task(id, worker)).statusCode).toBe(404)
    expect(await inboxOf(worker, id)).toEqual([])
    expect((await inboxOf(coWorker, id)).map((row) => row.kind)).toEqual(['accept_instruction'])
    const [assigned] = (await outboxEvents(id, 'task.assigned')).slice(-1)
    expect(assigned?.event.payload).toMatchObject({
      assigneeId: coWorker.id,
      previousAssigneeId: worker.id,
      comment: 'Иванов в командировке',
    })
    const audit = await db().execute<{ action: string }>(
      sql`SELECT action FROM audit_log WHERE object_id = ${id} AND action = 'task.reassigned'`,
    )
    expect(audit).toHaveLength(1)
  })

  it('заместитель исполнителя принимает поручение от его имени — копией дела и заголовком', async () => {
    const now = Date.now()
    const delegated = await call(fx.app, {
      method: 'POST',
      url: '/me/delegations',
      as: worker,
      payload: {
        toUserId: deputy.id,
        scope: 'instructions',
        startsAt: new Date(now - 60_000).toISOString(),
        endsAt: new Date(now + 7 * 86_400_000).toISOString(),
      },
    })
    expect(delegated.statusCode, delegated.body).toBe(200)
    await redis().del(`kchs:principals:${deputy.id}`)
    const id = await createInstruction(boss, { assigneeId: worker.id, dueWorkingDays: 3 })
    // Без режима «от имени» заместитель поручение не видит
    expect((await task(id, deputy)).statusCode).toBe(404)
    const onBehalf = { 'x-kchs-on-behalf-of': worker.id }
    const seen = await call(fx.app, { url: `/tasks/${id}`, as: deputy, headers: onBehalf })
    expect(seen.statusCode, seen.body).toBe(200)
    expect(seen.json().can).toMatchObject({ start: true, requestExtension: true })
    // Копия дела во Входящих заместителя — действие от имени исполнителя
    const [copy] = await inboxOf(deputy, id)
    expect(copy).toMatchObject({ kind: 'accept_instruction', onBehalfOf: { id: worker.id } })
    expect((await act(deputy, copy!.id, 'accept')).statusCode).toBe(200)
    const started = (await task(id, boss)).json()
    expect(started.status).toBe('in_progress')
    const [event] = await outboxEvents(id, 'task.accepted')
    const envelope = await db().execute<{ actor: { userId: string; onBehalfOf: string } }>(
      sql`SELECT event->'actor' AS actor FROM ops.outbox WHERE type = 'task.accepted'
           AND event->'object'->>'id' = ${id}`,
    )
    expect(event).toBeTruthy()
    expect(envelope[0]?.actor).toMatchObject({ userId: deputy.id, onBehalfOf: worker.id })
  })
})

describe('соисполнители: части «в части касающейся»', () => {
  it('части у соисполнителей, контроль — у ответственного; закрытие основного — по правилам', async () => {
    const id = await createInstruction(boss, {
      assigneeId: worker.id,
      coAssigneeIds: [coWorker.id, outsider.id],
      dueWorkingDays: 5,
    })
    const card = (await task(id, boss)).json()
    expect(card.parts).toHaveLength(2)
    expect(card.parts.map((part: { assignee: { id: string } }) => part.assignee.id).sort()).toEqual(
      [coWorker.id, outsider.id].sort(),
    )
    const partOf = (userId: string) =>
      (card.parts as Array<{ id: string; assignee: { id: string } }>).find(
        (part) => part.assignee.id === userId,
      )!.id
    const coPart = partOf(coWorker.id)
    const outsiderPart = partOf(outsider.id)
    // Часть: тот же срок, контролёр — ответственный исполнитель, основное — родитель
    const part = (await task(coPart, coWorker)).json()
    expect(part).toMatchObject({
      dueAt: card.dueAt,
      controller: { id: worker.id },
      author: { id: boss.id },
      parent: { id, key: card.key },
    })
    // Соисполнитель видит свою часть во «Входящих», а в «Моих» — только её
    expect((await inboxOf(coWorker, coPart)).map((row) => row.kind)).toEqual(['accept_instruction'])
    const mine = await call(fx.app, { url: '/tasks?scope=mine&state=all', as: coWorker })
    const mineIds = mine.json().items.map((row: { id: string }) => row.id)
    expect(mineIds).toContain(coPart)
    expect(mineIds).not.toContain(id)

    // Ответственный не отчитывается, пока части открыты
    const [accept] = await inboxOf(worker, id)
    await act(worker, accept!.id, 'accept')
    const early = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/report`,
      as: worker,
      payload: { text: 'Готово' },
    })
    expect(early.statusCode).toBe(409)
    expect(early.json().data).toMatchObject({ openParts: 2 })

    // Соисполнитель отчитывается — приёмка у ответственного, не у автора
    await call(fx.app, { method: 'POST', url: `/tasks/${coPart}/start`, as: coWorker })
    await call(fx.app, {
      method: 'POST',
      url: `/tasks/${coPart}/report`,
      as: coWorker,
      payload: { text: 'Моя часть готова' },
    })
    expect((await inboxOf(worker, coPart)).map((row) => row.kind)).toEqual(['accept_result'])
    expect(await inboxOf(boss, coPart)).toEqual([])
    expect(
      (await call(fx.app, { method: 'POST', url: `/tasks/${coPart}/accept`, as: worker }))
        .statusCode,
    ).toBe(200)

    // Автор исключает второго соисполнителя — его часть отменяется
    const trimmed = await call(fx.app, {
      method: 'PATCH',
      url: `/tasks/${id}`,
      as: boss,
      payload: { coAssigneeIds: [coWorker.id] },
    })
    expect(trimmed.statusCode, trimmed.body).toBe(200)
    expect((await task(outsiderPart, boss)).json().status).toBe('cancelled')
    expect(await inboxOf(outsider, outsiderPart)).toEqual([])

    // Части закрыты — ответственный отчитывается, автор принимает
    const reported = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/report`,
      as: worker,
      payload: { text: 'Сводный ответ готов' },
    })
    expect(reported.statusCode, reported.body).toBe(200)
    const accepted = await call(fx.app, { method: 'POST', url: `/tasks/${id}/accept`, as: boss })
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(
      accepted
        .json()
        .parts.map((row: { status: string }) => row.status)
        .sort(),
    ).toEqual(['accepted', 'cancelled'])
  })

  it('отмена основного поручения отменяет открытые части', async () => {
    const id = await createInstruction(boss, {
      assigneeId: worker.id,
      coAssigneeIds: [coWorker.id],
      dueWorkingDays: 5,
    })
    const cancelled = await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/cancel`,
      as: boss,
      payload: { comment: 'Не актуально' },
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    expect(cancelled.json().parts.map((row: { status: string }) => row.status)).toEqual([
      'cancelled',
    ])
    const [part] = cancelled.json().parts as Array<{ id: string }>
    expect(await inboxOf(coWorker, part!.id)).toEqual([])
  })
})

describe('руководитель видит поручения подчинённых', () => {
  let id: string

  beforeAll(async () => {
    id = await createInstruction(boss, {
      title: `Подчинённому ${run}`,
      assigneeId: worker.id,
      dueWorkingDays: 3,
    })
    await drainOutbox()
  })

  it('главы управления и отдела видят (только просмотр), посторонний — нет', async () => {
    for (const manager of [head, divHead]) {
      const seen = await task(id, manager)
      expect(seen.statusCode, seen.body).toBe(200)
      expect(seen.json().can).toMatchObject({
        edit: false,
        start: false,
        accept: false,
        reassign: false,
      })
      const edit = await call(fx.app, {
        method: 'PATCH',
        url: `/tasks/${id}`,
        as: manager,
        payload: { title: 'Чужое' },
      })
      expect(edit.statusCode).toBe(403)
      const start = await call(fx.app, { method: 'POST', url: `/tasks/${id}/start`, as: manager })
      expect(start.statusCode).toBe(403)
    }
    expect((await task(id, outsider)).statusCode).toBe(404)
    expect((await task(id, fx.users.stranger)).statusCode).toBe(404)
  })

  it('списки «Команда» и «Все», системный датасет «Поручения» — с правами смотрящего', async () => {
    const team = await call(fx.app, { url: '/tasks?scope=team&state=all', as: head })
    expect(team.json().items.map((row: { id: string }) => row.id)).toContain(id)
    const all = await call(fx.app, { url: '/tasks?scope=all&state=all', as: divHead })
    expect(all.json().items.map((row: { id: string }) => row.id)).toContain(id)
    const foreign = await call(fx.app, { url: '/tasks?scope=all&state=all', as: outsider })
    expect(foreign.json().items.map((row: { id: string }) => row.id)).not.toContain(id)

    const query = (as: TestUser) =>
      call(fx.app, {
        method: 'POST',
        url: '/queries/run',
        as,
        payload: {
          spec: {
            version: 1,
            source: { kind: 'system', name: 'instructions' },
            steps: [{ type: 'select', fields: ['id', 'key', 'state', 'unit', 'assignee'] }],
          },
        },
      })
    const managerRows = await query(head)
    expect(managerRows.statusCode, managerRows.body).toBe(200)
    const ids = (managerRows.json().rows as unknown[][]).map((row) => row[0])
    expect(ids).toContain(id)
    const row = (managerRows.json().rows as unknown[][]).find((item) => item[0] === id)
    expect(row?.[3]).toBe(unitDiv)
    const foreignRows = await query(outsider)
    expect((foreignRows.json().rows as unknown[][]).map((item) => item[0])).not.toContain(id)
    // Служебный столбец принципалов скрыт
    const names = managerRows.json().fields.map((field: { name: string }) => field.name)
    expect(names).not.toContain('viewers')
  })

  it('новый глава подразделения видит поручения, прежний — нет; переход сотрудника — пересчёт', async () => {
    const ctx = systemCtx('test')
    await db().transaction((tx) =>
      OrgService.updateUnit(tx, ctx, unitDiv, { headUserId: outsider.id }),
    )
    expect((await task(id, outsider)).statusCode).toBe(200)
    expect((await task(id, divHead)).statusCode).toBe(404)
    // Глава управления видит по-прежнему — отдел внутри управления
    expect((await task(id, head)).statusCode).toBe(200)
    await db().transaction((tx) =>
      OrgService.updateUnit(tx, ctx, unitDiv, { headUserId: divHead.id }),
    )

    // Исполнитель перешёл в другое подразделение — у открытого поручения меняется
    // подразделение (матрица контроля), принципалы руководителей пересчитываются
    const other = await createInstruction(boss, { assigneeId: coWorker.id, dueWorkingDays: 3 })
    const unitOf = async () =>
      (
        await db().execute<{ unit_id: string; viewers: string[] }>(
          sql`SELECT unit_id, viewers FROM tasks WHERE id = ${other}`,
        )
      )[0]
    expect((await unitOf())?.unit_id).toBe(unitDiv)
    const moved = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${coWorker.id}`,
      as: fx.admin,
      payload: { unitId: unitOther },
    })
    expect(moved.statusCode, moved.body).toBe(200)
    await drainOutbox()
    const after = await unitOf()
    expect(after?.unit_id).toBe(unitOther)
    expect(after?.viewers).toContain(`unit_head:${unitOther}`)
    await call(fx.app, {
      method: 'PATCH',
      url: `/users/${coWorker.id}`,
      as: fx.admin,
      payload: { unitId: unitDiv },
    })
    await drainOutbox()
    expect((await unitOf())?.unit_id).toBe(unitDiv)
  })
})

describe('напоминания, просрочка и эскалация', () => {
  it('за 3 и за 1 рабочий день и в день срока — по одному разу; повтор задания не дублирует', async () => {
    const id = await createInstruction(boss, { assigneeId: worker.id, dueWorkingDays: 6 })
    const card = (await task(id, boss)).json()
    const due = new Date(card.dueAt)
    const kinds = await BusinessCalendar.dayKinds(
      localDate(new Date(), TZ),
      localDate(new Date(due.getTime() + 20 * 86_400_000), TZ),
    )
    const moments = stageMoments(due, TZ, kinds, { enabled: true, afterWorkingDays: 1 })
    const soon = async () =>
      (await outboxEvents(id, 'task.due_soon')).map((row) => row.event.payload.stage)

    await TaskReminders.run(new Date(moments.d3.getTime() + 60_000))
    expect(await soon()).toEqual(['d3'])
    // Воркер перезапущен — тот же проход ещё раз
    await TaskReminders.run(new Date(moments.d3.getTime() + 120_000))
    expect(await soon()).toEqual(['d3'])
    await TaskReminders.run(new Date(moments.d1.getTime() + 60_000))
    await TaskReminders.run(new Date(moments.today.getTime() + 60_000))
    await TaskReminders.run(new Date(moments.today.getTime() + 120_000))
    expect(await soon()).toEqual(['d3', 'd1', 'today'])
    const payloads = (await outboxEvents(id, 'task.due_soon')).map((row) => row.event.payload)
    expect(payloads.map((payload) => payload.workingDaysLeft)).toEqual([3, 1, 0])
  })

  it('просрочка → автору и контролёру, эскалация → руководителю исполнителя; без дублей', async () => {
    const setting = await call(fx.app, {
      method: 'PUT',
      url: '/admin/tasks/settings',
      as: fx.admin,
      payload: { escalation: { enabled: true, afterWorkingDays: 1 } },
    })
    expect(setting.statusCode, setting.body).toBe(200)
    const id = await createInstruction(boss, {
      assigneeId: worker.id,
      controllerId: head.id,
      dueWorkingDays: 1,
    })
    const card = (await task(id, boss)).json()
    const due = new Date(card.dueAt)
    const kinds = await BusinessCalendar.dayKinds(
      localDate(new Date(), TZ),
      localDate(new Date(due.getTime() + 30 * 86_400_000), TZ),
    )
    const moments = stageMoments(due, TZ, kinds, { enabled: true, afterWorkingDays: 1 })

    await TaskReminders.run(new Date(moments.overdue.getTime() + 60_000))
    expect(await outboxEvents(id, 'task.overdue')).toHaveLength(1)
    expect(await outboxEvents(id, 'task.escalated')).toHaveLength(0)
    await TaskReminders.run(new Date(moments.escalated.getTime() + 60_000))
    await TaskReminders.run(new Date(moments.escalated.getTime() + 120_000))
    expect(await outboxEvents(id, 'task.overdue')).toHaveLength(1)
    const escalated = await outboxEvents(id, 'task.escalated')
    expect(escalated).toHaveLength(1)
    // Руководитель исполнителя — глава его отдела
    expect(escalated[0]?.event.payload).toMatchObject({
      managerId: divHead.id,
      afterWorkingDays: 1,
    })

    await drainOutbox()
    const notes = await db().execute<{ user_id: string; title_key: string }>(
      sql`SELECT user_id, title_key FROM notifications WHERE object_id = ${id}`,
    )
    const keys = (userId: string) =>
      notes.filter((note) => note.user_id === userId).map((note) => note.title_key)
    expect(keys(worker.id)).toContain('notifications.tpl.taskOverdue')
    expect(keys(boss.id)).toContain('notifications.tpl.taskOverdueIssued')
    expect(keys(head.id)).toContain('notifications.tpl.taskOverdueIssued')
    expect(keys(divHead.id)).toContain('notifications.tpl.taskEscalated')

    // Продление — новый срок: напоминания и просрочка снова по новому сроку
    await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/extension`,
      as: worker,
      payload: { dueWorkingDays: 2, reason: 'Не успели' },
    })
    await call(fx.app, {
      method: 'POST',
      url: `/tasks/${id}/extension/decide`,
      as: boss,
      payload: { decision: 'approve' },
    })
    const extended = new Date((await task(id, boss)).json().dueAt)
    const next = stageMoments(extended, TZ, kinds, { enabled: true, afterWorkingDays: 1 })
    await TaskReminders.run(new Date(next.overdue.getTime() + 60_000))
    expect(await outboxEvents(id, 'task.overdue')).toHaveLength(2)
  })

  it('эскалация выключена — только просрочка', async () => {
    await call(fx.app, {
      method: 'PUT',
      url: '/admin/tasks/settings',
      as: fx.admin,
      payload: { escalation: { enabled: false, afterWorkingDays: 0 } },
    })
    try {
      const id = await createInstruction(boss, { assigneeId: worker.id, dueWorkingDays: 1 })
      const due = new Date((await task(id, boss)).json().dueAt)
      await TaskReminders.run(new Date(due.getTime() + 10 * 86_400_000))
      expect(await outboxEvents(id, 'task.overdue')).toHaveLength(1)
      expect(await outboxEvents(id, 'task.escalated')).toHaveLength(0)
    } finally {
      await call(fx.app, {
        method: 'PUT',
        url: '/admin/tasks/settings',
        as: fx.admin,
        payload: { escalation: { enabled: true, afterWorkingDays: 1 } },
      })
    }
  })
})

describe('API для документов: поручения по резолюции', () => {
  it('создание в транзакции модуля; «все закрыты?»; task.source_closed — ровно один раз', async () => {
    // Стоит за документ: любой объект реестра, видимый автору резолюции
    const folder = await call(fx.app, {
      method: 'POST',
      url: '/folders',
      as: fx.admin,
      payload: { name: `Документ ${run}`, spaceId: fx.spaceId },
    })
    const documentId = folder.json().id as string
    const resolutionId = '0190a0b0-0000-7000-8000-000000000001'
    const ctx = systemCtx('documents.resolution', { initiatorId: fx.admin.id })
    const created = await db().transaction(async (tx) => {
      const first = await Instructions.create(tx, ctx, {
        title: `Подготовить ответ ${run}`,
        source: { kind: 'resolution', objectId: documentId, resolutionId, label: 'Вх. 1/26' },
        authorId: boss.id,
        assigneeId: worker.id,
        coAssigneeIds: [coWorker.id],
        due: { workingDays: 5 },
      })
      const second = await Instructions.create(tx, ctx, {
        title: `Доложить ${run}`,
        source: { kind: 'resolution', objectId: documentId, resolutionId },
        authorId: boss.id,
        assigneeId: outsider.id,
        due: { workingDays: 3 },
      })
      return { first, second }
    })
    expect(created.first.parts).toHaveLength(1)
    expect(created.first.key).toMatch(/^П-\d{2}-\d+$/)
    const status = await Instructions.status(documentId)
    expect(status).toMatchObject({
      total: 3,
      open: 3,
      allClosed: false,
      resolutionIds: [resolutionId],
    })
    const card = (await task(created.first.id, boss)).json()
    expect(card).toMatchObject({
      author: { id: boss.id },
      source: { kind: 'resolution', objectId: documentId, resolutionId, label: 'Вх. 1/26' },
    })

    // Часть и основное — закрыты; второе поручение принимается параллельно с первым
    const part = created.first.parts[0]!.id
    await call(fx.app, { method: 'POST', url: `/tasks/${part}/start`, as: coWorker })
    await call(fx.app, {
      method: 'POST',
      url: `/tasks/${part}/report`,
      as: coWorker,
      payload: { text: 'Часть' },
    })
    await call(fx.app, { method: 'POST', url: `/tasks/${part}/accept`, as: worker })
    for (const [taskId, assignee] of [
      [created.first.id, worker],
      [created.second.id, outsider],
    ] as const) {
      await call(fx.app, { method: 'POST', url: `/tasks/${taskId}/start`, as: assignee })
      const reported = await call(fx.app, {
        method: 'POST',
        url: `/tasks/${taskId}/report`,
        as: assignee,
        payload: { text: 'Исполнено' },
      })
      expect(reported.statusCode, reported.body).toBe(200)
    }
    const accepted = await Promise.all(
      [created.first.id, created.second.id].map((taskId) =>
        call(fx.app, { method: 'POST', url: `/tasks/${taskId}/accept`, as: boss }),
      ),
    )
    expect(accepted.map((response) => response.statusCode)).toEqual([200, 200])
    expect(await Instructions.status(documentId)).toMatchObject({
      open: 0,
      accepted: 3,
      allClosed: true,
    })
    const closed = await db().execute<{ event: { object: { id: string }; payload: unknown } }>(
      sql`SELECT event FROM ops.outbox WHERE type = 'task.source_closed'
           AND event->'payload'->>'sourceObjectId' = ${documentId}`,
    )
    expect(closed).toHaveLength(1)
    expect(closed[0]?.event.object.id).toBe(documentId)
    expect(closed[0]?.event.payload).toMatchObject({
      sourceKind: 'resolution',
      resolutionIds: [resolutionId],
      total: 3,
      accepted: 3,
      cancelled: 0,
    })
    // Поручения по источнику — для вкладки «Резолюции и поручения», с правами смотрящего
    const bySource = await call(fx.app, {
      url: `/tasks/by-source?objectId=${documentId}`,
      as: fx.admin,
    })
    expect(bySource.statusCode, bySource.body).toBe(200)
    expect(bySource.json().total).toBe(3)
  })
})

describe('экран «Контроль», нагрузка и «Мой день»', () => {
  let overdueId: string

  beforeAll(async () => {
    // Просроченное поручение подчинённого: срок — вчера
    const yesterday = endOfLocalDay(
      localDate(new Date(Date.now() - 86_400_000), TZ),
      TZ,
    ).toISOString()
    overdueId = await createInstruction(boss, {
      title: `Просроченное ${run}`,
      assigneeId: worker.id,
      controllerId: head.id,
      dueAt: yesterday,
    })
    await drainOutbox()
  })

  it('матрица «подразделения × состояния» с правами смотрящего; список просроченных', async () => {
    const report = await call(fx.app, { url: '/tasks/control', as: head })
    expect(report.statusCode, report.body).toBe(200)
    const body = report.json()
    const division = body.rows.find((row: { unitId: string }) => row.unitId === unitDiv)
    expect(division).toBeTruthy()
    expect(division.unitName).toBe('Подразделение DIV')
    expect(division.unitPath).toEqual(['Подразделение CTRL'])
    expect(division.counts.overdue).toBeGreaterThanOrEqual(1)
    expect(body.totals.total).toBeGreaterThanOrEqual(division.counts.total)
    expect(body.weeks.length).toBeGreaterThan(8)

    const list = await call(fx.app, { url: `/tasks/control/list?row=${unitDiv}`, as: head })
    expect(list.statusCode, list.body).toBe(200)
    const overdue = list.json().items.find((item: { id: string }) => item.id === overdueId)
    expect(overdue).toMatchObject({ state: 'overdue', assignee: { id: worker.id } })
    expect(overdue.daysLate).toBeGreaterThanOrEqual(1)

    // Посторонний не видит чужого — ни в матрице, ни в списке
    const foreign = await call(fx.app, { url: '/tasks/control', as: fx.users.stranger })
    expect(foreign.json().totals.total).toBe(0)
    const foreignList = await call(fx.app, { url: '/tasks/control/list', as: fx.users.stranger })
    expect(foreignList.json().items).toEqual([])

    // Фильтр по подразделению другого — пусто; по исполнителю — только его
    const other = await call(fx.app, { url: `/tasks/control?unitId=${unitOther}`, as: head })
    expect(other.json().rows.some((row: { unitId: string }) => row.unitId === unitDiv)).toBe(false)
    const byAssignee = await call(fx.app, {
      url: `/tasks/control/list?bucket=total&assigneeId=${worker.id}`,
      as: head,
    })
    expect(
      byAssignee
        .json()
        .items.every((item: { assignee: { id: string } }) => item.assignee.id === worker.id),
    ).toBe(true)
  })

  it('выгрузка матрицы в CSV и списка в XLSX', async () => {
    const csv = await call(fx.app, { url: '/tasks/control/export?format=csv', as: head })
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.body).toContain('Подразделение DIV')
    const xlsx = await call(fx.app, {
      url: '/tasks/control/export?format=xlsx&view=list&bucket=overdue',
      as: head,
    })
    expect(xlsx.statusCode).toBe(200)
    expect(xlsx.headers['content-type']).toContain('spreadsheetml')

    // Список — тот, что на экране: ячейка строки подразделения, а не весь столбец
    const key = (await call(fx.app, { url: `/tasks/${overdueId}`, as: head })).json().key
    const row = await call(fx.app, {
      url: `/tasks/control/export?format=csv&view=list&bucket=overdue&row=${unitDiv}`,
      as: head,
    })
    expect(row.statusCode, row.body).toBe(200)
    expect(row.body).toContain(key)
    const otherRow = await call(fx.app, {
      url: `/tasks/control/export?format=csv&view=list&bucket=overdue&row=${unitOther}`,
      as: head,
    })
    expect(otherRow.statusCode, otherRow.body).toBe(200)
    expect(otherRow.body).not.toContain(key)
  })

  it('консоль: показатели контроля заводятся в выбранном пространстве один раз', async () => {
    const before = await call(fx.app, { url: '/admin/tasks/metrics', as: fx.admin })
    expect(before.statusCode, before.body).toBe(200)
    expect(before.json().items.map((item: { id: string | null }) => item.id)).toEqual([null, null])

    const forbidden = await call(fx.app, {
      method: 'POST',
      url: '/admin/tasks/metrics',
      as: head,
      payload: { spaceId: fx.orgSpaceId },
    })
    expect(forbidden.statusCode).toBe(403)

    for (let attempt = 0; attempt < 2; attempt++) {
      const created = await call(fx.app, {
        method: 'POST',
        url: '/admin/tasks/metrics',
        as: fx.admin,
        payload: { spaceId: fx.orgSpaceId },
      })
      expect(created.statusCode, created.body).toBe(200)
      expect(created.json().items).toEqual([
        expect.objectContaining({ key: 'instructions.overdue', spaceId: fx.orgSpaceId }),
        expect.objectContaining({ key: 'instructions.on_time_rate', spaceId: fx.orgSpaceId }),
      ])
    }
    const [{ count }] = (await db().execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM objects WHERE type = 'metric'
           AND meta->>'systemKey' LIKE 'instructions.%' AND deleted_at IS NULL`,
    )) as unknown as [{ count: number }]
    expect(count).toBe(2)
  })

  it('показатели контроля — обычные показатели над системным датасетом «Поручения»', async () => {
    const ctx = systemCtx('test', { initiatorId: fx.admin.id })
    await db().transaction((tx) => ensureControlMetrics(tx, ctx, fx.orgSpaceId))
    await db().transaction((tx) => ensureControlMetrics(tx, ctx, fx.orgSpaceId))
    const [{ count }] = (await db().execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM objects WHERE type = 'metric'
           AND meta->>'systemKey' LIKE 'instructions.%' AND deleted_at IS NULL`,
    )) as unknown as [{ count: number }]
    expect(count).toBe(2)
    const report = (await call(fx.app, { url: '/tasks/control', as: fx.admin })).json()
    const overdueMetric = report.metrics.find(
      (item: { key: string }) => item.key === 'instructions.overdue',
    )
    expect(overdueMetric).toBeTruthy()
    const value = await call(fx.app, {
      method: 'POST',
      url: `/metrics/${overdueMetric.id}/value`,
      as: fx.admin,
      payload: {},
    })
    expect(value.statusCode, value.body).toBe(200)
    expect(value.json().value).toBeGreaterThanOrEqual(1)
    const metric = await call(fx.app, { url: `/metrics/${overdueMetric.id}`, as: fx.admin })
    expect(metric.json()).toMatchObject({ datasetId: null, systemSource: 'instructions' })

    // Доля в срок — в процентах: все принятые в этом месяце поручения исполнены в срок
    const rateMetric = report.metrics.find(
      (item: { key: string }) => item.key === 'instructions.on_time_rate',
    )
    const rate = await call(fx.app, {
      method: 'POST',
      url: `/metrics/${rateMetric.id}/value`,
      as: fx.admin,
      payload: {},
    })
    expect(rate.statusCode, rate.body).toBe(200)
    expect(rate.json().value).toBe(100)

    // Схема системного датасета — подписи показателя; служебный столбец прав скрыт
    const schema = await call(fx.app, { url: '/system-datasets/instructions', as: head })
    expect(schema.statusCode, schema.body).toBe(200)
    const fields = schema.json().fields as Array<{ key: string; label: { ru: string } }>
    expect(schema.json().timeField).toBe('due_at')
    expect(fields.find((field) => field.key === 'unit')?.label.ru).toBe('Подразделение исполнителя')
    expect(fields.some((field) => field.key === 'viewers')).toBe(false)
  })

  it('нагрузка: подчинённые × недели; «Выданные мной» и «Команда»', async () => {
    const workload = await call(fx.app, { url: '/tasks/workload?weeks=4', as: head })
    expect(workload.statusCode, workload.body).toBe(200)
    expect(workload.json()).toMatchObject({ scope: 'subordinates' })
    expect(workload.json().weeks).toHaveLength(4)
    const person = workload
      .json()
      .people.find((row: { user: { id: string } }) => row.user.id === worker.id)
    expect(person.open).toBeGreaterThanOrEqual(1)
    expect(person.overdue).toBeGreaterThanOrEqual(1)
    expect(person.cells).toHaveLength(4)

    const self = await call(fx.app, { url: '/tasks/workload', as: worker })
    expect(self.json().scope).toBe('self')

    const issued = await call(fx.app, { url: '/tasks/issued', as: boss })
    expect(issued.statusCode, issued.body).toBe(200)
    expect(issued.json().overdue).toBeGreaterThanOrEqual(1)
    expect(issued.json().items.map((row: { id: string }) => row.id)).toContain(overdueId)

    const team = await call(fx.app, { url: '/tasks/team', as: divHead })
    expect(team.statusCode, team.body).toBe(200)
    expect(team.json().manager).toBe(true)
    expect(team.json().overdue.map((row: { id: string }) => row.id)).toContain(overdueId)
    const notManager = await call(fx.app, { url: '/tasks/team', as: worker })
    expect(notManager.json()).toMatchObject({ manager: false, members: [] })
  })
})
