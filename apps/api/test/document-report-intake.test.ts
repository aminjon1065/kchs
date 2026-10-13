import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'
import { actInbox, createPeople, inboxOf, type ProcessPeople } from './process-fixtures.js'

/**
 * Донесение из поля — дежурной смене (ADR-0212, N129): `POST /documents/{id}/intake`
 * запускает маршрут типа по умолчанию, сам заполняя корреспондента (подразделение автора) и
 * дату поступления; повтор и гонка дают один маршрут; без маршрута приёма донесение остаётся
 * черновиком. Регистрирует член дежурной смены без способности «Регистрация» — права на
 * журнал донесений ему достаточно, назначение на шаг проверил движок.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { ProcessDefinitions } = await import('../src/kernel/process/index.js')
const { GroupService } = await import('../src/kernel/directory/group-service.js')
const { grantAccess } = await import('../src/kernel/access/acl-service.js')
const { reportIntakeRoute } = await import('../src/seed/packs/emergency/documents.js')
const { systemCtx } = await import('../src/shared/context.js')
const { processInstances } = await import('../src/db-schema.js')

const run = Date.now().toString(36)
const ROUTE = `intake_${run}`
let fx: TestContext
let people: ProcessPeople
let reportTypeId = ''
let journalId = ''

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Body = any

async function report(subject: string, as = people.author): Promise<string> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/documents',
    as,
    payload: { typeId: reportTypeId, subject, clientKey: randomUUID() },
  })
  expect(created.statusCode, created.body).toBe(200)
  return created.json().id as string
}

const intake = (id: string, as = people.author) =>
  call(fx.app, { method: 'POST', url: `/documents/${id}/intake`, as })

async function card(id: string, as = people.author): Promise<Body> {
  const response = await call(fx.app, { url: `/documents/${id}`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

beforeAll(async () => {
  fx = await setupFixture()
  people = await createPeople(fx, run)
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  const types = (await call(fx.app, { url: '/document-types', as: fx.admin })).json()
    .items as Array<{ id: string; key: string; numbering: { journalId: string | null } }>
  const type = types.find((item) => item.key === 'situation_report')
  reportTypeId = type?.id as string
  journalId = type?.numbering.journalId as string
  expect(journalId).toBeTruthy()
})

describe('донесение — на регистрацию дежурной смене', () => {
  it('у типа нет маршрута приёма — донесение остаётся черновиком автора', async () => {
    const id = await report(`Без маршрута ${run}`)
    const response = await intake(id)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toEqual({ state: 'draft', instanceId: null })
    expect(await card(id)).toMatchObject({ status: 'draft', route: null, correspondent: null })
  })

  it('маршрут приёма: корреспондент и дата поступления сами, повтор и гонка — один маршрут', async () => {
    // Дежурная смена — группа с доступом на правку журнала донесений, как в пакете ЧС
    const duty = await db().transaction((tx) =>
      GroupService.create(tx, systemCtx('test'), `Дежурная смена ${run}`),
    )
    await db().transaction(async (tx) => {
      await GroupService.setMembers(tx, systemCtx('test'), duty, [people.a1.id])
      await grantAccess(tx, systemCtx('test'), journalId, [
        { principal: { type: 'group', id: duty }, level: 'edit' },
      ])
      await ProcessDefinitions.ensure(tx, systemCtx('test'), {
        ...reportIntakeRoute(duty),
        key: ROUTE,
      })
    })
    const updated = await call(fx.app, {
      method: 'PATCH',
      url: `/document-types/${reportTypeId}`,
      as: fx.admin,
      payload: { defaultRouteKey: ROUTE },
    })
    expect(updated.statusCode, updated.body).toBe(200)

    const id = await report(`Подмыт мост ${run}`)
    // Без файла карточка предлагает только маршруты без согласования и подписи
    const options = await call(fx.app, { url: `/documents/${id}/routes`, as: people.author })
    expect(options.statusCode, options.body).toBe(200)
    expect(options.json()).toMatchObject({ canStart: true, blocker: null })
    const offered = (options.json().items as Array<{ key: string; isDefault: boolean }>).map(
      (item) => item.key,
    )
    expect(offered).toContain(ROUTE)
    expect(offered).not.toContain('document_memo')
    // Очередь устройства может прислать запрос несколько раз и одновременно
    const answers = await Promise.all([intake(id), intake(id), intake(id)])
    for (const answer of answers) expect(answer.statusCode, answer.body).toBe(200)
    const [first] = answers.map((answer) => answer.json())
    expect(first).toMatchObject({ state: 'sent' })
    for (const answer of answers) expect(answer.json().instanceId).toBe(first.instanceId)
    const again = await intake(id)
    expect(again.json()).toEqual(first)
    const instances = await db()
      .select({ id: processInstances.id })
      .from(processInstances)
      .where(eq(processInstances.objectId, id))
    expect(instances).toHaveLength(1)

    const record = await card(id)
    expect(record.status).toBe('draft')
    expect(record.route).toMatchObject({ definitionKey: ROUTE })
    // От кого — подразделение автора; дата поступления — день отправки
    expect(record.correspondent).toMatchObject({ name: expect.any(String) })
    expect(record.receivedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const second = await report(`Второе донесение ${run}`)
    expect((await intake(second)).json()).toMatchObject({ state: 'sent' })
    // Второе донесение того же подразделения — тот же корреспондент
    expect((await card(second)).correspondent.id).toBe(record.correspondent.id)

    // Дело регистрации — во Входящих дежурной смены; регистрирует дежурный без роли
    // делопроизводителя: права на журнал донесений достаточно
    const [item] = await inboxOf(fx, people.a1, id)
    expect(item?.actions.map((action) => action.key)).toContain('register')
    const registered = await actInbox(fx, people.a1, item?.id ?? '', 'register')
    expect(registered.statusCode, registered.body).toBe(200)
    const done = await card(id)
    expect(done.status).toBe('registered')
    expect(done.regNumber).toBeTruthy()
    expect(done.route).toBeNull()
    expect((await intake(id)).json()).toEqual({ state: 'registered', instanceId: null })
  })

  it('чужой черновик не отправить; исходящий так не отправляется', async () => {
    const id = await report(`Чужое ${run}`)
    expect((await intake(id, people.a2)).statusCode).toBe(404)
    const types = (await call(fx.app, { url: '/document-types', as: fx.admin })).json()
      .items as Array<{ id: string; key: string }>
    const memo = await call(fx.app, {
      method: 'POST',
      url: '/documents',
      as: people.author,
      payload: { typeId: types.find((item) => item.key === 'memo')?.id, subject: `СЗ ${run}` },
    })
    const response = await intake(memo.json().id)
    expect(response.statusCode).toBe(409)
    expect(response.json().detail).toMatch(/только входящий/)
  })
})
