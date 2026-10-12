import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  db,
  engineHeadersFor,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
  uploadFile,
} from './helpers.js'
import { actInbox, createPeople, inboxOf, type ProcessPeople } from './process-fixtures.js'

/**
 * Целостность версий документа (ADR-0197): версия документа закреплена за
 * версиями файлов, файл замороженной версии не меняется ни загрузкой, ни
 * откатом, ни корзиной, ни офисным редактором; правка файла незамороженного
 * документа становится новой версией документа в той же транзакции; поздняя
 * правка из редактора не теряется — ложится копией рядом. Сценарий канцелярии
 * «вернули на доработку → правка в редакторе → версия 2 → повторно на
 * согласование» — с видео эталонной системы.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const { officeSessions } = await import('../src/db-schema.js')

const run = Date.now().toString(36)
const SECRET = 'office-integrity-secret-0123456789'
/** Начало ZIP-контейнера DOCX: формат редактор открывает. */
const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04])
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const EDITED = Buffer.concat([PK, Buffer.from('правка из редактора')])

let fx: TestContext
let people: ProcessPeople
let documentServer: Server
let signJwt: (payload: Record<string, unknown>, secret: string, ttl?: number) => string
let officeTicket: (session: string, purpose: string, secret: string, ttlMs: number) => string
const types = new Map<string, string>()
const previous = { url: process.env.ONLYOFFICE_URL, secret: process.env.ONLYOFFICE_JWT_SECRET }

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Body = any

beforeAll(async () => {
  // Сервер документов: живость и «скачай правку отсюда»
  documentServer = createServer((request, response) => {
    if (request.url === '/healthcheck') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('true')
      return
    }
    if (request.url?.startsWith('/cache/')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.end(EDITED)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise<void>((resolve) => documentServer.listen(0, '127.0.0.1', resolve))
  const port = (documentServer.address() as AddressInfo).port
  process.env.ONLYOFFICE_URL = `http://127.0.0.1:${port}`
  process.env.ONLYOFFICE_JWT_SECRET = SECRET
  const { resetConfigCache } = await import('../src/shared/config/env.js')
  resetConfigCache()
  ;({ signJwt, officeTicket } = await import('../src/modules/files/domain/office.js'))

  fx = await setupFixture()
  people = await createPeople(fx, run)
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  const list = await call(fx.app, { url: '/document-types', as: fx.admin })
  for (const item of list.json().items as Array<{ id: string; key: string }>) {
    types.set(item.key, item.id)
  }
})

afterAll(async () => {
  await new Promise<void>((resolve) => documentServer.close(() => resolve()))
  process.env.ONLYOFFICE_URL = previous.url ?? ''
  process.env.ONLYOFFICE_JWT_SECRET = previous.secret ?? ''
  const { resetConfigCache } = await import('../src/shared/config/env.js')
  resetConfigCache()
})

async function createDraft(
  as: TestUser,
  typeKey: string,
  extra: Record<string, unknown> = {},
): Promise<Body> {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/documents',
    as,
    payload: { typeId: types.get(typeKey), subject: `Целостность ${run}`, ...extra },
  })
  expect(created.statusCode, created.body).toBe(200)
  return getDocument(as, created.json().id)
}

async function getDocument(as: TestUser, id: string): Promise<Body> {
  const response = await call(fx.app, { url: `/documents/${id}`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

/** Файл — вложение документа. */
async function attach(
  as: TestUser,
  doc: Body,
  name: string,
  content: string | Buffer,
  mime = 'application/pdf',
): Promise<string> {
  const file = await uploadFile(fx.app, as, {
    spaceId: doc.spaceId,
    name,
    mime,
    content,
    attachToObjectId: doc.id,
  })
  return file.id
}

function addVersion(as: TestUser, doc: Body, mainFileId: string) {
  return call(fx.app, {
    method: 'POST',
    url: `/documents/${doc.id}/versions`,
    as,
    payload: { mainFileId },
  })
}

/** Новая версия существующего файла: сессия с `fileId`, загрузка, завершение. */
async function uploadVersion(
  as: TestUser,
  spaceId: string,
  fileId: string,
  name: string,
  content: string | Buffer,
  mime = 'application/pdf',
) {
  const body = typeof content === 'string' ? Buffer.from(content) : content
  const session = await call(fx.app, {
    method: 'POST',
    url: '/files/upload-sessions',
    as,
    payload: { name, size: body.byteLength, mime, spaceId, fileId },
  })
  if (session.statusCode !== 200) return session
  const { uploadId, storageKey, singlePutUrl } = session.json()
  const put = await fetch(singlePutUrl, {
    method: 'PUT',
    body: new Uint8Array(body),
    headers: { 'content-type': mime },
  })
  expect(put.ok).toBe(true)
  return call(fx.app, {
    method: 'POST',
    url: `/files/upload-sessions/${uploadId}/complete`,
    as,
    payload: { uploadId, storageKey, parts: [] },
  })
}

async function versionsOf(as: TestUser, documentId: string): Promise<Body[]> {
  const response = await call(fx.app, { url: `/documents/${documentId}/versions`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().items
}

/** Содержимое файла (или его версии) из хранилища. */
async function contentOf(as: TestUser, fileId: string, versionId?: string): Promise<string> {
  const link = await call(fx.app, {
    url: `/files/${fileId}/download${versionId ? `?versionId=${versionId}` : ''}`,
    as,
  })
  expect(link.statusCode, link.body).toBe(200)
  const stored = await fetch(link.json().url)
  return Buffer.from(await stored.arrayBuffer()).toString()
}

async function openOffice(as: TestUser, fileId: string): Promise<Body> {
  const session = await call(fx.app, {
    method: 'POST',
    url: `/files/${fileId}/office-session`,
    as,
  })
  expect(session.statusCode, session.body).toBe(200)
  return session.json()
}

/** Сервер документов сообщает: все вышли, правка готова (статус 2). */
async function officeSaved(sessionId: string): Promise<void> {
  const body = { key: 'ignored', status: 2, url: `${process.env.ONLYOFFICE_URL}/cache/out.docx` }
  const ticket = officeTicket(sessionId, 'callback', SECRET, 60_000)
  const saved = await call(fx.app, {
    method: 'POST',
    url: `/internal/office/${sessionId}/callback?t=${ticket}`,
    payload: body,
    headers: { authorization: `Bearer ${signJwt(body, SECRET, 60)}` },
  })
  expect(saved.statusCode, saved.body).toBe(200)
  expect(saved.json()).toEqual({ error: 0 })
}

async function fileVersions(fileId: string): Promise<Body[]> {
  const response = await call(fx.app, { url: `/files/${fileId}/versions`, as: fx.admin })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().items
}

/** Событие `document.version_added` документа — последнее по порядку. */
async function lastVersionEvent(documentId: string): Promise<Record<string, unknown> | null> {
  const rows = await db().execute<{ payload: Record<string, unknown> }>(
    sql`SELECT event->'payload' AS payload FROM ops.outbox
         WHERE event->>'type' = 'document.version_added'
           AND event->'object'->>'id' = ${documentId}
         ORDER BY id DESC LIMIT 1`,
  )
  return rows[0]?.payload ?? null
}

describe('версия документа закреплена за версиями файлов', () => {
  it('черновик: новая версия файла — новая версия документа, прежняя показывает свои байты', async () => {
    const doc = await createDraft(people.author, 'outgoing_letter', { signerId: people.signer.id })
    const fileId = await attach(people.author, doc, `письмо-${run}.pdf`, '%PDF-1.4 первая редакция')
    expect((await addVersion(people.author, doc, fileId)).statusCode).toBe(200)

    const uploaded = await uploadVersion(
      people.author,
      doc.spaceId,
      fileId,
      `письмо-${run}.pdf`,
      '%PDF-1.4 вторая редакция',
    )
    expect(uploaded.statusCode, uploaded.body).toBe(200)

    const [second, first] = await versionsOf(people.author, doc.id)
    expect(second).toMatchObject({ number: 2, note: 'Загружена новая версия файла' })
    expect(first).toMatchObject({ number: 1 })
    expect(second.mainFile.id).toBe(fileId)
    expect(first.mainFile.id).toBe(fileId)
    expect(second.mainFile.versionId).not.toBe(first.mainFile.versionId)
    expect(second.mainFile).toMatchObject({ current: true })
    expect(first.mainFile).toMatchObject({ current: false })
    // Версия 1 по-прежнему отдаёт свои байты, версия 2 — новые
    expect(await contentOf(people.author, fileId, first.mainFile.versionId)).toBe(
      '%PDF-1.4 первая редакция',
    )
    expect(await contentOf(people.author, fileId, second.mainFile.versionId)).toBe(
      '%PDF-1.4 вторая редакция',
    )
    expect(await lastVersionEvent(doc.id)).toMatchObject({ number: 2, fileId, source: 'upload' })
    expect((await getDocument(people.author, doc.id)).currentVersion.id).toBe(second.id)
  })

  it('на согласовании файл заморожен: загрузка, откат и корзина — 409, редактор — просмотр, поздняя правка — копией', async () => {
    const doc = await createDraft(people.author, 'outgoing_letter', { signerId: people.signer.id })
    const fileId = await attach(
      people.author,
      doc,
      `проект-${run}.docx`,
      Buffer.concat([PK, Buffer.from('проект письма')]),
      DOCX,
    )
    expect((await addVersion(people.author, doc, fileId)).statusCode).toBe(200)
    // Редактор открыт, пока документ — черновик: правка разрешена
    const early = await openOffice(people.author, fileId)
    expect(early).toMatchObject({ mode: 'edit', readOnly: null })

    const started = await call(fx.app, {
      method: 'POST',
      url: `/documents/${doc.id}/routes`,
      as: people.author,
      payload: {
        definitionKey: 'document_outgoing',
        assignees: { review: [people.a1.id, people.a2.id] },
      },
    })
    expect(started.statusCode, started.body).toBe(200)
    expect((await getDocument(people.author, doc.id)).contentLock).toBe('route_active')

    // Новая версия файла — отказ ещё до загрузки байтов
    const upload = await uploadVersion(
      people.author,
      doc.spaceId,
      fileId,
      `проект-${run}.docx`,
      Buffer.concat([PK, Buffer.from('подмена')]),
      DOCX,
    )
    expect(upload.statusCode).toBe(409)
    expect(upload.json().data).toMatchObject({ reason: 'file_frozen', hostId: doc.id })

    const [onlyVersion] = await fileVersions(fileId)
    const restore = await call(fx.app, {
      method: 'POST',
      url: `/files/${fileId}/versions/${onlyVersion.id}/restore`,
      as: people.author,
      payload: {},
    })
    expect(restore.statusCode).toBe(409)
    expect(restore.json().data.reason).toBe('file_frozen')

    const trash = await call(fx.app, { method: 'DELETE', url: `/objects/${fileId}`, as: fx.admin })
    expect(trash.statusCode).toBe(409)

    // Редактор теперь открывает файл только на просмотр — и сессия, и сама страница:
    // без адреса сохранения сервер документов правку не вернёт
    expect(await openOffice(people.author, fileId)).toMatchObject({
      mode: 'view',
      readOnly: 'file_frozen',
    })
    const page = await call(fx.app, {
      url: `/api/v1/office/editor/${early.id}`,
      as: people.author,
    })
    expect(page.statusCode).toBe(200)
    expect(page.body).not.toContain('"callbackUrl"')

    // Правка, сохранённая уже после отправки, ложится новым файлом документа
    await officeSaved(early.id)
    expect(await fileVersions(fileId)).toHaveLength(1)
    const [session] = await db()
      .select()
      .from(officeSessions)
      .where(eq(officeSessions.id, early.id))
    expect(session).toMatchObject({ status: 'saved', conflict: true })
    const attachments = await call(fx.app, {
      url: `/objects/${doc.id}/links`,
      as: people.author,
    })
    expect(attachments.statusCode, attachments.body).toBe(200)
    expect(JSON.stringify(attachments.json())).toContain('(правка от ')
    expect(await contentOf(people.author, fileId)).toBe(
      Buffer.concat([PK, Buffer.from('проект письма')]).toString(),
    )
  })
})

describe('доработка возвращённого проекта (сценарий с видео)', () => {
  it('замечания → правка в редакторе → версия 2 → повторная отправка уходит с ней; PDF-представление не правится', async () => {
    const doc = await createDraft(people.author, 'outgoing_letter', { signerId: people.signer.id })
    const fileId = await attach(
      people.author,
      doc,
      `служебная-${run}.docx`,
      Buffer.concat([PK, Buffer.from('версия один')]),
      DOCX,
    )
    expect((await addVersion(people.author, doc, fileId)).statusCode).toBe(200)
    const started = await call(fx.app, {
      method: 'POST',
      url: `/documents/${doc.id}/routes`,
      as: people.author,
      payload: { definitionKey: 'document_outgoing', assignees: { review: [people.a1.id] } },
    })
    expect(started.statusCode, started.body).toBe(200)

    // Движок построил PDF-представление версии 1
    const [first] = await versionsOf(people.author, doc.id)
    const pdfFileId = randomUUID()
    const pdfVersionId = randomUUID()
    const path = `/api/v1/internal/documents/versions/${first.id}/pdf`
    const report = await fx.app.inject({
      method: 'POST',
      url: path,
      headers: engineHeadersFor(path),
      payload: {
        status: 'ready',
        sha256: 'c'.repeat(64),
        pdfFileId,
        pdfVersionId,
        storageKey: `spaces/${doc.spaceId}/files/${pdfFileId}/${pdfVersionId}/служебная.pdf`,
        size: 10,
      },
    })
    expect(report.statusCode, report.body).toBe(200)
    const [withPdf] = await versionsOf(people.author, doc.id)
    expect(withPdf.pdfFile).toMatchObject({ id: pdfFileId, versionId: pdfVersionId })

    // Замечания — возврат автору
    const [item] = await inboxOf(fx, people.a1, doc.id)
    const remarks = await actInbox(fx, people.a1, item?.id ?? '', 'remarks', {
      comment: 'Внести правки',
    })
    expect(remarks.statusCode, remarks.body).toBe(200)
    const returned = await getDocument(people.author, doc.id)
    expect(returned.status).toBe('returned')
    expect(returned.can.addVersion).toBe(true)
    expect(returned.contentLock).toBeNull()

    // PDF-представление — сгенерированный файл: его не правят никогда
    const pdfUpload = await uploadVersion(
      people.author,
      doc.spaceId,
      pdfFileId,
      'служебная.pdf',
      '%PDF-1.4 подмена представления',
    )
    expect(pdfUpload.statusCode).toBe(409)
    expect(pdfUpload.json().data).toMatchObject({ reason: 'file_frozen', cause: 'representation' })

    // Правка в редакторе — сразу версия 2 документа
    const session = await openOffice(people.author, fileId)
    expect(session.mode).toBe('edit')
    await officeSaved(session.id)
    const [second, again] = await versionsOf(people.author, doc.id)
    expect(second).toMatchObject({ number: 2, note: 'Правка в редакторе', isFinal: false })
    expect(again).toMatchObject({ number: 1, isFinal: true })
    expect(second.mainFile.versionId).not.toBe(again.mainFile.versionId)
    expect(await contentOf(people.author, fileId, again.mainFile.versionId)).toBe(
      Buffer.concat([PK, Buffer.from('версия один')]).toString(),
    )
    expect(await contentOf(people.author, fileId, second.mainFile.versionId)).toBe(
      EDITED.toString(),
    )
    expect(await lastVersionEvent(doc.id)).toMatchObject({ fileId, source: 'editor' })

    // Повторная отправка — согласующий видит версию 2
    const [revise] = await inboxOf(fx, people.author, doc.id)
    expect((await actInbox(fx, people.author, revise?.id ?? '', 'resubmit')).statusCode).toBe(200)
    const stepVersions = await call(fx.app, {
      url: `/documents/${doc.id}/route-versions`,
      as: people.author,
    })
    const numbers = (stepVersions.json().items as Array<{ versionNumber: number }>).map(
      (entry) => entry.versionNumber,
    )
    expect(numbers).toEqual(expect.arrayContaining([1, 2]))
    expect((await versionsOf(people.author, doc.id))[0]).toMatchObject({
      number: 2,
      isFinal: true,
    })
  })
})

describe('согласованное и подписанное не меняется', () => {
  it('после подписи и регистрации: ни новой версии, ни новой версии файла; подпись действительна, версия отдаёт свои байты', async () => {
    const doc = await createDraft(people.author, 'memo', { subject: `Записка ${run}` })
    const fileId = await attach(people.author, doc, `записка-${run}.pdf`, '%PDF-1.4 подписано')
    expect((await addVersion(people.author, doc, fileId)).statusCode).toBe(200)
    const started = await call(fx.app, {
      method: 'POST',
      url: `/documents/${doc.id}/routes`,
      as: people.author,
      payload: { definitionKey: 'document_memo' },
    })
    expect(started.statusCode, started.body).toBe(200)
    const [item] = await inboxOf(fx, people.boss, doc.id)
    expect((await actInbox(fx, people.boss, item?.id ?? '', 'sign')).statusCode).toBe(200)

    const card = await getDocument(people.author, doc.id)
    expect(card.status).toBe('registered')
    expect(card.can.addVersion).toBe(false)
    expect(card.contentLock).toBe('frozen')

    const another = await attach(people.author, doc, `другая-${run}.pdf`, '%PDF-1.4 другое')
    const late = await addVersion(people.author, doc, another)
    expect(late.statusCode).toBe(409)
    expect(late.json().data.reason).toBe('frozen')

    const upload = await uploadVersion(
      people.author,
      doc.spaceId,
      fileId,
      `записка-${run}.pdf`,
      '%PDF-1.4 подмена после подписи',
    )
    expect(upload.statusCode).toBe(409)

    // Движок посчитал хэш: подпись сходится с версией, версия отдаёт подписанные байты
    const [version] = await versionsOf(people.author, doc.id)
    const path = `/api/v1/internal/documents/versions/${version.id}/pdf`
    const report = await fx.app.inject({
      method: 'POST',
      url: path,
      headers: engineHeadersFor(path),
      payload: { status: 'skipped', sha256: 'd'.repeat(64) },
    })
    expect(report.statusCode, report.body).toBe(200)
    const signatures = await call(fx.app, {
      url: `/documents/${doc.id}/signatures`,
      as: people.author,
    })
    expect(signatures.json().items[0]).toMatchObject({ state: 'valid', current: true })
    expect(await contentOf(people.author, fileId, version.mainFile.versionId)).toBe(
      '%PDF-1.4 подписано',
    )
  })

  it('входящий, зарегистрированный без маршрута, принимает новый скан', async () => {
    const registrar = await createUser(fx.app, `reg_integrity_${run}`, ['employee', 'registrar'])
    const found = await call(fx.app, { url: '/correspondents?q=Минфин', as: registrar })
    const doc = await createDraft(registrar, 'incoming_letter', {
      correspondentId: found.json().items[0].id,
      receivedDate: '2026-10-12',
      externalNumber: `05-01/${run}`,
      externalDate: '2026-10-10',
      deliveryMethod: 'post',
    })
    const scan = await attach(registrar, doc, `скан-${run}.pdf`, '%PDF-1.4 скан')
    expect((await addVersion(registrar, doc, scan)).statusCode).toBe(200)
    const registered = await call(fx.app, {
      method: 'POST',
      url: `/documents/${doc.id}/register`,
      as: registrar,
      payload: {},
    })
    expect(registered.statusCode, registered.body).toBe(200)
    const card = await getDocument(registrar, doc.id)
    expect(card.contentLock).toBeNull()
    const rescan = await attach(registrar, doc, `скан2-${run}.pdf`, '%PDF-1.4 скан чётче')
    expect((await addVersion(registrar, doc, rescan)).statusCode).toBe(200)
  })
})
