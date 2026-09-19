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
 * Ядро документооборота (P3-E02 S01/S03/S07/S10/S12, ADR-0080): типы и журналы
 * стартового набора, черновик по типу, карточка по схеме типа, регистрация
 * входящего со сканом и номером из журнала, резерв номеров, аннулирование,
 * версии и PDF-представление, участники, корреспонденты, системный датасет.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { systemCtx } = await import('../src/shared/context.js')

const token = process.env.INTERNAL_SERVICE_TOKEN ?? ''
const run = Date.now().toString(36)

let fx: TestContext
let registrar: TestUser
let registrar2: TestUser
const types = new Map<string, string>()
const journals = new Map<string, string>()
let ministry = ''

interface DocumentBody {
  id: string
  spaceId: string
  status: string
  regNumber: string | null
  registration: { journalName: string; number: string; sequence: number } | null
  can: Record<string, boolean>
  currentVersion: {
    id: string
    mainFile: { id: string } | null
    pdfFile: { id: string } | null
    pdfStatus: string
    hash: string | null
  } | null
  responsible: { id: string } | null
  confidentiality: string
  fields: Record<string, unknown>
  cancelReason: string | null
}

async function createDraft(
  as: TestUser,
  typeKey: string,
  extra: Record<string, unknown> = {},
): Promise<DocumentBody> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/documents',
    as,
    payload: { typeId: types.get(typeKey), subject: `Документ ${run}`, ...extra },
  })
  expect(created.statusCode, created.body).toBe(200)
  return getDocument(as, created.json().id)
}

async function getDocument(as: TestUser, id: string): Promise<DocumentBody> {
  const response = await call(fx.app, { url: `/documents/${id}`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

/** Скан — вложение документа, затем версия с ним основным файлом. */
async function attachScan(
  as: TestUser,
  doc: DocumentBody,
  file: { name?: string; mime?: string; content?: string } = {},
) {
  const uploaded = await uploadFile(fx.app, as, {
    spaceId: doc.spaceId,
    name: file.name ?? `скан-${run}.pdf`,
    mime: file.mime ?? 'application/pdf',
    content: file.content ?? '%PDF-1.4 скан входящего письма',
    attachToObjectId: doc.id,
  })
  const version = await call(fx.app, {
    method: 'POST',
    url: `/documents/${doc.id}/versions`,
    as,
    payload: { mainFileId: uploaded.id },
  })
  expect(version.statusCode, version.body).toBe(200)
  return { fileId: uploaded.id, version: version.json() }
}

const register = (as: TestUser, id: string, payload: Record<string, unknown> = {}) =>
  call(fx.app, { method: 'POST', url: `/documents/${id}/register`, as, payload })

const share = (id: string, user: TestUser, level: string, as: TestUser = fx.admin) =>
  call(fx.app, {
    method: 'POST',
    url: `/objects/${id}/access`,
    as,
    payload: { grants: [{ principal: { type: 'user', id: user.id }, level }] },
  })

async function incomingReady(extra: Record<string, unknown> = {}): Promise<DocumentBody> {
  const doc = await createDraft(registrar, 'incoming_letter', {
    correspondentId: ministry,
    receivedDate: '2026-09-18',
    externalNumber: `01-02/${run}`,
    externalDate: '2026-09-15',
    deliveryMethod: 'post',
    ...extra,
  })
  await attachScan(registrar, doc)
  return doc
}

beforeAll(async () => {
  fx = await setupFixture()
  registrar = await createUser(fx.app, 'registrar_docs', ['employee', 'registrar'])
  registrar2 = await createUser(fx.app, 'registrar_docs2', ['employee', 'registrar'])
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  const typeList = await call(fx.app, { url: '/document-types', as: fx.admin })
  for (const item of typeList.json().items as Array<{ id: string; key: string }>) {
    types.set(item.key, item.id)
  }
  const journalList = await call(fx.app, { url: '/journals', as: fx.admin })
  for (const item of journalList.json().items as Array<{ id: string; name: string }>) {
    journals.set(item.name, item.id)
  }
  const found = await call(fx.app, { url: '/correspondents?q=Минфин', as: registrar })
  ministry = found.json().items[0].id
})

describe('справочники стартового набора', () => {
  it('журналы и типы — идемпотентно; типы видит каждый, журналы — делопроизводители', async () => {
    const again = await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
    expect(again).toEqual({ journals: 0, types: 0, correspondents: 0 })
    expect(types.size).toBe(11)

    const employeeTypes = await call(fx.app, { url: '/document-types', as: fx.users.member })
    expect(employeeTypes.statusCode, employeeTypes.body).toBe(200)
    const incoming = (
      employeeTypes.json().items as Array<{ key: string; journalName: string; canManage: boolean }>
    ).find((item) => item.key === 'incoming_letter')
    expect(incoming).toMatchObject({ journalName: 'Входящие', canManage: false })

    const employeeJournals = await call(fx.app, { url: '/journals', as: fx.users.member })
    expect(employeeJournals.json().items).toEqual([])
    const registrarJournals = await call(fx.app, { url: '/journals', as: registrar })
    const items = registrarJournals.json().items as Array<{
      name: string
      canRegister: boolean
      canManage: boolean
      nextNumber: string
    }>
    expect(items).toHaveLength(7)
    const inbound = items.find((item) => item.name === 'Входящие')
    // Роль «Делопроизводитель» ведёт и журналы (documents.journals.manage)
    expect(inbound).toMatchObject({ canRegister: true, canManage: true })
    expect(inbound?.nextNumber).toMatch(/^ВХ-0001\/\d{2}$/)
    const adminJournals = await call(fx.app, { url: '/journals', as: fx.admin })
    expect(
      (adminJournals.json().items as Array<{ canManage: boolean }>).every((j) => j.canManage),
    ).toBe(true)
  })
})

describe('регистрация входящего', () => {
  it('черновик → скан → номер из журнала → registered, документ в журнале', async () => {
    const doc = await incomingReady()
    expect(doc.status).toBe('draft')
    expect(doc.can.register).toBe(true)

    const registered = await register(registrar, doc.id)
    expect(registered.statusCode, registered.body).toBe(200)
    const body = registered.json() as DocumentBody
    expect(body.status).toBe('registered')
    expect(body.regNumber).toMatch(/^ВХ-0001\/\d{2}$/)
    expect(body.registration).toMatchObject({ journalName: 'Входящие', sequence: 1 })
    expect(body.can.register).toBe(false)

    const object = await call(fx.app, { url: `/objects/${doc.id}`, as: registrar })
    expect(object.json().breadcrumbs.map((b: { title: string }) => b.title)).toContain('Входящие')
    expect(object.json().subtitle).toBe(body.regNumber)

    const again = await register(registrar, doc.id)
    expect(again.statusCode).toBe(409)
  })

  it('без реквизитов и без скана — 400 с полями', async () => {
    const bare = await createDraft(registrar, 'incoming_letter')
    const missing = await register(registrar, bare.id)
    expect(missing.statusCode).toBe(400)
    const paths = (missing.json().errors as Array<{ path: string }>).map((issue) => issue.path)
    expect(paths).toEqual(expect.arrayContaining(['correspondentId', 'receivedDate']))

    const noScan = await createDraft(registrar, 'incoming_letter', {
      correspondentId: ministry,
      receivedDate: '2026-09-18',
    })
    const scanless = await register(registrar, noScan.id)
    expect(scanless.statusCode).toBe(400)
    expect(scanless.json().errors[0].message).toBe('scan_required')
  })

  it('параллельная регистрация: номера без пропусков и повторов', async () => {
    const drafts = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        createDraft(registrar, 'memo', { subject: `Параллельная ${index} ${run}` }),
      ),
    )
    const responses = await Promise.all(drafts.map((doc) => register(registrar, doc.id)))
    for (const response of responses) expect(response.statusCode, response.body).toBe(200)
    const sequences = responses
      .map((response) => (response.json() as DocumentBody).registration?.sequence ?? 0)
      .sort((a, b) => a - b)
    expect(new Set(sequences).size).toBe(6)
    expect(sequences[5]! - sequences[0]!).toBe(5)
  })

  it('резерв номеров: бумажный документ получает номер из резерва', async () => {
    const internal = journals.get('Внутренние')!
    const reserved = await call(fx.app, {
      method: 'POST',
      url: `/journals/${internal}/reservations`,
      as: registrar,
      payload: { count: 2, note: 'Для бумажных приказов по кадрам' },
    })
    expect(reserved.statusCode, reserved.body).toBe(200)
    const [first, second] = reserved.json().items as Array<{ id: string; number: string }>
    expect(first?.number).toMatch(/^ВН-\d{4}\/\d{2}$/)

    const paper = await createDraft(registrar, 'memo', { subject: `Бумажный ${run}` })
    const registered = await register(registrar, paper.id, { reservationId: first!.id })
    expect(registered.statusCode, registered.body).toBe(200)
    expect(registered.json().regNumber).toBe(first!.number)

    const cancelled = await call(fx.app, {
      method: 'DELETE',
      url: `/journals/${internal}/reservations/${second!.id}`,
      as: registrar,
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    const other = await createDraft(registrar, 'memo')
    const reuse = await register(registrar, other.id, { reservationId: second!.id })
    expect(reuse.statusCode).toBe(409)

    const list = await call(fx.app, {
      url: `/journals/${internal}/reservations`,
      as: registrar,
    })
    const states = Object.fromEntries(
      (list.json().items as Array<{ id: string; state: string }>).map((r) => [r.id, r.state]),
    )
    expect(states[first!.id]).toBe('used')
    expect(states[second!.id]).toBe('cancelled')
    // Резерв брал номера из того же счётчика: следующий номер — после резерва
    const journal = await call(fx.app, { url: `/journals/${internal}`, as: registrar })
    expect(journal.json().openReservations).toBe(0)
  })
})

describe('права: регистрация, журнал, участники', () => {
  it('сотрудник без способности создаёт служебную записку, но не регистрирует', async () => {
    const memo = await createDraft(fx.users.member, 'memo', { subject: `Записка ${run}` })
    expect(memo.can.register).toBe(false)
    const denied = await register(fx.users.member, memo.id)
    expect(denied.statusCode).toBe(403)
    const correspondent = await call(fx.app, {
      method: 'POST',
      url: '/correspondents',
      as: fx.users.member,
      payload: { name: `ООО «Ромашка» ${run}` },
    })
    expect(correspondent.statusCode).toBe(403)

    // Автор передаёт записку делопроизводителю — тот регистрирует; после регистрации
    // её видят все делопроизводители журнала по наследованию, посторонний — нет
    expect((await share(memo.id, registrar, 'edit', fx.users.member)).statusCode).toBe(200)
    const registered = await register(registrar, memo.id)
    expect(registered.statusCode, registered.body).toBe(200)
    expect((await call(fx.app, { url: `/documents/${memo.id}`, as: registrar2 })).statusCode).toBe(
      200,
    )
    expect(
      (await call(fx.app, { url: `/documents/${memo.id}`, as: fx.users.stranger })).statusCode,
    ).toBe(404)

    const listed = await call(fx.app, {
      url: `/objects?type=document&q=${encodeURIComponent(`Записка ${run}`)}`,
      as: registrar2,
    })
    expect(listed.json().items.map((item: { id: string }) => item.id)).toContain(memo.id)
  })

  it('ответственный видит и обсуждает документ; смена ответственного снимает доступ', async () => {
    const doc = await createDraft(registrar, 'memo', { responsibleId: fx.users.member.id })
    const seen = await getDocument(fx.users.member, doc.id)
    expect(seen.responsible?.id).toBe(fx.users.member.id)
    expect(seen.can.edit).toBe(false)

    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/documents/${doc.id}`,
      as: registrar,
      payload: { responsibleId: fx.users.viewer.id },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(
      (await call(fx.app, { url: `/documents/${doc.id}`, as: fx.users.member })).statusCode,
    ).toBe(404)
    expect(
      (await call(fx.app, { url: `/documents/${doc.id}`, as: fx.users.viewer })).statusCode,
    ).toBe(200)
  })

  it('гриф: только из допустимых типом и не строже допуска автора', async () => {
    const aboveClearance = await call(fx.app, {
      method: 'POST',
      url: '/documents',
      as: registrar,
      payload: { typeId: types.get('memo'), confidentiality: 'confidential' },
    })
    expect(aboveClearance.statusCode).toBe(400)
    expect(aboveClearance.json().errors[0].message).toBe('above_clearance')
    const notAllowed = await call(fx.app, {
      method: 'POST',
      url: '/documents',
      as: fx.admin,
      payload: { typeId: types.get('memo'), confidentiality: 'secret' },
    })
    expect(notAllowed.statusCode).toBe(400)
    expect(notAllowed.json().errors[0].message).toBe('not_allowed')
  })
})

describe('карточка и жизненный цикл', () => {
  it('поля карточки проверяются схемой типа; неизвестные ключи отбрасываются', async () => {
    const wrong = await call(fx.app, {
      method: 'POST',
      url: '/documents',
      as: fx.users.member,
      payload: { typeId: types.get('contract'), fields: { amount: 'много' } },
    })
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().errors[0].path).toBe('fields.amount')

    const doc = await createDraft(fx.users.member, 'contract', {
      fields: { amount: 125000.5, valid_until: '2027-12-31', lost: 'x' },
    })
    expect(doc.fields).toEqual({ amount: 125000.5, valid_until: '2027-12-31' })
  })

  it('аннулирование: черновик — автором, зарегистрированный — делопроизводителем', async () => {
    const draft = await createDraft(fx.users.member, 'memo')
    const short = await call(fx.app, {
      method: 'POST',
      url: `/documents/${draft.id}/cancel`,
      as: fx.users.member,
      payload: { reason: 'нет' },
    })
    expect(short.statusCode).toBe(400)
    const cancelled = await call(fx.app, {
      method: 'POST',
      url: `/documents/${draft.id}/cancel`,
      as: fx.users.member,
      payload: { reason: 'Создан по ошибке' },
    })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    expect(cancelled.json()).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Создан по ошибке',
    })

    const doc = await incomingReady({ responsibleId: fx.users.member.id })
    expect((await register(registrar, doc.id)).statusCode).toBe(200)
    const byResponsible = await call(fx.app, {
      method: 'POST',
      url: `/documents/${doc.id}/cancel`,
      as: fx.users.member,
      payload: { reason: 'Отзыв регистрации' },
    })
    expect(byResponsible.statusCode).toBe(403)
    const byRegistrar = await call(fx.app, {
      method: 'POST',
      url: `/documents/${doc.id}/cancel`,
      as: registrar,
      payload: { reason: 'Зарегистрирован дважды — акт от 19.09' },
    })
    expect(byRegistrar.statusCode, byRegistrar.body).toBe(200)
    expect(byRegistrar.json().status).toBe('cancelled')
    const twice = await call(fx.app, {
      method: 'POST',
      url: `/documents/${doc.id}/cancel`,
      as: registrar,
      payload: { reason: 'Ещё раз для проверки' },
    })
    expect(twice.statusCode).toBe(409)

    const [row] = await db().execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM audit_log
           WHERE object_id = ${doc.id} AND action = 'document.cancelled'`,
    )
    expect(row?.total).toBe(1)
  })

  it('удаление зарегистрированного, общий архив и общий PATCH недоступны', async () => {
    const doc = await incomingReady()
    expect((await register(registrar, doc.id)).statusCode).toBe(200)
    const trash = await call(fx.app, { method: 'DELETE', url: `/objects/${doc.id}`, as: fx.admin })
    expect(trash.statusCode).toBe(409)
    const archive = await call(fx.app, {
      method: 'POST',
      url: `/objects/${doc.id}/archive`,
      as: fx.admin,
    })
    expect(archive.statusCode).toBe(409)
    const patch = await call(fx.app, {
      method: 'PATCH',
      url: `/objects/${doc.id}`,
      as: fx.admin,
      payload: { title: 'в обход карточки' },
    })
    expect(patch.statusCode).toBe(400)
    // Черновик автор удаляет как любой объект
    const draft = await createDraft(fx.users.member, 'memo')
    const removed = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${draft.id}`,
      as: fx.users.member,
    })
    expect(removed.statusCode, removed.body).toBe(200)
  })
})

describe('версии и PDF-представление', () => {
  it('PDF — сам основной файл; хэш сообщает движок', async () => {
    const doc = await createDraft(registrar, 'incoming_letter')
    const { fileId, version } = await attachScan(registrar, doc)
    expect(version).toMatchObject({ number: 1, pdfStatus: 'ready' })
    expect(version.pdfFile.id).toBe(fileId)

    const hash = 'a'.repeat(64)
    const reported = await call(fx.app, {
      method: 'POST',
      url: `/internal/documents/versions/${version.id}/pdf`,
      headers: { 'x-kchs-service-token': token },
      payload: { status: 'skipped', sha256: hash },
    })
    expect(reported.statusCode, reported.body).toBe(200)
    expect((await getDocument(registrar, doc.id)).currentVersion?.hash).toBe(hash)
  })

  it('DOCX → задание движка; PDF принимается только под своим ключом', async () => {
    const doc = await createDraft(registrar, 'outgoing_letter')
    const { version } = await attachScan(registrar, doc, {
      name: `Ответ-${run}.docx`,
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: 'PK docx',
    })
    expect(version.pdfStatus).toBe('pending')
    const [job] = await db().execute<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM jobs WHERE name = 'document.pdf' AND idempotency_key = ${`document.pdf:${version.id}`}`,
    )
    const target = job?.payload.target as { fileId: string; versionId: string; storageKey: string }
    expect(target.storageKey).toContain(`/files/${target.fileId}/${target.versionId}/`)
    expect(target.storageKey.endsWith('.pdf')).toBe(true)

    const noToken = await call(fx.app, {
      method: 'POST',
      url: `/internal/documents/versions/${version.id}/pdf`,
      payload: { status: 'ready' },
    })
    expect(noToken.statusCode).toBe(401)
    const foreign = await call(fx.app, {
      method: 'POST',
      url: `/internal/documents/versions/${version.id}/pdf`,
      headers: { 'x-kchs-service-token': token },
      payload: {
        status: 'ready',
        pdfFileId: target.fileId,
        pdfVersionId: target.versionId,
        storageKey: 'spaces/other/files/x/y/evil.pdf',
        size: 10,
      },
    })
    expect(foreign.statusCode).toBe(400)

    const ready = await call(fx.app, {
      method: 'POST',
      url: `/internal/documents/versions/${version.id}/pdf`,
      headers: { 'x-kchs-service-token': token },
      payload: {
        status: 'ready',
        sha256: 'b'.repeat(64),
        pdfFileId: target.fileId,
        pdfVersionId: target.versionId,
        storageKey: target.storageKey,
        size: 2048,
        pages: 2,
      },
    })
    expect(ready.statusCode, ready.body).toBe(200)
    const current = (await getDocument(registrar, doc.id)).currentVersion
    expect(current).toMatchObject({ pdfStatus: 'ready', hash: 'b'.repeat(64) })
    expect(current?.pdfFile?.id).toBe(target.fileId)
    // PDF-представление — вложение документа: читает тот, кто видит документ
    expect((await call(fx.app, { url: `/files/${target.fileId}`, as: registrar })).statusCode).toBe(
      200,
    )
    expect(
      (await call(fx.app, { url: `/files/${target.fileId}`, as: fx.users.stranger })).statusCode,
    ).toBe(404)
  })

  it('файл версии должен быть прикреплён к документу', async () => {
    const doc = await createDraft(registrar, 'memo')
    const loose = await uploadFile(fx.app, fx.admin, {
      spaceId: fx.spaceId,
      name: 'чужой.pdf',
      content: '%PDF',
      mime: 'application/pdf',
    })
    const response = await call(fx.app, {
      method: 'POST',
      url: `/documents/${doc.id}/versions`,
      as: registrar,
      payload: { mainFileId: loose.id },
    })
    expect(response.statusCode).toBe(400)
  })
})

describe('справочники: типы, журналы, корреспонденты', () => {
  it('тип документа: создаёт ведущий справочники, ключ уникален, сотрудник не правит', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/document-types',
      as: fx.admin,
      payload: {
        key: `act_${run}`,
        name: { ru: 'Акт' },
        direction: 'internal',
        cardSchema: {
          fields: [{ key: 'place', label: { ru: 'Место составления' }, type: 'text' }],
        },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const duplicate = await call(fx.app, {
      method: 'POST',
      url: '/document-types',
      as: fx.admin,
      payload: { key: `act_${run}`, name: { ru: 'Акт' }, direction: 'internal' },
    })
    expect(duplicate.statusCode).toBe(409)
    const dupFields = await call(fx.app, {
      method: 'PATCH',
      url: `/document-types/${created.json().id}`,
      as: fx.admin,
      payload: {
        cardSchema: {
          fields: [
            { key: 'a', label: { ru: 'А' }, type: 'text' },
            { key: 'a', label: { ru: 'Б' }, type: 'text' },
          ],
        },
      },
    })
    expect(dupFields.statusCode).toBe(400)
    const byEmployee = await call(fx.app, {
      method: 'PATCH',
      url: `/document-types/${created.json().id}`,
      as: fx.users.member,
      payload: { name: { ru: 'Акт сотрудника' } },
    })
    expect(byEmployee.statusCode).toBe(403)
  })

  it('журнал: шаблон номера проверяется, следующий номер — по шаблону', async () => {
    const bad = await call(fx.app, {
      method: 'POST',
      url: '/journals',
      as: fx.admin,
      payload: { name: `Приёмная ${run}`, format: '{prefix}/{yy}' },
    })
    expect(bad.statusCode).toBe(400)
    const created = await call(fx.app, {
      method: 'POST',
      url: '/journals',
      as: fx.admin,
      payload: { name: `Приёмная ${run}`, prefix: 'ПРМ', format: '{seq}-{prefix}', reset: 'never' },
    })
    expect(created.statusCode, created.body).toBe(200)
    expect(created.json().nextNumber).toBe('1-ПРМ')
    const byEmployee = await call(fx.app, {
      method: 'POST',
      url: '/journals',
      as: fx.users.member,
      payload: { name: `Чужой ${run}` },
    })
    expect(byEmployee.statusCode).toBe(403)
  })

  it('корреспонденты: заводит делопроизводитель, видят все, число документов — видимых', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/correspondents',
      as: registrar,
      payload: {
        kind: 'organization',
        name: `ГУП «Водоканал» ${run}`,
        details: { shortName: `Водоканал ${run}`, taxId: '0123456789' },
        contacts: { phone: '+992 37 221-00-00' },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string
    const found = await call(fx.app, {
      url: `/correspondents?q=${encodeURIComponent(`Водоканал ${run}`)}`,
      as: fx.users.member,
    })
    expect(found.json().items.map((item: { id: string }) => item.id)).toEqual([id])
    expect(found.json().items[0].canEdit).toBe(false)
    const renamed = await call(fx.app, {
      method: 'PATCH',
      url: `/correspondents/${id}`,
      as: registrar,
      payload: { name: `ГУП «Водоканал Душанбе» ${run}` },
    })
    expect(renamed.statusCode, renamed.body).toBe(200)

    const doc = await incomingReady({ correspondentId: id })
    expect((await register(registrar, doc.id)).statusCode).toBe(200)
    const forRegistrar = await call(fx.app, { url: `/correspondents/${id}`, as: registrar })
    expect(forRegistrar.json().documentCount).toBe(1)
    const forEmployee = await call(fx.app, { url: `/correspondents/${id}`, as: fx.users.member })
    expect(forEmployee.json().documentCount).toBe(0)
  })
})

describe('списки и системный датасет', () => {
  it('список объектов документов: фильтр по статусу, поля фильтров', async () => {
    const fields = await call(fx.app, { url: '/objects/fields?types=document', as: registrar })
    const status = (
      fields.json().items as Array<{ key: string; options?: Array<{ value: string }> }>
    ).find((item) => item.key === 'status')
    expect(status?.options?.map((option) => option.value)).toContain('registered')

    const filter = encodeURIComponent(
      JSON.stringify({ field: 'status', op: 'in', value: ['registered'] }),
    )
    const list = await call(fx.app, {
      url: `/objects?type=document&filter=${filter}&sort=regDate:desc&limit=100`,
      as: registrar,
    })
    expect(list.statusCode, list.body).toBe(200)
    const items = list.json().items as Array<{ meta: Record<string, unknown> }>
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.meta.status === 'registered')).toBe(true)
    expect(items[0]?.meta).toMatchObject({ typeName: expect.any(Object) })

    const summary = await call(fx.app, { url: '/documents/summary', as: registrar })
    expect(summary.statusCode, summary.body).toBe(200)
    expect(summary.json()).toMatchObject({ mine: expect.any(Number), drafts: expect.any(Number) })
  })

  it('системный датасет documents: строки по правам, служебные столбцы скрыты', async () => {
    const query = (as: TestUser) =>
      call(fx.app, {
        method: 'POST',
        url: '/queries/run',
        as,
        payload: { spec: { version: 1, source: { kind: 'system', name: 'documents' }, steps: [] } },
      })
    const forRegistrar = await query(registrar)
    expect(forRegistrar.statusCode, forRegistrar.body).toBe(200)
    const names = forRegistrar.json().fields.map((field: { name: string }) => field.name)
    expect(names).toEqual(
      expect.arrayContaining(['reg_number', 'status', 'journal_name', 'overdue', 'deadline']),
    )
    expect(names).not.toContain('viewers')
    expect(names).not.toContain('grif_rank')
    expect(forRegistrar.json().rows.length).toBeGreaterThan(5)
    const forStranger = await query(fx.users.stranger)
    expect(forStranger.json().rows).toEqual([])
  })
})
