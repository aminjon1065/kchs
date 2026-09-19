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
 * Дела и архив, связи и переписка, «Канцелярия» (P3-E02 S07/S09/S10/S12,
 * ADR-0086): ответ на входящий исходящим со связью «в ответ на», отметка
 * отправки, цепочка переписки, номенклатура дел, подшивка, закрытие и передача
 * в архив, акт о выделении к уничтожению, фильтры списков, поиск в архиве,
 * показатели и дашборд канцелярии, демо-документы сида. Шаг 6 сценария B.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const { indexObject } = await import('../src/kernel/search/index-service.js')

const run = Date.now().toString(36)
const year = new Date().getFullYear()

let fx: TestContext
let registrar: TestUser
let clerk: TestUser
const types = new Map<string, string>()
let ministry = ''
let ministryName = ''

interface DocumentBody {
  id: string
  spaceId: string
  status: string
  regNumber: string | null
  subject: string
  correspondent: { id: string; name: string } | null
  confidentiality: string
  case: { id: string; index: string; status: string } | null
  filedAt: string | null
  dispatchCount: number
  filesDestroyedAt: string | null
  currentVersion: { mainFile: { id: string } | null } | null
  can: Record<string, boolean>
  type: { key: string; direction: string }
}

const get = (as: TestUser, url: string) => call(fx.app, { url, as })
const post = (as: TestUser, url: string, payload: Record<string, unknown> = {}) =>
  call(fx.app, { method: 'POST', url, as, payload })

async function documentOf(as: TestUser, id: string): Promise<DocumentBody> {
  const response = await get(as, `/documents/${id}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

async function draft(
  as: TestUser,
  typeKey: string,
  extra: Record<string, unknown> = {},
): Promise<DocumentBody> {
  const created = await post(as, '/documents', {
    typeId: types.get(typeKey),
    subject: `Документ ${run}`,
    ...extra,
  })
  expect(created.statusCode, created.body).toBe(200)
  return documentOf(as, created.json().id)
}

/** Входящее письмо со сканом, зарегистрированное делопроизводителем. */
async function registeredIncoming(extra: Record<string, unknown> = {}): Promise<DocumentBody> {
  const doc = await draft(registrar, 'incoming_letter', {
    subject: `О паводковой обстановке ${run}`,
    correspondentId: ministry,
    receivedDate: '2026-09-18',
    externalNumber: `05-11/${run}`,
    externalDate: '2026-09-15',
    deliveryMethod: 'post',
    ...extra,
  })
  const scan = await uploadFile(fx.app, registrar, {
    spaceId: doc.spaceId,
    name: `скан-${run}.pdf`,
    mime: 'application/pdf',
    content: '%PDF-1.4 скан входящего письма',
    attachToObjectId: doc.id,
  })
  const version = await post(registrar, `/documents/${doc.id}/versions`, { mainFileId: scan.id })
  expect(version.statusCode, version.body).toBe(200)
  const registered = await post(registrar, `/documents/${doc.id}/register`)
  expect(registered.statusCode, registered.body).toBe(200)
  return registered.json()
}

async function createCase(
  as: TestUser,
  input: Record<string, unknown>,
): Promise<{ id: string; status: string; destroyableFrom: string | null }> {
  const created = await post(as, '/cases', {
    title: `Переписка ${run}`,
    year,
    retentionYears: 5,
    ...input,
  })
  expect(created.statusCode, created.body).toBe(200)
  return created.json()
}

async function auditCount(action: string, objectId: string): Promise<number> {
  const [row] = await db().execute<{ total: number }>(
    sql`SELECT count(*)::int AS total FROM audit_log WHERE action = ${action} AND object_id = ${objectId}`,
  )
  return row?.total ?? 0
}

async function listIds(as: TestUser, filter: unknown): Promise<string[]> {
  const response = await get(
    as,
    `/objects?types=document&limit=200&filter=${encodeURIComponent(JSON.stringify(filter))}`,
  )
  expect(response.statusCode, response.body).toBe(200)
  return (response.json().items as Array<{ id: string }>).map((item) => item.id)
}

beforeAll(async () => {
  fx = await setupFixture()
  registrar = await createUser(fx.app, 'registrar_archive', ['employee', 'registrar'])
  clerk = await createUser(fx.app, 'clerk_archive', ['employee'])
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  const typeList = await get(fx.admin, '/document-types')
  for (const item of typeList.json().items as Array<{ id: string; key: string }>) {
    types.set(item.key, item.id)
  }
  const found = await get(registrar, '/correspondents?q=Минфин')
  ministry = found.json().items[0].id
  ministryName = found.json().items[0].name
})

describe('ответ на входящий и отправка исходящего', () => {
  it('ответ наследует корреспондента и гриф, связан «в ответ на»; отправка исполняет исходящий', async () => {
    const incoming = await registeredIncoming({ confidentiality: 'internal' })
    expect(incoming.can.reply).toBe(true)
    // Ответить может тот, кто видит входящее; посторонний — нет
    const denied = await post(clerk, `/documents/${incoming.id}/reply`)
    expect(denied.statusCode).toBe(404)

    const reply = await post(registrar, `/documents/${incoming.id}/reply`)
    expect(reply.statusCode, reply.body).toBe(200)
    const outgoing = await documentOf(registrar, reply.json().id)
    expect(outgoing).toMatchObject({
      status: 'draft',
      subject: incoming.subject,
      correspondent: { id: ministry },
      confidentiality: 'internal',
      type: { key: 'outgoing_letter', direction: 'outgoing' },
    })
    const links = await get(registrar, `/objects/${outgoing.id}/links`)
    expect(
      (links.json().links as Array<{ kind: string; direction: string; object: { id: string } }>)
        .filter((link) => link.kind === 'reply_to')
        .map((link) => [link.direction, link.object.id]),
    ).toEqual([['outgoing', incoming.id]])

    // На исходящий не отвечают; черновик исходящего не отправляется
    expect((await post(registrar, `/documents/${outgoing.id}/reply`)).statusCode).toBe(409)
    const early = await post(registrar, `/documents/${outgoing.id}/dispatches`, {
      correspondentId: ministry,
      method: 'post',
      sentOn: '2026-09-19',
    })
    expect(early.statusCode).toBe(409)

    const registered = await post(registrar, `/documents/${outgoing.id}/register`)
    expect(registered.statusCode, registered.body).toBe(200)
    expect(registered.json().can.dispatch).toBe(true)
    // Отметку об отправке ставит делопроизводитель
    await call(fx.app, {
      method: 'POST',
      url: `/objects/${outgoing.id}/access`,
      as: fx.admin,
      payload: { grants: [{ principal: { type: 'user', id: clerk.id }, level: 'edit' }] },
    })
    const forbidden = await post(clerk, `/documents/${outgoing.id}/dispatches`, {
      correspondentId: ministry,
      method: 'post',
      sentOn: '2026-09-19',
    })
    expect(forbidden.statusCode).toBe(403)

    const sent = await post(registrar, `/documents/${outgoing.id}/dispatches`, {
      correspondentId: ministry,
      method: 'post',
      sentOn: '2026-09-19',
      tracking: 'RR123456789TJ',
    })
    expect(sent.statusCode, sent.body).toBe(200)
    expect(sent.json()).toMatchObject({ status: 'executed', dispatchCount: 1 })
    // Второй адресат — ещё одна отметка, документ остаётся исполненным
    const copy = await post(registrar, `/documents/${outgoing.id}/dispatches`, {
      addressee: 'Хукумат района (копия)',
      method: 'email',
      sentOn: '2026-09-19',
    })
    expect(copy.json()).toMatchObject({ status: 'executed', dispatchCount: 2 })
    // Адресат обязателен: корреспондент или текст
    const noAddressee = await post(registrar, `/documents/${outgoing.id}/dispatches`, {
      method: 'post',
      sentOn: '2026-09-19',
    })
    expect(noAddressee.statusCode).toBe(400)

    const dispatches = await get(registrar, `/documents/${outgoing.id}/dispatches`)
    expect(
      (
        dispatches.json().items as Array<{
          correspondent: { name: string } | null
          addressee: string | null
          tracking: string | null
        }>
      ).map((item) => item.correspondent?.name ?? item.addressee),
    ).toEqual([ministryName, 'Хукумат района (копия)'])
    expect(await auditCount('document.dispatched', outgoing.id)).toBe(2)

    // Цепочка переписки видна с обеих сторон, по датам
    const chain = await get(registrar, `/documents/${incoming.id}/correspondence`)
    expect(chain.statusCode, chain.body).toBe(200)
    const items = chain.json().items as Array<{
      id: string
      current: boolean
      replyToId: string | null
      direction: string
      sentOn: string | null
    }>
    expect(items.map((item) => item.id)).toEqual([incoming.id, outgoing.id])
    expect(items[0]).toMatchObject({ current: true, direction: 'incoming', replyToId: null })
    expect(items[1]).toMatchObject({
      current: false,
      direction: 'outgoing',
      replyToId: incoming.id,
      sentOn: '2026-09-19',
    })

    // Фильтры списка: отправленные, отвеченные входящие, ответы на документ
    expect(await listIds(registrar, { field: 'dispatched', op: 'is_true' })).toContain(outgoing.id)
    expect(await listIds(registrar, { field: 'answered', op: 'is_true' })).toContain(incoming.id)
    expect(await listIds(registrar, { field: 'replyTo', op: 'in', value: [incoming.id] })).toEqual([
      outgoing.id,
    ])
  })

  it('недоступный документ цепочки — без реквизитов', async () => {
    const incoming = await registeredIncoming()
    const reply = await post(registrar, `/documents/${incoming.id}/reply`)
    const outgoingId = reply.json().id as string
    // Сотруднику открыт только ответ — входящее ему не видно
    await call(fx.app, {
      method: 'POST',
      url: `/objects/${outgoingId}/access`,
      as: fx.admin,
      payload: { grants: [{ principal: { type: 'user', id: clerk.id }, level: 'view' }] },
    })
    const chain = await get(clerk, `/documents/${outgoingId}/correspondence`)
    expect(chain.statusCode, chain.body).toBe(200)
    const hidden = (
      chain.json().items as Array<{ id: string; accessible: boolean; subject: string }>
    ).find((item) => item.id === incoming.id)
    expect(hidden).toMatchObject({ accessible: false, subject: '' })
  })
})

describe('номенклатура дел, подшивка и архив', () => {
  it('дело ведёт канцелярия; индекс уникален в году', async () => {
    const forbidden = await post(clerk, '/cases', { index: `X-${run}`, title: 'Чужое', year })
    expect(forbidden.statusCode).toBe(403)
    await createCase(registrar, { index: `01-05-${run}` })
    const duplicate = await post(registrar, '/cases', {
      index: `01-05-${run}`.toUpperCase(),
      title: 'Дубль',
      year,
    })
    expect(duplicate.statusCode).toBe(409)
    // Тот же индекс в другом году — новое дело
    const next = await post(registrar, '/cases', {
      index: `01-05-${run}`,
      title: 'Следующий год',
      year: year + 1,
    })
    expect(next.statusCode, next.body).toBe(200)
    const listed = await get(registrar, `/cases?year=${year}&q=${encodeURIComponent(run)}`)
    expect(listed.json().items.map((item: { index: string }) => item.index)).toContain(
      `01-05-${run}`,
    )
    // Сотрудник без прав канцелярии дел не видит
    const hidden = await get(clerk, `/cases?q=${encodeURIComponent(run)}`)
    expect(hidden.json().items).toEqual([])
  })

  it('подшивка → закрытие → архив: документы дела уходят в архив вместе с ним', async () => {
    const incomingType = types.get('incoming_letter') ?? ''
    const target = await createCase(registrar, {
      index: `02-${run}`,
      title: `Входящая корреспонденция ${run}`,
      documentTypeIds: [incomingType],
    })
    const other = await createCase(registrar, { index: `03-${run}`, title: `Разное ${run}` })
    const incoming = await registeredIncoming()
    expect(incoming.can.file).toBe(true)

    // Дело по типу документа — предлагаемое
    const suggestions = await get(registrar, `/documents/${incoming.id}/cases`)
    expect(suggestions.statusCode, suggestions.body).toBe(200)
    expect(suggestions.json().suggestedId).toBe(target.id)
    expect(suggestions.json().items.map((item: { id: string }) => item.id)).toContain(other.id)

    // Документ на контроле ждёт исполнения; черновик не подшивается
    const onControl = await registeredIncoming({ control: 'on', deadline: '2026-12-31' })
    expect(onControl.can.file).toBe(false)
    const blocked = await post(registrar, `/documents/${onControl.id}/file`, { caseId: target.id })
    expect(blocked.statusCode).toBe(409)
    const memo = await draft(registrar, 'memo')
    expect(
      (await post(registrar, `/documents/${memo.id}/file`, { caseId: target.id })).statusCode,
    ).toBe(409)

    const filed = await post(registrar, `/documents/${incoming.id}/file`, { caseId: target.id })
    expect(filed.statusCode, filed.body).toBe(200)
    expect(filed.json()).toMatchObject({
      status: 'filed',
      case: { id: target.id, index: `02-${run}` },
      can: { file: false, reply: false },
    })
    expect(await auditCount('document.filed', incoming.id)).toBe(1)
    expect(await listIds(registrar, { field: 'caseId', op: 'in', value: [target.id] })).toEqual([
      incoming.id,
    ])

    const record = await get(registrar, `/cases/${target.id}`)
    expect(record.json()).toMatchObject({ documentCount: 1, status: 'open', canFile: true })

    // Открытое дело в архив не передаётся; закрытое — не принимает документы
    expect((await post(registrar, `/cases/${target.id}/archive`)).statusCode).toBe(409)
    const closed = await post(registrar, `/cases/${target.id}/close`)
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json()).toMatchObject({ status: 'closed', canFile: false })
    const late = await registeredIncoming()
    expect(
      (await post(registrar, `/documents/${late.id}/file`, { caseId: target.id })).statusCode,
    ).toBe(409)
    // Вернуть в работу и снова закрыть
    expect((await post(registrar, `/cases/${target.id}/reopen`)).json().status).toBe('open')
    expect((await post(registrar, `/cases/${target.id}/close`)).json().status).toBe('closed')

    const archived = await post(registrar, `/cases/${target.id}/archive`)
    expect(archived.statusCode, archived.body).toBe(200)
    expect(archived.json()).toMatchObject({ status: 'archived', canManage: true })
    expect((await documentOf(registrar, incoming.id)).status).toBe('archived')
    expect(await auditCount('case.archived', target.id)).toBe(1)

    // Общий архив объектов для дела закрыт — только «Передать в архив»
    const generic = await post(fx.admin, `/objects/${other.id}/archive`)
    expect(generic.statusCode).toBe(409)

    // Поиск в архиве — общий поиск с фильтром статуса
    await indexObject(incoming.id)
    const deadline = Date.now() + 10_000
    let found: string[] = []
    while (Date.now() < deadline) {
      const response = await get(
        registrar,
        `/search?q=${encodeURIComponent(`паводковой ${run}`)}&statuses=archived`,
      )
      expect(response.statusCode, response.body).toBe(200)
      found = (response.json().hits as Array<{ objectId: string }>).map((hit) => hit.objectId)
      if (found.includes(incoming.id)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(found).toContain(incoming.id)
    const live = await get(
      registrar,
      `/search?q=${encodeURIComponent(`паводковой ${run}`)}&statuses=registered`,
    )
    expect(
      (live.json().hits as Array<{ objectId: string }>).map((hit) => hit.objectId),
    ).not.toContain(incoming.id)
  })

  it('закрытие дел года: закрываются открытые дела, которые ведёт пользователь', async () => {
    const caseYear = year - 3
    const a = await createCase(registrar, { index: `10-${run}`, year: caseYear })
    const b = await createCase(registrar, { index: `11-${run}`, year: caseYear })
    const closed = await post(registrar, '/cases/close-year', { year: caseYear })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json().closed).toBeGreaterThanOrEqual(2)
    for (const item of [a, b]) {
      expect((await get(registrar, `/cases/${item.id}`)).json().status).toBe('closed')
    }
  })

  it('акт о выделении к уничтожению: файлы удалены, карточка осталась описью', async () => {
    const old = await createCase(registrar, {
      index: `20-${run}`,
      title: `Старая переписка ${run}`,
      year: year - 6,
      retentionYears: 1,
    })
    expect(old.destroyableFrom).toBe(`${year - 4}-01-01`)
    const fresh = await createCase(registrar, { index: `21-${run}`, retentionYears: 10 })
    const incoming = await registeredIncoming()
    const scanId = incoming.currentVersion?.mainFile?.id ?? ''
    expect(scanId).not.toBe('')
    for (const item of [old, fresh]) {
      const doc = item === old ? incoming : await registeredIncoming()
      expect(
        (await post(registrar, `/documents/${doc.id}/file`, { caseId: item.id })).statusCode,
      ).toBe(200)
      await post(registrar, `/cases/${item.id}/close`)
      await post(registrar, `/cases/${item.id}/archive`)
    }

    // Срок хранения свежего дела не истёк — акт не составляется
    const early = await post(registrar, '/cases/destruction-acts', {
      caseIds: [fresh.id],
      basis: 'Протокол экспертной комиссии № 3',
    })
    expect(early.statusCode).toBe(409)
    // Только канцелярия и с основанием
    expect(
      (
        await post(clerk, '/cases/destruction-acts', {
          caseIds: [old.id],
          basis: 'Протокол экспертной комиссии № 3',
        })
      ).statusCode,
    ).toBe(403)

    const act = await post(registrar, '/cases/destruction-acts', {
      caseIds: [old.id],
      basis: 'Протокол экспертной комиссии № 3',
    })
    expect(act.statusCode, act.body).toBe(200)
    const record = (await get(registrar, `/cases/${old.id}`)).json()
    expect(record).toMatchObject({
      status: 'destroyed',
      canManage: false,
      destructionAct: { number: `1/${year}` },
    })
    // Карточка документа осталась, файлы — нет
    const card = await documentOf(registrar, incoming.id)
    expect(card).toMatchObject({ status: 'archived', currentVersion: { mainFile: null } })
    expect(card.filesDestroyedAt).not.toBeNull()
    expect((await get(fx.admin, `/objects/${scanId}`)).statusCode).toBe(404)
    // Содержимое удаляет задание, поставленное в той же транзакции
    const [job] = await db().execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM jobs WHERE name = 'files.delete-stored'`,
    )
    expect(job?.total).toBeGreaterThanOrEqual(1)
    expect(await auditCount('case.destroyed', old.id)).toBe(1)
    const acts = await get(registrar, '/cases/destruction-acts')
    expect(acts.json().items[0]).toMatchObject({
      number: `1/${year}`,
      documentCount: 1,
      fileCount: 1,
    })
    // Повторно уничтожить нельзя
    const again = await post(registrar, '/cases/destruction-acts', {
      caseIds: [old.id],
      basis: 'Протокол экспертной комиссии № 4',
    })
    expect(again.statusCode).toBe(409)
  })

  it('пустое открытое дело удаляется, дело с документами — нет', async () => {
    const empty = await createCase(registrar, { index: `30-${run}` })
    const trash = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${empty.id}`,
      as: fx.admin,
    })
    expect(trash.statusCode, trash.body).toBe(200)
    const busy = await createCase(registrar, { index: `31-${run}` })
    const doc = await registeredIncoming()
    await post(registrar, `/documents/${doc.id}/file`, { caseId: busy.id })
    const refused = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${busy.id}`,
      as: fx.admin,
    })
    expect(refused.statusCode).toBe(409)
  })
})

describe('канцелярия и демо-данные', () => {
  it('показатели и дашборд «Канцелярия» — идемпотентно; плитки считаются без ошибок', async () => {
    const first = await db().transaction((tx) =>
      DocumentsSeed.ensureOfficeDashboard(tx, systemCtx('test'), fx.orgSpaceId),
    )
    expect(first.created).toContain('documents.office')
    const again = await db().transaction((tx) =>
      DocumentsSeed.ensureOfficeDashboard(tx, systemCtx('test'), fx.orgSpaceId),
    )
    expect(again).toEqual({ dashboardId: first.dashboardId, created: [] })

    const office = await get(fx.admin, '/documents/office')
    expect(office.json().dashboardId).toBe(first.dashboardId)
    const data = await post(fx.admin, `/dashboards/${first.dashboardId}/data`, { filters: {} })
    expect(data.statusCode, data.body).toBe(200)
    const tiles = data.json().tiles as Record<
      string,
      { error: string | null; message: string | null }
    >
    for (const [id, tile] of Object.entries(tiles)) {
      expect({ id, error: tile.error, message: tile.message }).toEqual({
        id,
        error: null,
        message: null,
      })
    }
  })

  it('счётчики навигатора: к отправке, на контроле, просроченные', async () => {
    const summary = await get(registrar, '/documents/summary')
    expect(summary.statusCode, summary.body).toBe(200)
    expect(summary.json()).toMatchObject({
      toDispatch: expect.any(Number),
      approval: expect.any(Number),
      controlOverdue: expect.any(Number),
    })
  })

  it('демо-документы сида: около двухсот, все статусы, дела по годам; повтор ничего не добавляет', async () => {
    const heads = await Promise.all(
      [1, 2, 3].map((index) => createUser(fx.app, `demo_head_${index}_${run}`, ['employee'])),
    )
    const staff = await Promise.all(
      [1, 2, 3, 4].map((index) => createUser(fx.app, `demo_staff_${index}_${run}`, ['employee'])),
    )
    const people = {
      registrars: [{ id: registrar.id, unitId: null }],
      heads: heads.map((user) => ({ id: user.id, unitId: fx.unitId })),
      staff: staff.map((user) => ({ id: user.id, unitId: fx.unitId })),
      officeUnitId: fx.unitId,
    }
    const seeded = await DocumentsSeed.seedDemoDocuments(people)
    expect(seeded.skipped).toBe(false)
    expect(seeded.documents).toBeGreaterThanOrEqual(180)
    expect(seeded.documents).toBeLessThanOrEqual(230)

    const statuses = await db().execute<{ status: string; total: number }>(
      sql`SELECT d.status, count(*)::int AS total FROM documents d JOIN objects o ON o.id = d.id
           WHERE o.meta ? 'demoKey' GROUP BY d.status`,
    )
    const byStatus = Object.fromEntries(statuses.map((row) => [row.status, row.total]))
    for (const status of ['draft', 'registered', 'executed', 'filed', 'archived', 'cancelled']) {
      expect(byStatus[status] ?? 0, status).toBeGreaterThan(0)
    }
    // Ответы связаны «в ответ на», исходящие отправлены
    const [replies] = await db().execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM links l JOIN objects o ON o.id = l.source_id
           WHERE l.kind = 'reply_to' AND o.meta ? 'demoKey'`,
    )
    expect(replies?.total).toBeGreaterThan(20)
    const [sent] = await db().execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM document_dispatches`,
    )
    expect(sent?.total).toBeGreaterThan(10)
    // Дела прошлого года — в архиве; старое дело записок готово к уничтожению
    const pastCases = await get(registrar, `/cases?year=${year - 1}`)
    const past = pastCases.json().items as Array<{ status: string; documentCount: number }>
    expect(past.length).toBeGreaterThan(0)
    expect(past.every((item) => item.status === 'archived')).toBe(true)
    const oldCases = await get(registrar, `/cases?year=${year - 5}`)
    expect(
      (oldCases.json().items as Array<{ destroyableFrom: string | null }>).some(
        (item) => item.destroyableFrom !== null,
      ),
    ).toBe(true)

    const repeat = await DocumentsSeed.seedDemoDocuments(people)
    expect(repeat).toEqual({ documents: 0, cases: 0, skipped: true })
  }, 180_000)
})
