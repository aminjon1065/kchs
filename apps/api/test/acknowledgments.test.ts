import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'
import {
  actInbox,
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
 * Ознакомление — механизм ядра (08-documents.md §10, ADR-0084): шаг маршрута
 * `acknowledge` и запрос из карточки ведут один учёт. Решение шага отмечает
 * ожидание и снимает ожидания сотрудника по объекту из других запросов без
 * кода; отметка из карточки — решение шага, маршрут идёт дальше; отмена
 * маршрута снимает ожидания.
 */
registerLifecycle()

const { Acknowledgments } = await import('../src/kernel/acknowledgments/index.js')
const { systemCtx } = await import('../src/shared/context.js')

let fx: TestContext
let people: ProcessPeople
const run = Date.now().toString(36)
const key = `ack_${run}`

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

async function acknowledgmentsOf(objectId: string, as = people.author): Promise<Json> {
  const response = await call(fx.app, { url: `/objects/${objectId}/acknowledgments`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

const stateOf = (view: Json, userId: string) =>
  (view.items as Json[]).find((item) => item.user.id === userId)?.state

beforeAll(async () => {
  fx = await setupFixture()
  registerTestModule()
  people = await createPeople(fx, run)
  await publishDefinition(fx, {
    version: 1,
    key,
    objectType: TEST_TYPE(),
    name: { ru: 'Ознакомление с письмом' },
    start: 'ack',
    steps: {
      ack: {
        type: 'acknowledge',
        assignees: [`user:${people.a1.id}`, `user:${people.a2.id}`],
        dueWorkingDays: 2,
        next: 'done',
      },
      done: { type: 'end' },
    },
  })
})

describe('шаг маршрута «Ознакомление» — тот же учёт', () => {
  it('активация — ожидания с источником «маршрут»; решение шага и отметка из карточки', async () => {
    const doc = await createDocument(fx, people.author, `Письмо ${run}`)
    // До маршрута a1 уже просили ознакомиться из карточки — без кода
    await db().transaction((tx) =>
      Acknowledgments.request(tx, systemCtx('test', { initiatorId: people.author.id }), {
        objectId: doc,
        source: 'manual',
        userIds: [people.a1.id],
      }),
    )
    const instanceId = await startProcess(fx, people.author, { objectId: doc, definitionKey: key })
    let view = await acknowledgmentsOf(doc)
    const a1 = (view.items as Json[]).find((item) => item.user.id === people.a1.id)
    expect(a1).toMatchObject({
      state: 'pending',
      sources: expect.arrayContaining(['manual', 'process']),
    })
    expect(stateOf(view, people.a2.id)).toBe('pending')
    expect(view.requests.map((request: Json) => request.source).sort()).toEqual([
      'manual',
      'process',
    ])
    // Срок шага — срок ожидания
    expect(
      (view.items as Json[]).find((item) => item.user.id === people.a2.id).dueAt,
    ).not.toBeNull()

    // a1 отмечает делом шага: закрыты и ожидание шага, и ожидание из карточки
    const items = await inboxOf(fx, people.a1, doc)
    const stepItem = items.find((item) => item.processStepId)
    expect(stepItem).toBeTruthy()
    const acted = await actInbox(fx, people.a1, stepItem?.id ?? '', 'acknowledge')
    expect(acted.statusCode, acted.body).toBe(200)
    view = await acknowledgmentsOf(doc)
    expect(stateOf(view, people.a1.id)).toBe('acknowledged')
    expect(await inboxOf(fx, people.a1, doc)).toHaveLength(0)
    const pendingRows = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM acknowledgments
           WHERE object_id = ${doc} AND user_id = ${people.a1.id}
             AND acknowledged_at IS NULL AND cancelled_at IS NULL`,
    )
    expect(pendingRows[0]?.n).toBe(0)

    // a2 отмечает из карточки: решение шага — маршрут завершён
    const marked = await call(fx.app, {
      method: 'POST',
      url: `/objects/${doc}/acknowledgments/acknowledge`,
      as: people.a2,
      payload: {},
    })
    expect(marked.statusCode, marked.body).toBe(200)
    expect(stateOf(marked.json(), people.a2.id)).toBe('acknowledged')
    const finished = await route(fx, people.author, instanceId)
    expect(finished.status).toBe('finished')
    expect(finished.steps.find((step: Json) => step.key === 'ack')).toMatchObject({
      status: 'completed',
      outcome: 'acknowledged',
    })
    expect(await inboxOf(fx, people.a2, doc)).toHaveLength(0)
  })

  it('отмена маршрута снимает ожидания шага', async () => {
    const doc = await createDocument(fx, people.author, `Письмо на отмену ${run}`)
    const instanceId = await startProcess(fx, people.author, { objectId: doc, definitionKey: key })
    expect(stateOf(await acknowledgmentsOf(doc), people.a1.id)).toBe('pending')
    const cancelled = await call(fx.app, {
      method: 'POST',
      url: `/processes/${instanceId}/cancel`,
      as: people.author,
      payload: { reason: 'Письмо отозвано' },
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    const view = await acknowledgmentsOf(doc)
    expect(stateOf(view, people.a1.id)).toBe('cancelled')
    expect(view.summary).toMatchObject({ total: 0, pending: 0 })
    expect(view.requests[0].cancelledAt).not.toBeNull()
    // Отмечать больше нечего
    const late = await call(fx.app, {
      method: 'POST',
      url: `/objects/${doc}/acknowledgments/acknowledge`,
      as: people.a1,
      payload: {},
    })
    expect(late.statusCode).toBe(409)
  })

  it('посторонний не видит учёт; напоминать — с правом правки объекта', async () => {
    const doc = await createDocument(fx, people.author, `Письмо для учёта ${run}`)
    await startProcess(fx, people.author, { objectId: doc, definitionKey: key })
    const hidden = await call(fx.app, {
      url: `/objects/${doc}/acknowledgments`,
      as: fx.users.stranger,
    })
    expect(hidden.statusCode).toBe(404)
    const forbidden = await call(fx.app, {
      method: 'POST',
      url: `/objects/${doc}/acknowledgments/remind`,
      as: people.a1,
      payload: {},
    })
    expect(forbidden.statusCode).toBe(403)
    const reminded = await call(fx.app, {
      method: 'POST',
      url: `/objects/${doc}/acknowledgments/remind`,
      as: people.author,
      payload: { userIds: [people.a2.id] },
    })
    expect(reminded.statusCode, reminded.body).toBe(200)
    expect(reminded.json().reminded).toBe(1)
    const outbox = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ops.outbox
           WHERE type = 'acknowledgment.reminded' AND event->'object'->>'id' = ${doc}`,
    )
    expect(outbox[0]?.n).toBe(1)
  })
})
