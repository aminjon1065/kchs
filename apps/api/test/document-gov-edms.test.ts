import { createHash } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { unzipSync } from 'fflate'
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
 * Ручной обмен с закрытой государственной системой ЭДО (ADR-0219): входящие из
 * выгруженных файлов — черновик способом доставки «госЭДО», версия из основного файла
 * и приложений, повтор того же файла не заводится, реквизиты — из текста в пустые поля;
 * исходящий адресату госЭДО после регистрации — дело «Передать в госЭДО», пакет ZIP с
 * экземпляром и карточкой, отметка о передаче закрывает дело и отправку в очереди.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { documentSubscribers } = await import('../src/modules/documents/domain/subscribers.js')
const { matchesType } = await import('../src/kernel/events/bus.js')
const { systemCtx } = await import('../src/shared/context.js')
const { edmsSends, files, fileTexts, inboxItems } = await import('../src/db-schema.js')

const run = Date.now().toString(36)
let fx: TestContext
let registrar: TestUser
let clerk: TestUser
const types = new Map<string, string>()
let ministry = ''

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Body = any

const post = (as: TestUser, url: string, payload: Record<string, unknown> = {}) =>
  call(fx.app, { method: 'POST', url, as, payload })

const sha = (content: string) => createHash('sha256').update(content).digest('hex')

/** Подписчики госЭДО по событиям документа из outbox — как воркер. */
async function drain(objectId: string): Promise<void> {
  const subscribers = documentSubscribers.filter((item) =>
    item.name.startsWith('documents-gov-edms'),
  )
  const rows = await db().execute<{ event: { type: string } }>(
    sql`SELECT event FROM ops.outbox WHERE event->'object'->>'id' = ${objectId} ORDER BY id`,
  )
  for (const row of rows) {
    for (const subscriber of subscribers) {
      if (matchesType(subscriber.types, row.event.type)) await subscriber.handle(row.event as never)
    }
  }
}

/** Текст файла «извлечён движком»: строка file_texts и статус готовности. */
async function extracted(fileId: string, text: string): Promise<void> {
  await db().insert(fileTexts).values({ fileId, text, lang: 'ru' }).onConflictDoNothing()
  await db().update(files).set({ textStatus: 'ready' }).where(eq(files.id, fileId))
  // Как воркер: подписчик на `file.text_extracted` с конвертом события
  const subscriber = documentSubscribers.find((item) => item.name === 'documents-gov-edms-text')
  await subscriber?.handle({
    id: crypto.randomUUID(),
    type: 'file.text_extracted',
    version: 1,
    occurredAt: new Date().toISOString(),
    actor: { userId: null, kind: 'system' },
    object: { id: fileId, type: 'file', spaceId: null, title: null },
    target: null,
    payload: {},
    changedFields: null,
    correlationId: null,
    causationId: null,
    source: 'test',
    visibility: null,
  } as never)
}

/** Документ из госЭДО: черновик → загрузка основного файла и приложения → версия. */
async function imported(subject: string, content: string, attachment = 'приложение') {
  const created = await post(registrar, '/documents/gov-edms/intake', { subject })
  expect(created.statusCode, created.body).toBe(200)
  const { documentId, spaceId } = created.json()
  const main = await uploadFile(fx.app, registrar, {
    spaceId,
    name: `${subject}.pdf`,
    mime: 'application/pdf',
    content,
    attachToObjectId: documentId,
  })
  const annex = await uploadFile(fx.app, registrar, {
    spaceId,
    name: `приложение-${run}.txt`,
    mime: 'text/plain',
    content: attachment,
    attachToObjectId: documentId,
  })
  const completed = await post(registrar, `/documents/gov-edms/intake/${documentId}/complete`, {
    mainFileId: main.id,
    attachmentIds: [annex.id],
  })
  return { documentId, mainFileId: main.id, completed }
}

const LETTER = (number: string) =>
  [
    'МИНИСТЕРСТВО ФИНАНСОВ РЕСПУБЛИКИ ТАДЖИКИСТАН',
    `Исх. № ${number} от 05.03.2026`,
    'Председателю Комитета',
    `О выделении средств ${run}`,
    'Текст письма.',
  ].join('\n')

beforeAll(async () => {
  fx = await setupFixture()
  registrar = await createUser(fx.app, `registrar_edms_${run}`, ['employee', 'registrar'])
  clerk = await createUser(fx.app, `clerk_edms_${run}`, ['employee'])
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  const list = await call(fx.app, { url: '/document-types', as: fx.admin })
  for (const item of list.json().items as Array<{ id: string; key: string }>) {
    types.set(item.key, item.id)
  }
  const found = await call(fx.app, {
    url: '/correspondents?q=Министерство финансов',
    as: registrar,
  })
  ministry = found.json().items[0].id
})

describe('входящие из госЭДО', () => {
  it('черновик «госЭДО», версия из файлов, реквизиты из текста — в пустые поля', async () => {
    const content = `%PDF-1.4 письмо минфина ${run}`
    const before = await post(registrar, '/documents/gov-edms/check', { sha256: [sha(content)] })
    expect(before.json().matches).toEqual([])

    const { documentId, mainFileId, completed } = await imported(`минфин-${run}`, content)
    expect(completed.statusCode, completed.body).toBe(200)
    expect(completed.json()).toMatchObject({
      prefillStatus: 'waiting',
      sha256: sha(content),
      document: { id: documentId, status: 'draft' },
    })
    const card = (await call(fx.app, { url: `/documents/${documentId}`, as: registrar })).json()
    expect(card).toMatchObject({ deliveryMethod: 'edms', subject: `минфин-${run}` })

    await extracted(mainFileId, LETTER(`12-3/${run}`))
    const queue = await call(fx.app, { url: '/documents/gov-edms/intake', as: registrar })
    const item = (queue.json().items as Body[]).find((row) => row.document.id === documentId)
    expect(item).toMatchObject({
      prefillStatus: 'done',
      prefill: { externalNumber: `12-3/${run}`, externalDate: '2026-03-05' },
      document: {
        externalNumber: `12-3/${run}`,
        externalDate: '2026-03-05',
        correspondent: { id: ministry },
      },
      duplicateOf: null,
    })
    const after = (await call(fx.app, { url: `/documents/${documentId}`, as: registrar })).json()
    expect(after.subject).toBe(`О выделении средств ${run}`)
  })

  it('правку человека разбор не затирает', async () => {
    const content = `%PDF-1.4 письмо с номером ${run}`
    const { documentId, mainFileId } = await imported(`правка-${run}`, content)
    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/documents/${documentId}`,
      as: registrar,
      payload: { externalNumber: 'ВРУЧНУЮ-1', subject: 'Тема, которую ввёл человек' },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    await extracted(mainFileId, LETTER(`99/${run}`))
    const doc = (await call(fx.app, { url: `/documents/${documentId}`, as: registrar })).json()
    expect(doc).toMatchObject({
      externalNumber: 'ВРУЧНУЮ-1',
      subject: 'Тема, которую ввёл человек',
    })
  })

  it('тот же файл вторым документом не заводится; тот же отправитель и номер — предупреждение', async () => {
    const content = `%PDF-1.4 повтор ${run}`
    const first = await imported(`повтор-${run}`, content)
    expect(first.completed.statusCode, first.completed.body).toBe(200)

    const check = await post(registrar, '/documents/gov-edms/check', { sha256: [sha(content)] })
    expect(check.json().matches).toMatchObject([{ document: { id: first.documentId } }])

    const again = await imported(`повтор-2-${run}`, content)
    expect(again.completed.statusCode).toBe(409)
    expect(again.completed.json()).toMatchObject({
      code: 'conflict',
      detail: `Этот документ уже заведён из госЭДО: «повтор-${run}»`,
    })
    const trashed = await call(fx.app, { url: `/documents/${again.documentId}`, as: registrar })
    expect(trashed.statusCode).toBe(404)

    // Другой файл того же письма (скан вместо PDF): номер и отправитель совпадают
    await extracted(first.mainFileId, LETTER(`77/${run}`))
    const scan = await imported(`скан-${run}`, `%PDF-1.4 скан того же письма ${run}`)
    await extracted(scan.mainFileId, LETTER(`77/${run}`))
    const queue = await call(fx.app, { url: '/documents/gov-edms/intake', as: registrar })
    const item = (queue.json().items as Body[]).find((row) => row.document.id === scan.documentId)
    expect(item?.duplicateOf).toMatchObject({ id: first.documentId })
  })

  it('без регистрации входящих очередь закрыта', async () => {
    expect((await call(fx.app, { url: '/documents/gov-edms/intake', as: clerk })).statusCode).toBe(
      403,
    )
    expect((await post(clerk, '/documents/gov-edms/intake', { subject: 'x' })).statusCode).toBe(403)
  })

  it('зарегистрированный уходит из очереди ждущих', async () => {
    const { documentId, mainFileId } = await imported(`регистрация-${run}`, `%PDF рег ${run}`)
    await extracted(mainFileId, LETTER(`55/${run}`))
    const registered = await post(registrar, `/documents/${documentId}/register`)
    expect(registered.statusCode, registered.body).toBe(200)
    const pending = await call(fx.app, { url: '/documents/gov-edms/intake', as: registrar })
    expect((pending.json().items as Body[]).some((row) => row.document.id === documentId)).toBe(
      false,
    )
    const all = await call(fx.app, {
      url: '/documents/gov-edms/intake?state=all',
      as: registrar,
    })
    expect(
      (all.json().items as Body[]).find((row) => row.document.id === documentId)?.document,
    ).toMatchObject({ status: 'registered' })
  })
})

describe('исходящие в госЭДО', () => {
  it('регистрация → дело «Передать в госЭДО» → пакет → отметка закрывает дело', async () => {
    const flagged = await call(fx.app, {
      method: 'PATCH',
      url: `/correspondents/${ministry}`,
      as: fx.admin,
      payload: { edmsExchange: true },
    })
    expect(flagged.statusCode, flagged.body).toBe(200)
    const correspondent = await call(fx.app, { url: `/correspondents/${ministry}`, as: registrar })
    expect(correspondent.json()).toMatchObject({ edmsExchange: true })

    const created = await post(registrar, '/documents', {
      typeId: types.get('outgoing_letter'),
      subject: `Ответ Минфину ${run}`,
      correspondentId: ministry,
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string
    const doc = (await call(fx.app, { url: `/documents/${id}`, as: registrar })).json()
    const pdf = await uploadFile(fx.app, registrar, {
      spaceId: doc.spaceId,
      name: `ответ-${run}.pdf`,
      mime: 'application/pdf',
      content: '%PDF-1.4 ответ минфину',
      attachToObjectId: id,
    })
    const annex = await uploadFile(fx.app, registrar, {
      spaceId: doc.spaceId,
      name: `смета-${run}.txt`,
      mime: 'text/plain',
      content: 'смета',
      attachToObjectId: id,
    })
    expect(
      (
        await post(registrar, `/documents/${id}/versions`, {
          mainFileId: pdf.id,
          attachmentIds: [annex.id],
        })
      ).statusCode,
    ).toBe(200)
    const registered = await post(registrar, `/documents/${id}/register`)
    expect(registered.statusCode, registered.body).toBe(200)
    const regNumber = registered.json().regNumber as string
    await drain(id)

    const [task] = await db()
      .select({ state: inboxItems.state, userId: inboxItems.userId })
      .from(inboxItems)
      .where(and(eq(inboxItems.objectId, id), eq(inboxItems.kind, 'edms_transfer')))
    expect(task).toMatchObject({ state: 'open', userId: registrar.id })
    const state = await call(fx.app, { url: `/documents/${id}/gov-edms`, as: registrar })
    expect(state.json()).toMatchObject({ exchange: true, pending: true, transfers: [] })

    // Пакет: экземпляр с номером, приложение, карточка реквизитов
    expect((await post(clerk, `/documents/${id}/gov-edms/package`)).statusCode).toBe(404)
    const pack = await post(registrar, `/documents/${id}/gov-edms/package`)
    expect(pack.statusCode, pack.body).toBe(200)
    const zip = new Uint8Array(await (await fetch(pack.json().url)).arrayBuffer())
    const entries = unzipSync(zip)
    const names = Object.keys(entries)
    expect(names).toContain('card.json')
    expect(names.some((name) => name.startsWith('Приложения/'))).toBe(true)
    const card = JSON.parse(new TextDecoder().decode(entries['card.json']))
    expect(card).toMatchObject({
      format: 'kchs.gov-edms.package/v1',
      document: { regNumber, subject: `Ответ Минфину ${run}` },
      recipient: { name: expect.stringContaining('Министерство финансов') },
    })

    const marked = await post(registrar, `/documents/${id}/gov-edms/transferred`, {
      sentOn: '2026-10-14',
      externalNumber: `ГЭ-${run}`,
    })
    expect(marked.statusCode, marked.body).toBe(200)
    await drain(id)

    const [closed] = await db()
      .select({ state: inboxItems.state })
      .from(inboxItems)
      .where(and(eq(inboxItems.objectId, id), eq(inboxItems.kind, 'edms_transfer')))
    expect(closed?.state).toBe('resolved')
    const [send] = await db().select().from(edmsSends).where(eq(edmsSends.documentId, id))
    expect(send).toMatchObject({ status: 'sent', externalId: `ГЭ-${run}` })
    const after = await call(fx.app, { url: `/documents/${id}/gov-edms`, as: registrar })
    expect(after.json()).toMatchObject({
      pending: false,
      transfers: [{ method: 'edms', tracking: `ГЭ-${run}`, sentOn: '2026-10-14' }],
    })
    const card2 = (await call(fx.app, { url: `/documents/${id}`, as: registrar })).json()
    expect(card2.status).toBe('executed')
  })

  it('адресат без госЭДО — дела нет', async () => {
    const created = await post(registrar, '/correspondents', { name: `Без госЭДО ${run}` })
    expect(created.statusCode, created.body).toBe(200)
    const other = created.json().id as string
    const doc = await post(registrar, '/documents', {
      typeId: types.get('outgoing_letter'),
      subject: `Письмо без госЭДО ${run}`,
      correspondentId: other,
    })
    const id = doc.json().id as string
    const card = (await call(fx.app, { url: `/documents/${id}`, as: registrar })).json()
    const pdf = await uploadFile(fx.app, registrar, {
      spaceId: card.spaceId,
      name: `без-${run}.pdf`,
      mime: 'application/pdf',
      content: '%PDF-1.4 без госЭДО',
      attachToObjectId: id,
    })
    await post(registrar, `/documents/${id}/versions`, { mainFileId: pdf.id })
    expect((await post(registrar, `/documents/${id}/register`)).statusCode).toBe(200)
    await drain(id)
    const tasks = await db()
      .select({ id: inboxItems.id })
      .from(inboxItems)
      .where(and(eq(inboxItems.objectId, id), eq(inboxItems.kind, 'edms_transfer')))
    expect(tasks).toHaveLength(0)
    const state = await call(fx.app, { url: `/documents/${id}/gov-edms`, as: registrar })
    expect(state.json()).toMatchObject({ exchange: false, pending: false })
  })
})
