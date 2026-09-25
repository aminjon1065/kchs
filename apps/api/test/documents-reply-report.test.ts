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
  uploadFile,
} from './helpers.js'

/**
 * Готовый отчёт после отправки ответа (N22, ADR-0136): исходящий «в ответ на» входящий с
 * поручением по резолюции зарегистрирован и отправлен — исполнитель поручения видит отчёт с
 * номером исходящего, отправляет его одной кнопкой, принимает автор резолюции.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { OrgService } = await import('../src/modules/identity/public.js')
const { systemCtx } = await import('../src/shared/context.js')

const run = Date.now().toString(36)

let fx: TestContext
let registrar: TestUser
let head: TestUser
let exec1: TestUser
let exec2: TestUser
let deptUnit = ''
let ministry = ''
const types = new Map<string, string>()

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

async function json(
  as: TestUser,
  url: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' = 'GET',
  payload?: unknown,
  status = 200,
): Promise<Json> {
  const response = await call(fx.app, {
    method,
    url,
    as,
    ...(payload === undefined ? {} : { payload }),
  })
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status)
  return response.body ? response.json() : null
}

/** Зарегистрированное входящее подразделения со сканом. */
async function registeredIncoming(subject: string): Promise<string> {
  const draft = await json(registrar, '/documents', 'POST', {
    typeId: types.get('incoming_letter'),
    subject,
    correspondentId: ministry,
    receivedDate: '2026-09-18',
    externalNumber: `01-02/${run}`,
    externalDate: '2026-09-15',
    deliveryMethod: 'post',
    unitId: deptUnit,
  })
  const uploaded = await uploadFile(fx.app, registrar, {
    spaceId: (await json(registrar, `/documents/${draft.id}`)).spaceId,
    name: `скан-${run}.pdf`,
    mime: 'application/pdf',
    content: '%PDF-1.4 скан входящего письма',
    attachToObjectId: draft.id,
  })
  await json(registrar, `/documents/${draft.id}/versions`, 'POST', { mainFileId: uploaded.id })
  await json(registrar, `/documents/${draft.id}/register`, 'POST', {})
  return draft.id as string
}

/**
 * Ответ готовит `author`; канцелярия (доступ на правку — как участнику маршрута)
 * регистрирует и отправляет его. Возвращает исходящий и его номер.
 */
async function dispatchedReply(
  incomingId: string,
  author: TestUser,
): Promise<{ id: string; number: string }> {
  const reply = await json(author, `/documents/${incomingId}/reply`, 'POST', {})
  if (author.id !== registrar.id) {
    await json(fx.admin, `/objects/${reply.id}/access`, 'POST', {
      grants: [{ principal: { type: 'user', id: registrar.id }, level: 'edit' }],
    })
  }
  const registered = await json(registrar, `/documents/${reply.id}/register`, 'POST', {})
  await json(registrar, `/documents/${reply.id}/dispatches`, 'POST', {
    correspondentId: ministry,
    method: 'email',
    sentOn: '2026-09-24',
  })
  return { id: reply.id as string, number: registered.regNumber as string }
}

/** События объекта из outbox — подписчику модуля, как воркер. */
async function deliver(objectId: string, subscriberName: string): Promise<void> {
  const { listSubscribers, matchesType } = await import('../src/kernel/events/bus.js')
  if (!listSubscribers().some((subscriber) => subscriber.name === subscriberName)) {
    const { registerDocumentsBackground } = await import('../src/modules/documents/module.js')
    registerDocumentsBackground()
  }
  const rows = await db().execute<{ event: { type: string } }>(
    sql`SELECT event FROM ops.outbox WHERE event->'object'->>'id' = ${objectId} ORDER BY id`,
  )
  for (const { event } of rows) {
    for (const subscriber of listSubscribers()) {
      if (subscriber.name !== subscriberName) continue
      if (matchesType(subscriber.types, event.type)) await subscriber.handle(event as never)
    }
  }
}

async function preparedEvents(taskId: string): Promise<number> {
  const rows = await db().execute<{ count: number }>(
    sql`SELECT count(*)::int AS count FROM ops.outbox
         WHERE event->>'type' = 'task.report_prepared' AND event->'object'->>'id' = ${taskId}`,
  )
  return rows[0]?.count ?? 0
}

/** Резолюция руководителя с одним ответственным: основное поручение. */
async function resolve(
  incomingId: string,
  extra: Record<string, unknown> = {},
): Promise<{ main: string; parts: string[] }> {
  const view = await json(head, `/documents/${incomingId}/resolutions`, 'POST', {
    text: 'Подготовить ответ министерству',
    responsibleId: exec1.id,
    dueWorkingDays: 5,
    ...extra,
  })
  const instructions = view.items[0].instructions as Json[]
  return {
    main: instructions.find((item) => item.parentId === null).id,
    parts: instructions.filter((item) => item.parentId !== null).map((item) => item.id),
  }
}

beforeAll(async () => {
  fx = await setupFixture()
  const ctx = systemCtx('test')
  deptUnit = await db().transaction((tx) =>
    OrgService.createUnit(tx, ctx, {
      code: `RR-${run}`,
      name: { ru: 'Отдел мониторинга' },
      kind: 'department',
      sort: 0,
      isActive: true,
      createSpace: false,
    }),
  )
  registrar = await createUser(fx.app, `rreg_${run}`, ['employee', 'registrar'])
  head = await createUser(fx.app, `rhead_${run}`, ['employee'], deptUnit)
  exec1 = await createUser(fx.app, `rex1_${run}`, ['employee'], deptUnit)
  exec2 = await createUser(fx.app, `rex2_${run}`, ['employee'], deptUnit)
  await db().transaction((tx) => OrgService.updateUnit(tx, ctx, deptUnit, { headUserId: head.id }))
  await DocumentsSeed.ensureStarterSet(ctx, { demo: true })
  const typeList = await json(fx.admin, '/document-types')
  for (const item of typeList.items as Array<{ id: string; key: string }>) {
    types.set(item.key, item.id)
  }
  const found = await json(registrar, '/correspondents?q=Минфин')
  ministry = found.items[0].id
})

describe('готовый отчёт после отправки ответа', () => {
  it('исполнитель отправляет отчёт с номером исходящего одной кнопкой, принимает автор резолюции', async () => {
    const incoming = await registeredIncoming(`О паводке ${run}`)
    const { main } = await resolve(incoming)
    await json(exec1, `/tasks/${main}/start`, 'POST', {})

    const outgoing = await dispatchedReply(incoming, exec1)
    await deliver(outgoing.id, 'documents-reply-report')

    const task = await json(exec1, `/tasks/${main}`)
    expect(task.status).toBe('in_progress')
    expect(task.reportDraft).toMatchObject({
      cause: 'reply_dispatched',
      objects: [{ id: outgoing.id, type: 'document' }],
    })
    expect(task.reportDraft.text).toContain(`исх. № ${outgoing.number}`)
    expect(task.reportDraft.text).toMatch(/от \d{2}\.\d{2}\.\d{4}/)
    expect(task.reportDraft.objects[0].title).toBeTruthy()
    // Готовый отчёт — только исполнителю
    expect((await json(head, `/tasks/${main}`)).reportDraft).toBeNull()
    expect(await preparedEvents(main)).toBe(1)

    // Повтор события отчёт заново не готовит
    await deliver(outgoing.id, 'documents-reply-report')
    expect(await preparedEvents(main)).toBe(1)

    // Одна кнопка: текст и материалы готового отчёта уходят автору на приёмку
    const reported = await json(exec1, `/tasks/${main}/report`, 'POST', {
      text: task.reportDraft.text,
      objectIds: task.reportDraft.objects.map((object: Json) => object.id),
    })
    expect(reported).toMatchObject({ status: 'reported', reportDraft: null })
    expect(reported.result.objects.map((object: Json) => object.id)).toEqual([outgoing.id])
    expect(reported.result.text).toContain(outgoing.number)

    const accepted = await json(head, `/tasks/${main}/accept`, 'POST', {})
    expect(accepted.status).toBe('accepted')
  })

  it('ответ готовит не исполнитель — отчёт получает исполнитель единственного основного поручения', async () => {
    const incoming = await registeredIncoming(`О запасах ${run}`)
    const { main, parts } = await resolve(incoming, { coExecutorIds: [exec2.id] })
    expect(parts).toHaveLength(1)

    const outgoing = await dispatchedReply(incoming, registrar)
    await deliver(outgoing.id, 'documents-reply-report')

    const task = await json(exec1, `/tasks/${main}`)
    expect(task.status).toBe('assigned')
    expect(task.reportDraft?.text).toContain(outgoing.number)
    // Часть соисполнителя отчёт не получает
    expect((await json(exec2, `/tasks/${parts[0]}`)).reportDraft).toBeNull()
    expect(await preparedEvents(parts[0] as string)).toBe(0)
  })

  it('отчитанное поручение и исходящий не в ответ на входящий — без готового отчёта', async () => {
    const incoming = await registeredIncoming(`О связи ${run}`)
    const { main } = await resolve(incoming)
    await json(exec1, `/tasks/${main}/start`, 'POST', {})
    await json(exec1, `/tasks/${main}/report`, 'POST', { text: 'Ответ дан по телефону' })

    const outgoing = await dispatchedReply(incoming, exec1)
    await deliver(outgoing.id, 'documents-reply-report')
    expect(await preparedEvents(main)).toBe(0)

    const standalone = await json(exec1, '/documents', 'POST', {
      typeId: types.get('outgoing_letter'),
      subject: `Информационное письмо ${run}`,
      correspondentId: ministry,
    })
    await json(fx.admin, `/objects/${standalone.id}/access`, 'POST', {
      grants: [{ principal: { type: 'user', id: registrar.id }, level: 'edit' }],
    })
    await json(registrar, `/documents/${standalone.id}/register`, 'POST', {})
    await json(registrar, `/documents/${standalone.id}/dispatches`, 'POST', {
      correspondentId: ministry,
      method: 'post',
      sentOn: '2026-09-24',
    })
    const { prepareReplyReports } = await import('../src/modules/documents/domain/reply-report.js')
    const rows = await db().execute<{ event: Json }>(
      sql`SELECT event FROM ops.outbox WHERE event->>'type' = 'document.dispatched'
           AND event->'object'->>'id' = ${standalone.id}`,
    )
    expect(rows).toHaveLength(1)
    expect(await prepareReplyReports(rows[0]?.event)).toBe(0)
  })
})
