import { randomUUID } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { and, eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  call,
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
 * Подпись как реквизит (ADR-0198): факсимиле сотрудника видит только он сам;
 * подпись фиксирует манифест версии — основной файл, приложения и PDF; подписанный
 * экземпляр строится планом наложения с факсимиле, QR и штампом и записывается в
 * версию; место факсимиле правит подписант; страница проверки по QR открыта без
 * входа и не раскрывает содержания.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { DocumentRenders } = await import('../src/modules/documents/domain/render-service.js')
const { systemCtx } = await import('../src/shared/context.js')
const { auditLog, documentRenders, documentSignatures } = await import('../src/db-schema.js')

const run = Date.now().toString(36)
let fx: TestContext
let people: ProcessPeople
const types = new Map<string, string>()

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Body = any

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.byteLength, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** Подпись-картинка: PNG RGBA с текстовым блоком, который сервер обязан выбросить. */
function facsimilePng(): string {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(240, 0)
  ihdr.writeUInt32BE(96, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(240 * 4, 0x20)])
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.from('Author:secret-metadata', 'latin1')),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 96 }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

async function createDraft(as: TestUser, typeKey: string, extra: Record<string, unknown> = {}) {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/documents',
    as,
    payload: { typeId: types.get(typeKey), subject: `Секретная тема ${run}`, ...extra },
  })
  expect(created.statusCode, created.body).toBe(200)
  const card = await call(fx.app, { url: `/documents/${created.json().id}`, as })
  return card.json() as Body
}

async function attach(as: TestUser, doc: Body, name: string, content: string, mime: string) {
  const file = await uploadFile(fx.app, as, {
    spaceId: doc.spaceId,
    name,
    mime,
    content,
    attachToObjectId: doc.id,
  })
  return file.id
}

async function versionsOf(as: TestUser, documentId: string): Promise<Body[]> {
  const response = await call(fx.app, { url: `/documents/${documentId}/versions`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().items
}

/** Имя сотрудника в справочнике — как его покажут страница проверки и штамп. */
async function displayName(user: TestUser): Promise<string> {
  const response = await call(fx.app, { url: `/users/${user.id}`, as: fx.admin })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().displayName as string
}

async function signaturesOf(as: TestUser, documentId: string): Promise<Body[]> {
  const response = await call(fx.app, { url: `/documents/${documentId}/signatures`, as })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().items
}

const engine = (path: string, payload: Record<string, unknown> = {}) =>
  call(fx.app, { method: 'POST', url: path, headers: engineHeadersFor(path), payload })

/**
 * Служебная записка: основной PDF и приложение, отчёт движка о хэшах, подпись
 * руководителя подразделения — номер сразу после подписи.
 */
async function signedMemo(
  options: { attachmentHashes?: boolean; extra?: Record<string, unknown> } = {},
) {
  const doc = await createDraft(people.author, 'memo', options.extra ?? {})
  const main = await attach(
    people.author,
    doc,
    `записка-${run}.pdf`,
    '%PDF-1.4 записка',
    'application/pdf',
  )
  const annex = await attach(
    people.author,
    doc,
    `приложение-${run}.txt`,
    'приложение',
    'text/plain',
  )
  const added = await call(fx.app, {
    method: 'POST',
    url: `/documents/${doc.id}/versions`,
    as: people.author,
    payload: { mainFileId: main, attachmentIds: [annex] },
  })
  expect(added.statusCode, added.body).toBe(200)
  const [version] = await versionsOf(people.author, doc.id)
  const report = await engine(`/api/v1/internal/documents/versions/${version.id}/pdf`, {
    status: 'skipped',
    sha256: 'a'.repeat(64),
    ...(options.attachmentHashes === false ? {} : { attachments: { [annex]: 'b'.repeat(64) } }),
  })
  expect(report.statusCode, report.body).toBe(200)
  const started = await call(fx.app, {
    method: 'POST',
    url: `/documents/${doc.id}/routes`,
    as: people.author,
    payload: { definitionKey: 'document_memo' },
  })
  expect(started.statusCode, started.body).toBe(200)
  const [item] = await inboxOf(fx, people.boss, doc.id)
  expect((await actInbox(fx, people.boss, item?.id ?? '', 'sign')).statusCode).toBe(200)
  return { doc, main, annex, versionId: version.id as string }
}

beforeAll(async () => {
  fx = await setupFixture()
  people = await createPeople(fx, run)
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  const list = await call(fx.app, { url: '/document-types', as: fx.admin })
  for (const item of list.json().items as Array<{ id: string; key: string }>) {
    types.set(item.key, item.id)
  }
})

describe('факсимиле сотрудника', () => {
  it('видно только владельцу; администратор заменяет, не видя; метаданные PNG выброшены', async () => {
    const saved = await call(fx.app, {
      method: 'PUT',
      url: '/me/facsimile',
      as: people.boss,
      payload: { png: facsimilePng() },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const own = saved.json()
    expect(own).toMatchObject({ present: true, width: 240, height: 96 })
    expect(own.dataUri).toMatch(/^data:image\/png;base64,/)
    const bytes = Buffer.from(own.dataUri.split(',')[1], 'base64')
    expect(bytes.includes(Buffer.from('secret-metadata'))).toBe(false)

    // Администратор видит только, есть ли факсимиле
    const state = await call(fx.app, { url: `/users/${people.boss.id}/facsimile`, as: fx.admin })
    expect(state.statusCode, state.body).toBe(200)
    expect(state.json()).toMatchObject({ present: true, width: 240 })
    expect(state.json()).not.toHaveProperty('dataUri')
    // Посторонний сотрудник — ни видеть, ни менять
    const foreign = await call(fx.app, {
      url: `/users/${people.boss.id}/facsimile`,
      as: people.a1,
    })
    expect(foreign.statusCode).toBe(403)
    const garbage = await call(fx.app, {
      method: 'PUT',
      url: '/me/facsimile',
      as: people.a1,
      payload: { png: Buffer.from('GIF89a……..').toString('base64') },
    })
    expect(garbage.statusCode).toBe(400)

    const replaced = await call(fx.app, {
      method: 'PUT',
      url: `/users/${people.boss.id}/facsimile`,
      as: fx.admin,
      payload: { png: facsimilePng() },
    })
    expect(replaced.statusCode, replaced.body).toBe(200)
    const [entry] = await db()
      .select({ severity: auditLog.severity, details: auditLog.details })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'user.facsimile_changed'),
          eq(auditLog.objectId, people.boss.id),
          eq(auditLog.actorId, fx.admin.id),
        ),
      )
      .limit(1)
    expect(entry).toMatchObject({ severity: 'warning', details: { byAdmin: true, present: true } })
  })
})

describe('подпись фиксирует манифест версии', () => {
  it('основной файл, приложение и PDF — в манифесте; хэш подписи — хэш манифеста', async () => {
    const { doc, main, annex } = await signedMemo()
    const [version] = await versionsOf(people.author, doc.id)
    expect(version.manifestHash).toMatch(/^[0-9a-f]{64}$/)
    const [signature] = await signaturesOf(people.author, doc.id)
    expect(signature).toMatchObject({ state: 'valid', hash: version.manifestHash })
    expect(signature.manifest).toMatchObject({
      v: 1,
      documentId: doc.id,
      versionNumber: 1,
      mainFile: { fileId: main, sha256: 'a'.repeat(64) },
      attachments: [{ fileId: annex, sha256: 'b'.repeat(64) }],
      // PDF-основа — сама себе представление
      pdf: { fileId: main, sha256: 'a'.repeat(64) },
    })
  })

  it('отчёт движка без хэшей приложений — прежнее правило: хэш основного файла', async () => {
    const { doc } = await signedMemo({ attachmentHashes: false })
    const [version] = await versionsOf(people.author, doc.id)
    expect(version.manifestHash).toBeNull()
    const [signature] = await signaturesOf(people.author, doc.id)
    expect(signature).toMatchObject({ state: 'valid', hash: 'a'.repeat(64), manifest: null })
  })
})

describe('подписанный экземпляр, место факсимиле, страница проверки', () => {
  let doc: Body
  let versionId = ''
  let signatureId = ''

  it('план: последний лист, факсимиле с якорями, QR и штамп; результат — в версию', async () => {
    ;({ doc, versionId } = await signedMemo())
    const card = await call(fx.app, { url: `/documents/${doc.id}`, as: people.author })
    expect(card.json().status).toBe('registered')
    const regNumber = card.json().regNumber as string

    const renderId = await DocumentRenders.scheduleSignedCopy(doc.id)
    expect(renderId).toBeTruthy()
    // Повтор ничего не добавляет — тот же номер, подписи и места
    expect(await DocumentRenders.scheduleSignedCopy(doc.id)).toBeNull()

    const start = await engine(`/internal/documents/renders/${renderId}/start`)
    expect(start.statusCode, start.body).toBe(200)
    const plan = start.json().plan
    expect(plan).toMatchObject({ kind: 'overlay', pages: 'last' })
    expect(plan.html).toContain('<svg')
    expect(plan.html).toContain('Документ подписан электронной подписью')
    expect(plan.html).toContain(regNumber)
    expect(plan.images).toHaveLength(1)
    const [image] = plan.images
    expect(image.dataUri).toMatch(/^data:image\/png;base64,/)
    expect(image.anchors).toEqual([
      { text: '[[SIGN]]', mode: 'cover' },
      expect.objectContaining({ mode: 'left' }),
    ])
    expect(image.manual).toBeNull()
    signatureId = image.id

    const finished = await engine(`/internal/documents/renders/${renderId}/done`, {
      status: 'ready',
      size: 1024,
      pages: 1,
      placements: [{ id: signatureId, page: 1, x: 0.3, y: 0.7, source: 'name' }],
    })
    expect(finished.statusCode, finished.body).toBe(200)
    const [version] = await versionsOf(people.author, doc.id)
    expect(version.id).toBe(versionId)
    expect(version.signedCopy).toMatchObject({ mime: 'application/pdf' })
    const [signature] = await signaturesOf(people.author, doc.id)
    expect(signature).toMatchObject({
      id: signatureId,
      facsimile: true,
      placement: { page: 1, x: 0.3, y: 0.7, source: 'name' },
    })
  })

  it('место факсимиле правит подписант — экземпляр строится заново с этим местом', async () => {
    const stranger = await call(fx.app, {
      method: 'PUT',
      url: `/documents/${doc.id}/signatures/${signatureId}/placement`,
      as: fx.users.stranger,
      payload: { page: 1, x: 0.5, y: 0.5 },
    })
    expect(stranger.statusCode).toBe(404)
    const placed = await call(fx.app, {
      method: 'PUT',
      url: `/documents/${doc.id}/signatures/${signatureId}/placement`,
      as: people.boss,
      payload: { page: 1, x: 0.62, y: 0.55 },
    })
    expect(placed.statusCode, placed.body).toBe(200)
    expect(placed.json()).toMatchObject({ placement: { source: 'manual', x: 0.62 } })

    const renderId = await DocumentRenders.scheduleSignedCopy(doc.id)
    expect(renderId).toBeTruthy()
    const start = await engine(`/internal/documents/renders/${renderId}/start`)
    expect(start.json().plan.images[0].manual).toEqual({ page: 1, x: 0.62, y: 0.55 })
    // Движок вернул своё место — выбранное человеком остаётся
    await engine(`/internal/documents/renders/${renderId}/done`, {
      status: 'ready',
      size: 1024,
      pages: 1,
      placements: [{ id: signatureId, page: 1, x: 0.62, y: 0.55, source: 'manual' }],
    })
    const [row] = await db()
      .select({ placement: documentSignatures.placement })
      .from(documentSignatures)
      .where(eq(documentSignatures.id, signatureId))
    expect(row?.placement).toMatchObject({ source: 'manual', x: 0.62 })
    const renders = await db()
      .select({ id: documentRenders.id })
      .from(documentRenders)
      .where(
        and(eq(documentRenders.subjectId, doc.id), eq(documentRenders.formKey, 'signature_stamp')),
      )
    expect(renders).toHaveLength(2)
  })

  it('страница проверки: без входа, реквизиты подписи без содержания документа', async () => {
    const page = await call(fx.app, { url: `/verify/${signatureId}` })
    expect(page.statusCode).toBe(200)
    expect(page.headers['content-type']).toContain('text/html')
    expect(String(page.headers['content-security-policy'])).toContain("default-src 'none'")
    expect(page.body).toContain('Подпись верна')
    expect(page.body).toContain(await displayName(people.boss))
    expect(page.body).not.toContain('Секретная тема')
    expect(page.body).not.toContain('<script')

    const english = await call(fx.app, {
      url: `/verify/${signatureId}`,
      headers: { 'accept-language': 'en-US,en;q=0.9' },
    })
    expect(english.body).toContain('Electronic signature check')

    const missing = await call(fx.app, { url: `/verify/${randomUUID()}` })
    expect(missing.statusCode).toBe(404)
    expect(missing.body).toContain('Подпись не найдена')
    // Не идентификатор — отказ проверкой параметра, до базы
    expect((await call(fx.app, { url: '/verify/not-a-uuid' })).statusCode).toBe(400)
  })

  it('у конфиденциального документа страница показывает только состояние подписи', async () => {
    const clearance = await call(fx.app, {
      method: 'PUT',
      url: `/users/${people.boss.id}/clearance`,
      as: fx.admin,
      payload: { clearance: 'confidential', reason: 'подписывает конфиденциальные записки' },
    })
    expect(clearance.statusCode, clearance.body).toBe(200)
    await call(fx.app, {
      method: 'PUT',
      url: `/users/${people.author.id}/clearance`,
      as: fx.admin,
      payload: { clearance: 'confidential', reason: 'автор конфиденциальной записки' },
    })
    const { doc: secret } = await signedMemo({ extra: { confidentiality: 'confidential' } })
    const [signature] = await signaturesOf(people.author, secret.id)
    const page = await call(fx.app, { url: `/verify/${signature.id}` })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Подпись верна')
    expect(page.body).not.toContain(await displayName(people.boss))
    expect(page.body).not.toContain('SHA-256')
    // Событие правки места — в журнале событий, как у любого изменения
    const events = await db().execute<{ total: number }>(
      sql`SELECT count(*)::int AS total FROM ops.outbox WHERE event->>'type' = 'document.signature_placed'`,
    )
    expect(events[0]?.total).toBeGreaterThan(0)
  })
})
