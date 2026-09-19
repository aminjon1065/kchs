import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
  uploadFile,
} from './helpers.js'
import { actInbox, createPeople, inboxOf, type ProcessPeople } from './process-fixtures.js'

/**
 * Листы согласования, подписи и ознакомления, опись дела (ADR-0085: реестр
 * печатных форм; данные — маршруты ADR-0083, ознакомление ADR-0084, дела
 * ADR-0086): формы доступны, когда у документа есть данные, и строятся с
 * правами печатающего — решения, подписи с хэшем, отметки, строки описи.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const { buildUserCtxFor } = await import('../src/kernel/access/explain.js')
const { createTranslator } = await import('@kchs/i18n')
const { printForm } = await import('../src/modules/documents/domain/print/registry.js')

const run = Date.now().toString(36)
let fx: TestContext
let people: ProcessPeople
let outsider: TestUser
const types = new Map<string, string>()

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Body = any

async function forms(as: TestUser, subjectId: string): Promise<Map<string, Body>> {
  const response = await call(fx.app, {
    url: `/documents/print-forms?subjectId=${subjectId}`,
    as,
  })
  expect(response.statusCode, response.body).toBe(200)
  return new Map((response.json().items as Body[]).map((item) => [item.key as string, item]))
}

/** ФИО сотрудника, как его показывает справочник. */
async function nameOf(user: TestUser): Promise<string> {
  const ctx = await buildUserCtxFor(user.id)
  return ctx?.displayName ?? user.login
}

/** Сборка формы с правами пользователя — как её строит рендер перед движком. */
async function build(form: string, as: TestUser, subject: { id: string; type: string }) {
  const ctx = await buildUserCtxFor(as.id)
  if (!ctx) throw new Error('нет контекста пользователя')
  const definition = printForm(form)
  if (!definition) throw new Error(`нет формы ${form}`)
  const result = await definition.build(
    {
      ctx,
      t: createTranslator('ru'),
      locale: 'ru',
      timezone: 'Asia/Dushanbe',
      org: 'Тестовая организация',
      now: new Date(),
    },
    { id: subject.id, type: subject.type, spaceId: '', title: '', confidentiality: 'internal' },
    {},
  )
  if (result.kind !== 'html') throw new Error('ожидалась страница формы')
  return result.body.toString()
}

beforeAll(async () => {
  fx = await setupFixture()
  people = await createPeople(fx, run)
  const { createUser } = await import('./helpers.js')
  outsider = await createUser(fx.app, `outsider_sheets_${run}`, ['employee'])
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  const list = await call(fx.app, { url: '/document-types', as: fx.admin })
  for (const item of list.json().items as Array<{ id: string; key: string }>) {
    types.set(item.key, item.id)
  }
})

describe('листы маршрута, ознакомления и опись дела', () => {
  it('служебная записка по маршруту: лист согласования и подписи, лист ознакомления, опись дела', async () => {
    // Записка по маршруту «подпись руководителя подразделения → регистрация»
    const created = await call(fx.app, {
      method: 'POST',
      url: '/documents',
      as: people.author,
      payload: { typeId: types.get('memo'), subject: `Записка о паводке ${run}` },
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string
    const doc = (await call(fx.app, { url: `/documents/${id}`, as: people.author })).json()

    // До маршрута листов нет — с понятной причиной
    const before = await forms(people.author, id)
    expect(before.get('approval_sheet')).toMatchObject({
      available: false,
      reasonKey: 'documents.print.reasons.noRoute',
    })
    expect(before.get('signature_sheet')).toMatchObject({
      available: false,
      reasonKey: 'documents.print.reasons.noSignatures',
    })

    const uploaded = await uploadFile(fx.app, people.author, {
      spaceId: doc.spaceId,
      name: `записка-${run}.pdf`,
      mime: 'application/pdf',
      content: `%PDF-1.4 записка ${run}`,
      attachToObjectId: id,
    })
    const version = await call(fx.app, {
      method: 'POST',
      url: `/documents/${id}/versions`,
      as: people.author,
      payload: { mainFileId: uploaded.id },
    })
    expect(version.statusCode, version.body).toBe(200)
    const started = await call(fx.app, {
      method: 'POST',
      url: `/documents/${id}/routes`,
      as: people.author,
      payload: { definitionKey: 'document_memo' },
    })
    expect(started.statusCode, started.body).toBe(200)
    const [item] = await inboxOf(fx, people.boss, id)
    expect((await actInbox(fx, people.boss, item?.id ?? '', 'sign')).statusCode).toBe(200)
    const signed = (await call(fx.app, { url: `/documents/${id}`, as: people.author })).json()
    expect(signed.status).toBe('registered')

    const after = await forms(people.author, id)
    expect(after.get('approval_sheet')?.available).toBe(true)
    expect(after.get('signature_sheet')?.available).toBe(true)

    const approval = await build('approval_sheet', people.author, { id, type: 'document' })
    expect(approval).toContain('Лист согласования')
    expect(approval).toContain(signed.regNumber)
    expect(approval).toContain(await nameOf(people.boss))
    expect(approval).toContain('Подписал')
    // Версия, которую видел шаг подписи
    expect(approval).toMatch(/<td class="num">1<\/td>\s*<td><\/td>/)

    const signature = await build('signature_sheet', people.author, { id, type: 'document' })
    expect(signature).toContain('Лист подписи')
    expect(signature).toContain(await nameOf(people.boss))
    expect(signature).toContain('без кода')

    // Ознакомление: делопроизводитель автора знакомит сотрудника — лист с отметкой
    expect(after.get('acknowledgment_sheet')).toMatchObject({ available: false })
    const requested = await call(fx.app, {
      method: 'POST',
      url: `/documents/${id}/acknowledgments`,
      as: people.author,
      payload: { userIds: [people.a1.id] },
    })
    expect(requested.statusCode, requested.body).toBe(200)
    const pending = await build('acknowledgment_sheet', people.author, { id, type: 'document' })
    expect(pending).toContain(await nameOf(people.a1))
    expect(pending).toContain('не ознакомлен')
    const acknowledged = await call(fx.app, {
      method: 'POST',
      url: `/objects/${id}/acknowledgments/acknowledge`,
      as: people.a1,
      payload: {},
    })
    expect(acknowledged.statusCode, acknowledged.body).toBe(200)
    const done = await build('acknowledgment_sheet', people.author, { id, type: 'document' })
    expect(done).toContain('Ознакомлены 1 из 1.')
    expect(done).not.toContain('не ознакомлен')

    // Опись дела: записка подшита в дело — строка с номером и темой
    const createdCase = await call(fx.app, {
      method: 'POST',
      url: '/cases',
      as: fx.admin,
      payload: {
        index: `05-${run}`.slice(0, 20),
        title: `Служебная переписка ${run}`,
        year: new Date().getFullYear(),
        retentionYears: 5,
      },
    })
    expect(createdCase.statusCode, createdCase.body).toBe(200)
    const caseId = createdCase.json().id as string
    const filed = await call(fx.app, {
      method: 'POST',
      url: `/documents/${id}/file`,
      as: fx.admin,
      payload: { caseId },
    })
    expect(filed.statusCode, filed.body).toBe(200)
    const caseForms = await forms(fx.admin, caseId)
    expect(caseForms.get('case_inventory')?.available).toBe(true)
    const inventory = await build('case_inventory', fx.admin, { id: caseId, type: 'case' })
    expect(inventory).toContain('Опись документов дела')
    expect(inventory).toContain(signed.regNumber)
    expect(inventory).toContain(`Записка о паводке ${run}`)
    expect(inventory).toContain('Итого: 1 документ.')

    // Сотрудник без доступа к документу строки о нём в описи не получит
    const foreign = await build('case_inventory', outsider, { id: caseId, type: 'case' }).catch(
      (error: unknown) => error,
    )
    if (typeof foreign === 'string') expect(foreign).not.toContain(`Записка о паводке ${run}`)
    else expect(foreign).toBeInstanceOf(Error)
  })
})
