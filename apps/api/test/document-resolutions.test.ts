import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  redis,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
  uploadFile,
} from './helpers.js'

/**
 * Резолюции, исполнение и ознакомление (P3-E02 S05, 08-documents.md §6, §10;
 * ADR-0084): направление на резолюцию правилом типа, резолюция с поручениями
 * в той же транзакции и сроком по производственному календарю, вложенная
 * резолюция, ввод от имени руководителя, «не требует исполнения», исполнение
 * по закрытию поручений, ознакомление при регистрации и вручную, проекция
 * сроков в календарь.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { OrgService } = await import('../src/modules/identity/public.js')
const { BusinessCalendar } = await import('../src/kernel/business-calendar/service.js')
const { systemCtx } = await import('../src/shared/context.js')

const run = Date.now().toString(36)

let fx: TestContext
let registrar: TestUser
let chief: TestUser
let head: TestUser
let exec1: TestUser
let exec2: TestUser
let exec3: TestUser
let deputy: TestUser
let outsider: TestUser
let officeUnit = ''
let deptUnit = ''
let teamUnit = ''
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
  headers?: Record<string, string>,
): Promise<Json> {
  const response = await call(fx.app, {
    method,
    url,
    as,
    ...(payload === undefined ? {} : { payload }),
    ...(headers ? { headers } : {}),
  })
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status)
  return response.body ? response.json() : null
}

/** Зарегистрированное входящее письмо подразделения `unitId` (скан, реквизиты). */
async function registeredIncoming(extra: Record<string, unknown> = {}): Promise<string> {
  const draft = await json(registrar, '/documents', 'POST', {
    typeId: types.get('incoming_letter'),
    subject: `О паводковой обстановке ${run}`,
    correspondentId: ministry,
    receivedDate: '2026-09-18',
    externalNumber: `01-02/${run}`,
    externalDate: '2026-09-15',
    deliveryMethod: 'post',
    unitId: deptUnit,
    ...extra,
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

async function inboxOf(user: TestUser, objectId: string, kind?: string): Promise<Json[]> {
  const list = await json(user, '/inbox?state=open')
  return (list.items as Json[]).filter(
    (item) => item.object?.id === objectId && (!kind || item.kind === kind),
  )
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

/** Исполнитель принимает поручение и отчитывается, автор или контролёр принимает отчёт. */
async function complete(taskId: string, assignee: TestUser, acceptor: TestUser): Promise<void> {
  await json(assignee, `/tasks/${taskId}/start`, 'POST', {})
  await json(assignee, `/tasks/${taskId}/report`, 'POST', { text: 'Исполнено' })
  await json(acceptor, `/tasks/${taskId}/accept`, 'POST', {})
}

beforeAll(async () => {
  fx = await setupFixture()
  const ctx = systemCtx('test')
  officeUnit = await db().transaction((tx) =>
    OrgService.createUnit(tx, ctx, {
      code: `OFFICE-${run}`,
      name: { ru: 'Управление делами' },
      kind: 'department',
      sort: 0,
      isActive: true,
      createSpace: false,
    }),
  )
  deptUnit = await db().transaction((tx) =>
    OrgService.createUnit(tx, ctx, {
      code: `DEPT-${run}`,
      name: { ru: 'Отдел мониторинга' },
      kind: 'department',
      parentId: officeUnit,
      sort: 0,
      isActive: true,
      createSpace: false,
    }),
  )
  // Группа отдела без руководителя: направление поднимается к главе отдела
  teamUnit = await db().transaction((tx) =>
    OrgService.createUnit(tx, ctx, {
      code: `TEAM-${run}`,
      name: { ru: 'Группа анализа' },
      kind: 'department',
      parentId: deptUnit,
      sort: 0,
      isActive: true,
      createSpace: false,
    }),
  )
  registrar = await createUser(fx.app, `reg_${run}`, ['employee', 'registrar'])
  chief = await createUser(fx.app, `chief_${run}`, ['employee'], officeUnit)
  deputy = await createUser(fx.app, `dep_${run}`, ['employee'], officeUnit)
  head = await createUser(fx.app, `head_${run}`, ['employee'], deptUnit)
  exec1 = await createUser(fx.app, `ex1_${run}`, ['employee'], deptUnit)
  exec2 = await createUser(fx.app, `ex2_${run}`, ['employee'], deptUnit)
  exec3 = await createUser(fx.app, `ex3_${run}`, ['employee'], deptUnit)
  outsider = await createUser(fx.app, `out_${run}`, ['employee'])
  await db().transaction(async (tx) => {
    await OrgService.updateUnit(tx, ctx, officeUnit, { headUserId: chief.id })
    await OrgService.updateUnit(tx, ctx, deptUnit, { headUserId: head.id })
  })
  await DocumentsSeed.ensureStarterSet(ctx, { demo: true })
  const typeList = await json(fx.admin, '/document-types')
  for (const item of typeList.items as Array<{ id: string; key: string }>) {
    types.set(item.key, item.id)
  }
  const found = await json(registrar, '/correspondents?q=Минфин')
  ministry = found.items[0].id
})

describe('направление на резолюцию правилом типа', () => {
  it('входящее после регистрации уходит руководителю подразделения: дело Входящих и доступ', async () => {
    const id = await registeredIncoming()
    const view = await json(head, `/documents/${id}/resolutions`)
    expect(view.requests).toHaveLength(1)
    expect(view.requests[0]).toMatchObject({ user: { id: head.id }, state: 'open' })
    expect(view.can).toMatchObject({ resolve: true, request: true, noExecution: true })
    expect(view.defaultAuthor).toMatchObject({ id: head.id })

    const [item] = await inboxOf(head, id, 'resolve')
    expect(item?.actions.map((action: Json) => action.key)).toEqual(['resolve', 'no_execution'])
    expect(item?.actions[0]).toMatchObject({ openObject: true })
    // Руководитель читает документ до резолюции — участием направления
    await json(head, `/documents/${id}`)
    await json(outsider, `/documents/${id}/resolutions`, 'GET', undefined, 404)

    const asRegistrar = await json(registrar, `/documents/${id}/resolutions`)
    expect(asRegistrar.can).toMatchObject({ resolve: false, resolveOnBehalf: true, request: true })
  })

  it('у подразделения документа нет руководителя — ближайший вышестоящий', async () => {
    const id = await registeredIncoming({ unitId: teamUnit })
    const view = await json(head, `/documents/${id}/resolutions`)
    expect(view.requests[0]).toMatchObject({ user: { id: head.id }, state: 'open' })
    const office = await registeredIncoming({ unitId: officeUnit })
    const top = await json(chief, `/documents/${office}/resolutions`)
    expect(top.requests[0]).toMatchObject({ user: { id: chief.id }, state: 'open' })
  })
})

describe('резолюция: поручения, срок, контроль', () => {
  let documentId = ''
  let resolutionId = ''
  let mainTask = ''
  let partTask = ''
  let dueDate = ''

  it('поручения ответственному и соисполнителю; срок рабочими днями с праздником; документ на исполнении', async () => {
    documentId = await registeredIncoming()
    // Праздник на ближайший рабочий день: срок «2 рабочих дня» его перешагивает
    const today = new Date().toISOString().slice(0, 10)
    const holiday = await BusinessCalendar.addWorkingDays(today, 1)
    await json(fx.admin, `/admin/business-calendar/${holiday}`, 'PUT', { kind: 'holiday' })
    try {
      const expected = (await BusinessCalendar.deadline(new Date(), 2)).date
      expect(expected > holiday).toBe(true)
      const view = await json(head, `/documents/${documentId}/resolutions`, 'POST', {
        text: 'Прошу подготовить ответ\nС учётом данных районов',
        responsibleId: exec1.id,
        coExecutorIds: [exec2.id],
        dueWorkingDays: 2,
      })
      const [resolution] = view.items
      resolutionId = resolution.id
      dueDate = resolution.dueDate
      expect(resolution).toMatchObject({
        author: { id: head.id },
        enteredBy: null,
        responsible: { id: exec1.id },
        coExecutors: [{ id: exec2.id }],
        dueDate: expected,
        dueWorkingDays: 2,
        control: true,
        // Контролёр по умолчанию — зарегистрировавший (канцелярия)
        controller: { id: registrar.id },
        total: 2,
        open: 2,
      })
      const main = resolution.instructions.find((item: Json) => item.parentId === null)
      const part = resolution.instructions.find((item: Json) => item.parentId !== null)
      mainTask = main.id
      partTask = part.id
      expect(main.assignee).toMatchObject({ id: exec1.id })
      expect(part.assignee).toMatchObject({ id: exec2.id })
      expect(view.requests[0]).toMatchObject({ user: { id: head.id }, state: 'resolved' })
    } finally {
      await json(fx.admin, `/admin/business-calendar/${holiday}`, 'DELETE')
    }

    const document = await json(registrar, `/documents/${documentId}`)
    expect(document).toMatchObject({
      status: 'on_execution',
      control: 'on',
      deadline: dueDate,
      controller: { id: registrar.id },
    })
    expect(await inboxOf(head, documentId, 'resolve')).toHaveLength(0)
    // Исполнители видят документ; поручение — с источником «резолюция»
    await json(exec1, `/documents/${documentId}`)
    const task = await json(exec1, `/tasks/${mainTask}`)
    expect(task).toMatchObject({
      kind: 'instruction',
      author: { id: head.id },
      source: { kind: 'resolution', objectId: documentId, resolutionId },
      title: 'Прошу подготовить ответ',
    })
    expect((await inboxOf(exec1, mainTask)).length).toBeGreaterThan(0)
  })

  it('вложенная резолюция — ответственный своему сотруднику, срок не позже родительской', async () => {
    const rejected = await call(fx.app, {
      method: 'POST',
      url: `/documents/${documentId}/resolutions`,
      as: exec1,
      payload: {
        text: 'Собрать данные по районам',
        responsibleId: exec3.id,
        dueDate: '2099-01-01',
        parentId: resolutionId,
      },
    })
    expect(rejected.statusCode, rejected.body).toBe(400)
    // Вложенную пишет ответственный или соисполнитель, не автор родительской;
    // не участник документа его не видит вовсе
    await json(
      head,
      `/documents/${documentId}/resolutions`,
      'POST',
      { text: 'Нет', responsibleId: exec2.id, dueDate, parentId: resolutionId },
      403,
    )
    await json(
      exec3,
      `/documents/${documentId}/resolutions`,
      'POST',
      { text: 'Нет', responsibleId: exec2.id, dueDate, parentId: resolutionId },
      404,
    )
    const view = await json(exec1, `/documents/${documentId}/resolutions`, 'POST', {
      text: 'Собрать данные по районам',
      responsibleId: exec3.id,
      dueDate,
      parentId: resolutionId,
      control: false,
    })
    const nested = view.items.find((item: Json) => item.parentId === resolutionId)
    expect(nested).toMatchObject({ author: { id: exec1.id }, responsible: { id: exec3.id } })
    expect(view.items.find((item: Json) => item.id === resolutionId).canNest).toBe(true)

    // Исполнение: части, вложенное, основное — документ «Исполнен», контроль снят
    await complete(partTask, exec2, exec1)
    await complete(nested.instructions[0].id, exec3, exec1)
    await deliver(documentId, 'documents-execution')
    expect((await json(registrar, `/documents/${documentId}`)).status).toBe('on_execution')
    await complete(mainTask, exec1, head)
    await deliver(documentId, 'documents-execution')
    const executed = await json(registrar, `/documents/${documentId}`)
    expect(executed).toMatchObject({ status: 'executed', control: 'done' })
    const after = await json(head, `/documents/${documentId}/resolutions`)
    expect(after.items.every((item: Json) => item.open === 0)).toBe(true)
    // Исполненному документу резолюцию не наложить
    await json(
      exec1,
      `/documents/${documentId}/resolutions`,
      'POST',
      { text: 'Ещё', responsibleId: exec3.id, dueDate, parentId: resolutionId },
      409,
    )
  })

  it('срок документа — в календаре контролёра (проекция «документы на контроле»)', async () => {
    const id = await registeredIncoming()
    const due = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
    await json(head, `/documents/${id}/resolutions`, 'POST', {
      text: 'К исполнению',
      responsibleId: exec1.id,
      dueDate: due,
    })
    const from = new Date(Date.now() - 86_400_000).toISOString()
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString()
    const range = await json(
      registrar,
      `/calendar/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&projections=documents.control`,
    )
    const item = (range.projections as Json[]).find((entry) => entry.objectId === id)
    expect(item).toMatchObject({ provider: 'documents.control', date: due, done: false })
    // Постороннему — нет
    const alien = await json(
      outsider,
      `/calendar/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&projections=documents.control`,
    )
    expect((alien.projections as Json[]).some((entry) => entry.objectId === id)).toBe(false)
  })
})

describe('кто и как накладывает резолюцию', () => {
  it('делопроизводитель вносит резолюцию от имени руководителя — в аудит', async () => {
    const id = await registeredIncoming()
    const view = await json(registrar, `/documents/${id}/resolutions`, 'POST', {
      text: 'Прошу рассмотреть и доложить',
      responsibleId: exec2.id,
      dueWorkingDays: 5,
      authorId: head.id,
    })
    expect(view.items[0]).toMatchObject({
      author: { id: head.id },
      enteredBy: { id: registrar.id },
    })
    // Направление руководителя закрыто его резолюцией
    expect(view.requests[0]).toMatchObject({ user: { id: head.id }, state: 'resolved' })
    const audit = await db().execute<{ details: Record<string, unknown> }>(
      sql`SELECT details FROM audit_log WHERE action = 'document.resolution_added' AND object_id = ${id}`,
    )
    expect(audit[0]?.details).toMatchObject({ authorId: head.id, enteredBy: registrar.id })
  })

  it('без направления и без права делопроизводителя — нельзя; черновик — нельзя', async () => {
    const id = await registeredIncoming()
    // Руководитель управления документ видит, но на резолюцию он направлен не ему
    await json(fx.admin, `/objects/${id}/access`, 'POST', {
      grants: [{ principal: { type: 'user', id: chief.id }, level: 'comment' }],
    })
    await json(
      chief,
      `/documents/${id}/resolutions`,
      'POST',
      { text: 'Моя резолюция', responsibleId: exec1.id, dueWorkingDays: 3 },
      403,
    )
    await json(
      outsider,
      `/documents/${id}/resolutions`,
      'POST',
      { text: 'Чужая', responsibleId: exec1.id, dueWorkingDays: 3 },
      404,
    )
    // Исполнитель — отключённый или несуществующий: ошибка проверки
    await json(
      head,
      `/documents/${id}/resolutions`,
      'POST',
      { text: 'Ответ', responsibleId: exec1.id, coExecutorIds: [exec1.id], dueWorkingDays: 3 },
      400,
    )
    const draft = await json(registrar, '/documents', 'POST', {
      typeId: types.get('memo'),
      subject: `Записка ${run}`,
    })
    await json(
      registrar,
      `/documents/${draft.id}/resolutions`,
      'POST',
      { text: 'Черновик', responsibleId: exec1.id, dueWorkingDays: 3, authorId: head.id },
      409,
    )
  })

  it('исполнитель без допуска к грифу документа — отказ с именем', async () => {
    for (const user of [registrar, head]) {
      await json(fx.admin, `/users/${user.id}/clearance`, 'PUT', {
        clearance: 'confidential',
        reason: 'Допуск для работы с конфиденциальными документами',
      })
      await redis().del(`kchs:principals:${user.id}`)
    }
    const id = await registeredIncoming({ confidentiality: 'confidential' })
    const response = await call(fx.app, {
      method: 'POST',
      url: `/documents/${id}/resolutions`,
      as: head,
      payload: { text: 'Подготовить справку', responsibleId: exec1.id, dueWorkingDays: 3 },
    })
    expect(response.statusCode, response.body).toBe(400)
    expect(response.json().detail).toContain('допуска')
  })

  it('заместитель «от имени» руководителя накладывает резолюцию по его направлению', async () => {
    const now = Date.now()
    await json(head, '/me/delegations', 'POST', {
      toUserId: deputy.id,
      scope: 'documents',
      startsAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 7 * 86_400_000).toISOString(),
    })
    await redis().del(`kchs:principals:${deputy.id}`)
    const id = await registeredIncoming()
    // Копия дела — заместителю; без режима «от имени» документ ему не виден
    const [copy] = await inboxOf(deputy, id, 'resolve')
    expect(copy?.onBehalfOf).toMatchObject({ id: head.id })
    await json(deputy, `/documents/${id}`, 'GET', undefined, 404)
    const onBehalf = { 'x-kchs-on-behalf-of': head.id }
    await json(deputy, `/documents/${id}`, 'GET', undefined, 200, onBehalf)
    const view = await json(
      deputy,
      `/documents/${id}/resolutions`,
      'POST',
      { text: 'К исполнению', responsibleId: exec1.id, dueWorkingDays: 3 },
      200,
      onBehalf,
    )
    expect(view.items[0]).toMatchObject({ author: { id: head.id }, enteredBy: { id: deputy.id } })
    expect(await inboxOf(deputy, id, 'resolve')).toHaveLength(0)
  })

  it('переадресация: получатель направляет другому руководителю', async () => {
    const id = await registeredIncoming()
    const view = await json(head, `/documents/${id}/resolution-requests`, 'POST', {
      userId: chief.id,
      note: 'Прошу рассмотреть лично',
    })
    const byUser = new Map(view.requests.map((item: Json) => [item.user.id, item]))
    expect(byUser.get(head.id)).toMatchObject({
      state: 'forwarded',
      comment: 'Прошу рассмотреть лично',
    })
    expect(byUser.get(chief.id)).toMatchObject({ state: 'open', note: 'Прошу рассмотреть лично' })
    expect(await inboxOf(chief, id, 'resolve')).toHaveLength(1)
    expect(await inboxOf(head, id, 'resolve')).toHaveLength(0)
    // Переадресовать может только получатель открытого направления
    await json(head, `/documents/${id}/resolution-requests`, 'POST', { userId: exec1.id }, 403)
    // Делопроизводитель снимает направление
    const requestId = (byUser.get(chief.id) as Json).id
    const cancelled = await json(
      registrar,
      `/documents/${id}/resolution-requests/${requestId}`,
      'DELETE',
    )
    expect(cancelled.requests.find((item: Json) => item.id === requestId).state).toBe('cancelled')
    expect(await inboxOf(chief, id, 'resolve')).toHaveLength(0)
  })

  it('«Не требует исполнения» из Входящих: документ исполнен без поручений', async () => {
    const id = await registeredIncoming()
    const [item] = await inboxOf(head, id, 'resolve')
    await json(head, `/inbox/${item.id}/act`, 'POST', { action: 'no_execution' })
    const document = await json(registrar, `/documents/${id}`)
    expect(document.status).toBe('executed')
    const view = await json(head, `/documents/${id}/resolutions`)
    expect(view.requests[0].state).toBe('no_execution')
    expect(view.can).toMatchObject({ resolve: false, noExecution: false })
    // «Наложить резолюцию» во Входящих не исполняется — это форма карточки
    const other = await registeredIncoming()
    const [open] = await inboxOf(head, other, 'resolve')
    await json(head, `/inbox/${open.id}/act`, 'POST', { action: 'resolve' }, 400)
  })

  it('документ исполнен без решения второго получателя — его направление снято', async () => {
    const id = await registeredIncoming()
    // Второе направление — руководителю управления; резолюцию накладывает он
    await json(registrar, `/documents/${id}/resolution-requests`, 'POST', { userId: chief.id })
    const view = await json(chief, `/documents/${id}/resolutions`, 'POST', {
      text: 'Исполнить в срок',
      responsibleId: exec3.id,
      coExecutorIds: [],
      dueWorkingDays: 3,
    })
    const [task] = view.items[0].instructions as Json[]
    // Документ на исполнении: руководитель отдела ещё может дать свою резолюцию
    expect(await inboxOf(head, id, 'resolve')).toHaveLength(1)
    await complete(task.id, exec3, chief)
    await deliver(id, 'documents-execution')
    expect((await json(registrar, `/documents/${id}`)).status).toBe('executed')

    await deliver(id, 'documents-resolution-requests')
    const after = await json(registrar, `/documents/${id}/resolutions`)
    const states = new Map(after.requests.map((item: Json) => [item.user.id, item.state]))
    expect(states.get(chief.id)).toBe('resolved')
    expect(states.get(head.id)).toBe('cancelled')
    expect(await inboxOf(head, id, 'resolve')).toHaveLength(0)
  })
})

describe('шаблоны резолюций', () => {
  it('общие ведёт канцелярия, личные — каждый; стартовый набор — из миграции', async () => {
    const created = await json(fx.admin, '/resolution-templates', 'POST', {
      text: `К исполнению в срок ${run}`,
      dueWorkingDays: 10,
      shared: true,
    })
    const shared = created.items.find((item: Json) => item.text === `К исполнению в срок ${run}`)
    expect(shared).toMatchObject({ shared: true, canEdit: true, dueWorkingDays: 10 })
    await json(
      head,
      '/resolution-templates',
      'POST',
      { text: 'Мне на контроль', shared: true },
      403,
    )
    const mine = await json(head, '/resolution-templates', 'POST', { text: `Лично ${run}` })
    const personal = mine.items.find((item: Json) => item.text === `Лично ${run}`)
    expect(personal).toMatchObject({ shared: false, canEdit: true })
    expect(mine.items.find((item: Json) => item.id === shared.id)).toMatchObject({ canEdit: false })
    await json(head, `/resolution-templates/${shared.id}`, 'PATCH', { text: 'Нет' }, 403)
    // Чужой личный шаблон не виден
    const others = await json(exec1, '/resolution-templates')
    expect(others.items.some((item: Json) => item.id === personal.id)).toBe(false)
    await json(head, `/resolution-templates/${personal.id}`, 'DELETE')
  })
})

describe('ознакомление', () => {
  let orderId = ''

  it('приказ при регистрации — сотрудникам подразделения: дела, срок, права', async () => {
    const draft = await json(registrar, '/documents', 'POST', {
      typeId: types.get('order'),
      subject: `О режиме повышенной готовности ${run}`,
      unitId: deptUnit,
    })
    orderId = draft.id
    await json(registrar, `/documents/${orderId}/register`, 'POST', {})
    const view = await json(registrar, `/objects/${orderId}/acknowledgments`)
    const pending = (view.items as Json[]).map((item) => item.user.id).sort()
    expect(pending).toEqual([head.id, exec1.id, exec2.id, exec3.id].sort())
    expect(view.summary).toMatchObject({ total: 4, pending: 4, acknowledged: 0 })
    expect(view.requests[0]).toMatchObject({ source: 'register', total: 4 })
    // Срок — 3 рабочих дня по правилу типа
    expect(view.items[0].dueAt).not.toBeNull()
    expect(view.can).toMatchObject({ request: true, remind: true })
    // Сотрудник видит приказ и дело «Ознакомиться»
    await json(exec1, `/documents/${orderId}`)
    const [item] = await inboxOf(exec1, orderId, 'acknowledge')
    expect(item?.actions[0]).toMatchObject({ key: 'acknowledge' })
    expect(item?.actions[0].requiresSecondFactor).toBeFalsy()
  })

  it('отметка из Входящих и из карточки; «кто не ознакомился»; напоминание', async () => {
    const [item] = await inboxOf(exec1, orderId, 'acknowledge')
    await json(exec1, `/inbox/${item.id}/act`, 'POST', { action: 'acknowledge' })
    const mine = await json(exec2, `/objects/${orderId}/acknowledgments`)
    expect(mine.mine).toMatchObject({ pending: true, requireSecondFactor: false })
    const after = await json(exec2, `/objects/${orderId}/acknowledgments/acknowledge`, 'POST', {})
    const states = new Map((after.items as Json[]).map((entry) => [entry.user.id, entry.state]))
    expect(states.get(exec1.id)).toBe('acknowledged')
    expect(states.get(exec2.id)).toBe('acknowledged')
    expect(after.summary).toMatchObject({ acknowledged: 2, pending: 2 })
    expect(await inboxOf(exec2, orderId, 'acknowledge')).toHaveLength(0)
    // Повторная отметка — нечего отмечать
    await json(exec2, `/objects/${orderId}/acknowledgments/acknowledge`, 'POST', {}, 409)

    const reminded = await json(registrar, `/objects/${orderId}/acknowledgments/remind`, 'POST', {})
    expect(reminded.reminded).toBe(2)
    // Не чаще раза в час
    const again = await json(registrar, `/objects/${orderId}/acknowledgments/remind`, 'POST', {})
    expect(again.reminded).toBe(0)
    // Напоминать может только тот, кто отправляет на ознакомление
    await json(exec3, `/objects/${orderId}/acknowledgments/remind`, 'POST', {}, 403)
  })

  it('вручную из карточки: с кодом второго фактора; ждущих и без допуска — пропускает', async () => {
    const result = await json(registrar, `/documents/${orderId}/acknowledgments`, 'POST', {
      userIds: [chief.id, exec3.id],
      requireSecondFactor: true,
      note: 'Лично под подпись',
    })
    expect(result.added).toBe(1)
    expect(result.skipped).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ id: exec3.id }),
        reason: 'pending',
      }),
    ])
    const [item] = await inboxOf(chief, orderId, 'acknowledge')
    expect(item?.actions[0]).toMatchObject({ key: 'acknowledge', requiresSecondFactor: true })
    // Без кода — отказ; отметка остаётся за сотрудником
    const denied = await call(fx.app, {
      method: 'POST',
      url: `/objects/${orderId}/acknowledgments/acknowledge`,
      as: chief,
      payload: {},
    })
    expect(denied.statusCode, denied.body).toBe(400)
    const view = await json(chief, `/objects/${orderId}/acknowledgments`)
    expect(view.mine).toMatchObject({ pending: true, requireSecondFactor: true })
    // Отправлять может тот, у кого право правки
    await json(exec1, `/documents/${orderId}/acknowledgments`, 'POST', { userIds: [chief.id] }, 403)
    // Сотрудник без допуска к грифу пропускается
    const secret = await registeredIncoming({ confidentiality: 'confidential' })
    const skipped = await json(registrar, `/documents/${secret}/acknowledgments`, 'POST', {
      userIds: [exec1.id],
    })
    expect(skipped).toMatchObject({ requestId: null, added: 0 })
    expect(skipped.skipped[0]).toMatchObject({ reason: 'clearance' })
  })
})
