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
 * Номер «подразделение-дело/номер» (N12, ADR-0134): индекс дела по номенклатуре идёт в
 * номер; дело подбирается по типу и подразделению документа, выбирается явно или не
 * выбирается — тогда подстановка берёт префикс журнала. Подшивка предлагает дело из номера.
 */
registerLifecycle()

const { OrgService } = await import('../src/modules/identity/public.js')
const { systemCtx } = await import('../src/shared/context.js')

const run = Date.now().toString(36)
const year = Number(
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dushanbe' }).format(new Date()).slice(0, 4),
)

let fx: TestContext
let registrar: TestUser
let unitId = ''
let typeId = ''
let otherTypeId = ''
let journalId = ''
const caseIds = new Map<string, string>()

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

const get = (url: string) => call(fx.app, { url, as: registrar })
const post = (url: string, payload: Record<string, unknown> = {}) =>
  call(fx.app, { method: 'POST', url, as: registrar, payload })

async function createCase(index: string, extra: Record<string, unknown> = {}): Promise<string> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/cases',
    as: fx.admin,
    payload: {
      index,
      title: `Дело ${index} ${run}`,
      year,
      unitId,
      documentTypeIds: [typeId],
      ...extra,
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  return created.json().id as string
}

async function draft(type = typeId): Promise<Json> {
  const created = await post('/documents', {
    typeId: type,
    subject: `Записка ${run}`,
    unitId,
  })
  expect(created.statusCode, created.body).toBe(200)
  return created.json()
}

beforeAll(async () => {
  fx = await setupFixture()
  unitId = await db().transaction((tx) =>
    OrgService.createUnit(tx, systemCtx('test'), {
      code: `N12-${run}`,
      name: { ru: `Оперативное управление ${run}` },
      kind: 'department',
      sort: 0,
      isActive: true,
      createSpace: false,
    }),
  )
  registrar = await createUser(fx.app, `numbering_${run}`, ['employee', 'registrar'], unitId)

  // Свой тип и журнал с номером по умолчанию: другие тесты базы на них не влияют
  const journal = await call(fx.app, {
    method: 'POST',
    url: '/journals',
    as: fx.admin,
    payload: { name: `Внутренние ${run}`, prefix: `ВН${run.slice(-3)}` },
  })
  expect(journal.statusCode, journal.body).toBe(200)
  journalId = journal.json().id
  expect(journal.json().format).toBe('{case.index}/{seq}')
  for (const [key, name] of [
    [`memo_${run}`, `Записка ${run}`],
    [`note_${run}`, `Справка ${run}`],
  ] as const) {
    const type = await call(fx.app, {
      method: 'POST',
      url: '/document-types',
      as: fx.admin,
      payload: {
        key,
        name: { ru: name },
        direction: 'internal',
        numbering: { journalId, format: null },
      },
    })
    expect(type.statusCode, type.body).toBe(200)
    if (key.startsWith('memo')) typeId = type.json().id
    else otherTypeId = type.json().id
  }
  caseIds.set('03-12', await createCase(`03-12-${run}`))
  caseIds.set('03-14', await createCase(`03-14-${run}`, { documentTypeIds: [otherTypeId] }))
}, 120_000)

describe('номер «подразделение-дело/номер»', () => {
  it('дело подбирается по типу и подразделению и видно в предпросмотре и номере', async () => {
    const doc = await draft()
    const suggestions = await get(`/documents/${doc.id}/cases?purpose=registration`)
    expect(suggestions.statusCode, suggestions.body).toBe(200)
    expect(suggestions.json().suggestedId).toBe(caseIds.get('03-12'))

    const preview = await get(`/documents/${doc.id}/number-preview?journalId=${journalId}`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({
      usesCase: true,
      caseId: caseIds.get('03-12'),
      number: `03-12-${run}/1`,
    })

    const registered = await post(`/documents/${doc.id}/register`, { journalId })
    expect(registered.statusCode, registered.body).toBe(200)
    expect(registered.json().regNumber).toBe(`03-12-${run}/1`)
    expect(registered.json().registrationCase).toMatchObject({ index: `03-12-${run}` })
    // Не подшит: дело подшивки пусто, номер — из дела регистрации
    expect(registered.json().case).toBeNull()
  })

  it('дело выбирается явно, «без дела» — префикс журнала', async () => {
    const chosen = await draft()
    const explicit = await post(`/documents/${chosen.id}/register`, {
      journalId,
      caseId: caseIds.get('03-14'),
    })
    expect(explicit.statusCode, explicit.body).toBe(200)
    expect(explicit.json().regNumber).toBe(`03-14-${run}/2`)

    const plain = await draft()
    const none = await post(`/documents/${plain.id}/register`, { journalId, caseId: null })
    expect(none.statusCode, none.body).toBe(200)
    expect(none.json().regNumber).toBe(`ВН${run.slice(-3)}/3`)
    expect(none.json().registrationCase).toBeNull()
  })

  it('закрытое дело и дело другого года в номер не идут', async () => {
    const closedId = await createCase(`03-20-${run}`)
    const closed = await call(fx.app, {
      method: 'POST',
      url: `/cases/${closedId}/close`,
      as: fx.admin,
    })
    expect(closed.statusCode, closed.body).toBe(200)
    const lastYear = await createCase(`03-21-${run}`, { year: year - 1 })

    const doc = await draft()
    for (const caseId of [closedId, lastYear]) {
      const response = await post(`/documents/${doc.id}/register`, { journalId, caseId })
      expect(response.statusCode, response.body).toBe(400)
    }
  })

  it('без единственного подходящего дела номер берёт префикс журнала', async () => {
    // Второе дело того же типа и подразделения — выбирать за человека нельзя
    await createCase(`03-30-${run}`)
    const doc = await draft()
    const preview = await get(`/documents/${doc.id}/number-preview?journalId=${journalId}`)
    expect(preview.json()).toMatchObject({ usesCase: true, caseId: null })
    const registered = await post(`/documents/${doc.id}/register`, { journalId })
    expect(registered.json().regNumber).toMatch(new RegExp(`^ВН${run.slice(-3)}/\\d+$`))
  })

  it('подшивка предлагает дело из номера первым', async () => {
    const doc = await draft(otherTypeId)
    const registered = await post(`/documents/${doc.id}/register`, { journalId })
    expect(registered.json().regNumber).toMatch(new RegExp(`^03-14-${run}/\\d+$`))
    const filing = await get(`/documents/${doc.id}/cases`)
    expect(filing.statusCode, filing.body).toBe(200)
    expect(filing.json().suggestedId).toBe(caseIds.get('03-14'))
    expect(filing.json().items[0].id).toBe(caseIds.get('03-14'))
  })
})
