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
 * Печатные формы, штамп регистрации, шаблоны DOCX, водяные знаки и сравнение
 * версий (08-documents.md §5, §8, §13; ADR-0085). Движок подменяют вызовы его
 * внутренних маршрутов с сервисным токеном: план берётся так же, как берёт его
 * движок, результат — под выданным api ключом.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { systemCtx } = await import('../src/shared/context.js')

const token = process.env.INTERNAL_SERVICE_TOKEN ?? ''
const run = Date.now().toString(36)

let fx: TestContext
let registrar: TestUser
let clerk: TestUser
let cleared: TestUser
const types = new Map<string, string>()
const journals = new Map<string, string>()
let ministry = ''

interface RenderBody {
  id: string
  kind: string
  status: string
  form: string | null
  file: { id: string; name: string; mime: string } | null
  error: string | null
}

const get = (as: TestUser, url: string) => call(fx.app, { url, as })

const engine = (path: string, payload: Record<string, unknown> = {}) =>
  call(fx.app, {
    method: 'POST',
    url: path,
    headers: { 'x-kchs-service-token': token },
    payload,
  })

/** Движок: план рендера с правами заказчика. */
async function start(renderId: string) {
  const response = await engine(`/internal/documents/renders/${renderId}/start`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as {
    status: 'render' | 'skip'
    reason?: string
    plan: Record<string, unknown> & { kind: string }
    target: { bucket: string; storageKey: string; fileName: string; contentType: string } | null
  }
}

/** Движок: результат под выданным ключом. */
async function done(renderId: string, payload: Record<string, unknown>) {
  const response = await engine(`/internal/documents/renders/${renderId}/done`, payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as { ok: boolean; stale: boolean }
}

async function createDocument(as: TestUser, typeKey: string, extra: Record<string, unknown> = {}) {
  const created = await call(fx.app, {
    method: 'POST',
    url: '/documents',
    as,
    payload: { typeId: types.get(typeKey), subject: `Документ ${run}`, ...extra },
  })
  expect(created.statusCode, created.body).toBe(200)
  const id = created.json().id as string
  return (await get(as, `/documents/${id}`)).json() as {
    id: string
    spaceId: string
    regNumber: string | null
    currentVersion: { id: string } | null
  }
}

/** Файл — вложение документа и версия с ним основным файлом. */
async function addVersion(
  as: TestUser,
  doc: { id: string; spaceId: string },
  file: { name: string; mime: string; content: string },
) {
  const uploaded = await uploadFile(fx.app, as, {
    spaceId: doc.spaceId,
    name: file.name,
    mime: file.mime,
    content: file.content,
    attachToObjectId: doc.id,
  })
  const version = await call(fx.app, {
    method: 'POST',
    url: `/documents/${doc.id}/versions`,
    as,
    payload: { mainFileId: uploaded.id },
  })
  expect(version.statusCode, version.body).toBe(200)
  return { fileId: uploaded.id, versionId: version.json().id as string }
}

async function registeredIncoming(extra: Record<string, unknown> = {}, as: TestUser = registrar) {
  const doc = await createDocument(as, 'incoming_letter', {
    correspondentId: ministry,
    receivedDate: '2026-09-18',
    externalNumber: `01-02/${run}`,
    externalDate: '2026-09-15',
    deliveryMethod: 'post',
    ...extra,
  })
  const version = await addVersion(as, doc, {
    name: `скан-${run}.pdf`,
    mime: 'application/pdf',
    content: '%PDF-1.4 скан входящего письма',
  })
  const registered = await call(fx.app, {
    method: 'POST',
    url: `/documents/${doc.id}/register`,
    as,
    payload: {},
  })
  expect(registered.statusCode, registered.body).toBe(200)
  return { ...doc, regNumber: registered.json().regNumber as string, ...version }
}

async function print(as: TestUser, subjectId: string, form: string, params = {}) {
  return call(fx.app, {
    method: 'POST',
    url: '/documents/prints',
    as,
    payload: { subjectId, form, params },
  })
}

/** Подписчики модуля документов по неопубликованным событиям — как воркер. */
async function drainOutbox(): Promise<void> {
  const { listSubscribers, matchesType } = await import('../src/kernel/events/bus.js')
  if (!listSubscribers().some((subscriber) => subscriber.name === 'documents-stamp')) {
    const { registerDocumentsBackground } = await import('../src/modules/documents/module.js')
    registerDocumentsBackground()
  }
  const rows = await db().execute<{ id: number; event: unknown }>(
    sql`SELECT id, event FROM ops.outbox WHERE published_at IS NULL ORDER BY id LIMIT 2000`,
  )
  for (const row of rows) {
    const event = row.event as { type: string }
    for (const subscriber of listSubscribers()) {
      if (!subscriber.name.startsWith('documents-')) continue
      if (!matchesType(subscriber.types, event.type)) continue
      await subscriber.handle(event as never)
    }
    await db().execute(sql`UPDATE ops.outbox SET published_at = now() WHERE id = ${row.id}`)
  }
}

const setClearance = (user: TestUser, clearance: string) =>
  call(fx.app, {
    method: 'PUT',
    url: `/users/${user.id}/clearance`,
    as: fx.admin,
    payload: { clearance, reason: 'Допуск по приказу о режиме секретности' },
  })

async function auditRows(action: string, objectId: string) {
  return db().execute<{
    actor_id: string | null
    severity: string
    details: Record<string, unknown>
  }>(
    sql`SELECT actor_id, severity, details FROM audit_log
         WHERE action = ${action} AND object_id = ${objectId} ORDER BY id`,
  )
}

beforeAll(async () => {
  fx = await setupFixture()
  registrar = await createUser(fx.app, 'registrar_print', ['employee', 'registrar'])
  clerk = await createUser(fx.app, 'clerk_print', ['employee', 'registrar'])
  cleared = await createUser(fx.app, 'cleared_print', ['employee'])
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  for (const item of (await get(fx.admin, '/document-types')).json().items as Array<{
    id: string
    key: string
  }>) {
    types.set(item.key, item.id)
  }
  for (const item of (await get(fx.admin, '/journals')).json().items as Array<{
    id: string
    name: string
  }>) {
    journals.set(item.name, item.id)
  }
  ministry = (await get(registrar, '/correspondents?q=Минфин')).json().items[0].id
  expect((await setClearance(registrar, 'confidential')).statusCode).toBe(200)
  expect((await setClearance(cleared, 'confidential')).statusCode).toBe(200)
})

describe('печатные формы', () => {
  it('список форм — из printForms типа, с причиной недоступности', async () => {
    const draft = await createDocument(registrar, 'incoming_letter')
    const forms = (await get(registrar, `/documents/print-forms?subjectId=${draft.id}`)).json()
      .items as Array<{ key: string; available: boolean; reasonKey: string | null }>
    // Формы типа и листы маршрута и ознакомления — последние у любого документа
    expect(forms.map((form) => form.key).sort()).toEqual([
      'acknowledgment_sheet',
      'approval_sheet',
      'registration_card',
      'registration_stamp',
      'signature_sheet',
    ])
    expect(forms.find((form) => form.key === 'registration_stamp')).toMatchObject({
      available: false,
      reasonKey: 'documents.print.reasons.notRegistered',
    })
    expect(forms.find((form) => form.key === 'approval_sheet')).toMatchObject({
      available: false,
      reasonKey: 'documents.print.reasons.noRoute',
    })

    // Исходящее: только листы, пока без данных; реестр отправки — форма журнала
    const outgoing = await createDocument(registrar, 'outgoing_letter')
    const outgoingForms = (
      await get(registrar, `/documents/print-forms?subjectId=${outgoing.id}`)
    ).json().items as Array<{ key: string; available: boolean }>
    expect(outgoingForms.map((form) => form.key).sort()).toEqual([
      'acknowledgment_sheet',
      'approval_sheet',
      'signature_sheet',
    ])
    expect(outgoingForms.every((form) => !form.available)).toBe(true)
    const journalForms = (
      await get(registrar, `/documents/print-forms?subjectId=${journals.get('Исходящие')}`)
    ).json().items as Array<{ key: string; params: string[] }>
    expect(journalForms).toEqual([
      expect.objectContaining({ key: 'dispatch_register', params: ['period'] }),
    ])
    // Форма не из printForms типа не заказывается
    expect((await print(registrar, outgoing.id, 'registration_card')).statusCode).toBe(400)
    // Чужой документ — как несуществующий
    expect(
      (await get(fx.users.stranger, `/documents/print-forms?subjectId=${draft.id}`)).statusCode,
    ).toBe(404)
  })

  it('регистрационная карточка: план с экранированием, файл — вложение документа', async () => {
    const doc = await registeredIncoming({
      subject: `<script>alert(1)</script> Смета & «план» ${run}`,
    })
    const ordered = await print(registrar, doc.id, 'registration_card')
    expect(ordered.statusCode, ordered.body).toBe(200)
    const render = ordered.json() as RenderBody
    expect(render).toMatchObject({ kind: 'print', status: 'queued', form: 'registration_card' })
    // Повторное нажатие, пока рендер в работе, — тот же рендер
    expect((await print(registrar, doc.id, 'registration_card')).json().id).toBe(render.id)

    const [job] = await db().execute<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM jobs WHERE name = 'document.render'
           AND idempotency_key = ${`document.render:${render.id}`}`,
    )
    expect(job?.payload).toEqual({ renderId: render.id })

    // Без сервисного токена движок плана не получает
    const anonymous = await call(fx.app, {
      method: 'POST',
      url: `/internal/documents/renders/${render.id}/start`,
    })
    expect(anonymous.statusCode).toBe(401)

    const planned = await start(render.id)
    expect(planned.status).toBe('render')
    expect(planned.plan.kind).toBe('html')
    const html = String(planned.plan.html)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Смета &amp; «план»')
    expect(html).not.toContain('<script>')
    expect(html).toContain(doc.regNumber)
    expect(html).toContain('Министерство финансов')
    expect(planned.target?.storageKey).toMatch(
      new RegExp(`^spaces/${doc.spaceId}/files/[0-9a-f-]{36}/[0-9a-f-]{36}/render\\.pdf$`),
    )
    // «/» в имени файла недопустим — номер в имени через дефис
    expect(planned.target?.fileName).toContain(doc.regNumber.replace('/', '-'))

    expect(await done(render.id, { status: 'ready', size: 2048, pages: 1 })).toEqual({
      ok: true,
      stale: false,
    })
    // Повторный отчёт — устаревший
    expect((await done(render.id, { status: 'ready', size: 2048 })).stale).toBe(true)
    const ready = (await get(registrar, `/documents/renders/${render.id}`)).json() as RenderBody
    expect(ready.status).toBe('ready')
    expect(ready.file?.mime).toBe('application/pdf')
    // Файл печатной формы — вложение документа: права и гриф документа
    const fileId = ready.file?.id ?? ''
    expect((await get(registrar, `/files/${fileId}`)).statusCode).toBe(200)
    expect((await get(fx.users.stranger, `/files/${fileId}`)).statusCode).toBe(404)
    const listed = (await get(registrar, `/documents/renders?subjectId=${doc.id}`)).json()
      .items as RenderBody[]
    expect(listed.map((item) => item.id)).toContain(render.id)
  })

  it('права проверяются в момент рендера: без доступа рендер не выполняется', async () => {
    const doc = await registeredIncoming()
    // Делопроизводитель видит документ журнала; даём доступ коллеге и заказываем печать от него
    const shared = await call(fx.app, {
      method: 'POST',
      url: `/objects/${doc.id}/access`,
      as: fx.admin,
      payload: { grants: [{ principal: { type: 'user', id: fx.users.member.id }, level: 'view' }] },
    })
    expect(shared.statusCode, shared.body).toBe(200)
    const ordered = await print(fx.users.member, doc.id, 'registration_card')
    expect(ordered.statusCode, ordered.body).toBe(200)
    const renderId = ordered.json().id as string
    // Доступ отозван до того, как движок взялся за рендер
    const revoked = await call(fx.app, {
      method: 'DELETE',
      url: `/objects/${doc.id}/access`,
      as: fx.admin,
      payload: { principal: { type: 'user', id: fx.users.member.id } },
    })
    expect(revoked.statusCode, revoked.body).toBe(200)
    const planned = await start(renderId)
    expect(planned).toMatchObject({ status: 'skip', reason: 'no_access' })
    const [row] = await db().execute<{ status: string }>(
      sql`SELECT status FROM document_renders WHERE id = ${renderId}`,
    )
    expect(row?.status).toBe('failed')
  })

  it('штамп регистрации ставится сам, на копию PDF текущей версии', async () => {
    const doc = await registeredIncoming()
    await drainOutbox()
    const [stamp] = await db().execute<{ id: string; status: string; dedupe_key: string }>(
      sql`SELECT id, status, dedupe_key FROM document_renders
           WHERE subject_id = ${doc.id} AND form_key = 'registration_stamp'`,
    )
    expect(stamp?.dedupe_key).toBe(`stamp:${doc.id}:${doc.versionId}:${doc.regNumber}`)
    // Повторная доставка события штамп не удваивает
    await db().execute(
      sql`UPDATE ops.outbox SET published_at = NULL
           WHERE event->>'type' = 'document.registered' AND event->'object'->>'id' = ${doc.id}`,
    )
    await drainOutbox()
    const [{ count }] = (await db().execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM document_renders
           WHERE subject_id = ${doc.id} AND form_key = 'registration_stamp'`,
    )) as unknown as [{ count: number }]
    expect(count).toBe(1)

    const planned = await start(stamp?.id ?? '')
    expect(planned.plan).toMatchObject({ kind: 'overlay', pages: 'first' })
    const source = planned.plan.source as { storageKey: string; mime: string }
    expect(source.mime).toBe('application/pdf')
    // Исходник — PDF версии; результат — отдельный файл
    expect(source.storageKey).toContain(`/files/${doc.fileId}/`)
    expect(planned.target?.storageKey).not.toContain(doc.fileId)
    expect(String(planned.plan.html)).toContain(doc.regNumber)
    expect(String(planned.plan.html)).toContain('Вх. №')
    await done(stamp?.id ?? '', { status: 'ready', size: 4096, pages: 1 })
    // Версия и её хэш не меняются: текущая версия — та же
    const card = (await get(registrar, `/documents/${doc.id}`)).json()
    expect(card.currentVersion.id).toBe(doc.versionId)
    expect(card.versionCount).toBe(1)
  })

  it('реестр отправки: период обязателен, строки — только видимые печатающему', async () => {
    const journalId = journals.get('Исходящие') ?? ''
    const register = (as: TestUser, id: string) =>
      call(fx.app, { method: 'POST', url: `/documents/${id}/register`, as, payload: {} })
    const visible = await createDocument(registrar, 'outgoing_letter', {
      subject: `Ответ на запрос ${run}`,
      fields: { addressee: 'Хукумат Согдийской области' },
    })
    expect((await register(registrar, visible.id)).statusCode).toBe(200)
    // Конфиденциальное письмо: делопроизводителю без допуска его строки в реестре нет
    const secretLetter = await createDocument(registrar, 'outgoing_letter', {
      subject: `Конфиденциальный ответ ${run}`,
      confidentiality: 'confidential',
    })
    expect((await register(registrar, secretLetter.id)).statusCode).toBe(200)

    expect((await print(registrar, journalId, 'dispatch_register')).statusCode).toBe(400)
    const tooLong = await print(registrar, journalId, 'dispatch_register', {
      period: { from: '2025-01-01', to: '2026-12-31' },
    })
    expect(tooLong.statusCode).toBe(400)

    // Дата регистрации — по часам организации: период с запасом на весь год
    const period = { from: '2026-01-01', to: '2026-12-31' }
    // Журнал виден делопроизводителям (роль registrar), не всем сотрудникам
    expect(
      (await print(fx.users.member, journalId, 'dispatch_register', { period })).statusCode,
    ).toBe(404)

    const withClearance = await print(registrar, journalId, 'dispatch_register', { period })
    expect(withClearance.statusCode, withClearance.body).toBe(200)
    const planned = await start(withClearance.json().id)
    expect(planned.plan).toMatchObject({ kind: 'html', orientation: 'landscape' })
    const html = String(planned.plan.html)
    expect(html).toContain(`Ответ на запрос ${run}`)
    expect(html).toContain('Хукумат Согдийской области')
    expect(html).toContain(`Конфиденциальный ответ ${run}`)

    const withoutClearance = await print(clerk, journalId, 'dispatch_register', { period })
    expect(withoutClearance.statusCode, withoutClearance.body).toBe(200)
    const clerkHtml = String((await start(withoutClearance.json().id)).plan.html)
    expect(clerkHtml).toContain(`Ответ на запрос ${run}`)
    expect(clerkHtml).not.toContain(`Конфиденциальный ответ ${run}`)
  })
})

describe('гриф и водяной знак', () => {
  let secret: Awaited<ReturnType<typeof registeredIncoming>>

  beforeAll(async () => {
    secret = await registeredIncoming({
      subject: `Конфиденциальная тема ${run}`,
      confidentiality: 'confidential',
      controllerId: cleared.id,
    })
  })

  it('печать конфиденциального — в аудит; файл формы — под грифом документа', async () => {
    const ordered = await print(registrar, secret.id, 'registration_card')
    expect(ordered.statusCode, ordered.body).toBe(200)
    const renderId = ordered.json().id as string
    const rows = await auditRows('document.printed', secret.id)
    expect(rows.at(-1)).toMatchObject({ actor_id: registrar.id, severity: 'notice' })
    expect(rows.at(-1)?.details).toMatchObject({ form: 'registration_card', renderId })
    await start(renderId)
    await done(renderId, { status: 'ready', size: 1000, pages: 1 })
    const fileId = ((await get(registrar, `/documents/renders/${renderId}`)).json() as RenderBody)
      .file?.id
    // Сотрудник без допуска не видит ни документ, ни его печатную форму
    expect((await get(fx.users.member, `/files/${fileId}`)).statusCode).toBe(404)
  })

  it('исходник — только в режиме администратора, остальным — копия со знаком', async () => {
    const denied = await get(cleared, `/files/${secret.fileId}/download`)
    expect(denied.statusCode).toBe(403)
    expect(denied.json().data).toMatchObject({
      reason: 'watermark_required',
      confidentiality: 'confidential',
    })
    // Просмотр — с водяным знаком: гриф, кто смотрит
    const previews = (await get(cleared, `/files/${secret.fileId}/previews`)).json()
    expect(previews.watermark.lines[0]).toBe('Конфиденциально')
    expect(previews.watermark.lines[1]).toContain('cleared_print')

    // Копия со знаком: заказ в аудит, план — наложение на все листы с именем смотрящего
    const ordered = await call(fx.app, {
      method: 'POST',
      url: '/documents/watermarked',
      as: cleared,
      payload: { fileId: secret.fileId },
    })
    expect(ordered.statusCode, ordered.body).toBe(200)
    const renderId = ordered.json().id as string
    expect((await auditRows('document.file_exported', secret.fileId)).at(-1)).toMatchObject({
      actor_id: cleared.id,
    })
    const planned = await start(renderId)
    expect(planned.plan).toMatchObject({ kind: 'overlay', pages: 'all' })
    expect(String(planned.plan.html)).toContain('cleared_print')
    expect(planned.target?.storageKey).toBe(`documents/watermarks/${renderId}/copy.pdf`)
    // До готовности скачать нечего; чужую копию не видно
    expect((await get(cleared, `/documents/renders/${renderId}/download`)).statusCode).toBe(409)
    await done(renderId, { status: 'ready', size: 5000, pages: 1 })
    const link = await get(cleared, `/documents/renders/${renderId}/download`)
    expect(link.statusCode, link.body).toBe(200)
    expect(link.json().name).toContain('копия с водяным знаком')
    expect((await get(registrar, `/documents/renders/${renderId}/download`)).statusCode).toBe(404)
    expect((await get(registrar, `/documents/renders/${renderId}`)).statusCode).toBe(404)

    // Файл без грифа копии не требует
    const plain = await registeredIncoming({ confidentiality: 'internal' })
    expect((await get(registrar, `/files/${plain.fileId}/download`)).statusCode).toBe(200)
    const noMark = await call(fx.app, {
      method: 'POST',
      url: '/documents/watermarked',
      as: registrar,
      payload: { fileId: plain.fileId },
    })
    expect(noMark.statusCode).toBe(409)
    expect((await get(registrar, `/files/${plain.fileId}/previews`)).json().watermark).toBeNull()
  })

  it('администратор в режиме скачивает исходник — с аудитом', async () => {
    const entered = await call(fx.app, {
      method: 'POST',
      url: '/me/admin-mode',
      as: fx.admin,
      payload: { reason: 'Проверка копии по запросу прокуратуры', minutes: 5 },
    })
    expect(entered.statusCode, entered.body).toBe(200)
    const original = await get(fx.admin, `/files/${secret.fileId}/download`)
    expect(original.statusCode, original.body).toBe(200)
    const rows = await auditRows('file.downloaded', secret.fileId)
    expect(rows.at(-1)).toMatchObject({ actor_id: fx.admin.id, severity: 'warning' })
    expect(rows.at(-1)?.details).toMatchObject({ confidentiality: 'confidential', original: true })
    await call(fx.app, { method: 'DELETE', url: '/me/admin-mode', as: fx.admin })
  })
})

describe('шаблоны DOCX', () => {
  it('стартовый бланк исходящего письма — готов к заполнению', async () => {
    const list = (
      await get(fx.users.member, `/document-templates?typeId=${types.get('outgoing_letter')}`)
    ).json().items as Array<{
      name: string
      inspectStatus: string
      placeholders: string[]
      unknownPlaceholders: string[]
      file: { name: string } | null
      canManage: boolean
    }>
    const starter = list.find((item) => item.name === 'Исходящее письмо — бланк')
    expect(starter).toMatchObject({
      inspectStatus: 'ready',
      unknownPlaceholders: [],
      canManage: false,
    })
    expect(starter?.file?.name).toBe('Исходящее письмо.docx')
    expect(starter?.placeholders).toEqual(
      expect.arrayContaining(['doc.subject', 'doc.fields.addressee', 'signer.short_name']),
    )
  })

  it('справочник ведут владельцы способности; разбор плейсхолдеров движком', async () => {
    const payload = { name: `Ответ на обращение ${run}`, typeId: types.get('outgoing_letter') }
    // Справочник ведут владельцы способности (делопроизводитель, администратор), не все сотрудники
    expect(
      (
        await call(fx.app, {
          method: 'POST',
          url: '/document-templates',
          as: fx.users.member,
          payload,
        })
      ).statusCode,
    ).toBe(403)
    const created = await call(fx.app, {
      method: 'POST',
      url: '/document-templates',
      as: fx.admin,
      payload: { ...payload, defaults: { subject: 'Ответ на обращение' } },
    })
    expect(created.statusCode, created.body).toBe(200)
    const template = created.json() as { id: string; spaceId: string; inspectStatus: string }
    expect(template.inspectStatus).toBe('none')

    // Не DOCX — отклоняется
    const text = await uploadFile(fx.app, fx.admin, {
      spaceId: template.spaceId,
      name: 'шаблон.txt',
      content: 'не шаблон',
      attachToObjectId: template.id,
    })
    const wrong = await call(fx.app, {
      method: 'POST',
      url: `/document-templates/${template.id}/file`,
      as: fx.admin,
      payload: { fileId: text.id },
    })
    expect(wrong.statusCode).toBe(400)

    const docx = await uploadFile(fx.app, fx.admin, {
      spaceId: template.spaceId,
      name: 'ответ.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: 'PK шаблон',
      attachToObjectId: template.id,
    })
    const attached = await call(fx.app, {
      method: 'POST',
      url: `/document-templates/${template.id}/file`,
      as: fx.admin,
      payload: { fileId: docx.id },
    })
    expect(attached.statusCode, attached.body).toBe(200)
    expect(attached.json().inspectStatus).toBe('pending')
    const [inspect] = await db().execute<{ id: string }>(
      sql`SELECT id FROM document_renders WHERE subject_id = ${template.id} AND kind = 'inspect'`,
    )
    const planned = await start(inspect?.id ?? '')
    expect(planned).toMatchObject({ status: 'render', target: null })
    expect(planned.plan).toMatchObject({ kind: 'inspect' })
    await done(inspect?.id ?? '', {
      status: 'ready',
      placeholders: ['doc.subject', 'doc.fields.addressee', 'doc.fields.nonexistent', 'foo.bar'],
    })
    const inspected = (await get(fx.admin, `/document-templates/${template.id}`)).json()
    expect(inspected).toMatchObject({
      inspectStatus: 'ready',
      unknownPlaceholders: ['doc.fields.nonexistent', 'foo.bar'],
    })
    expect(inspected.placeholders).toHaveLength(4)

    // Ошибка шаблона — причина видна автору
    await call(fx.app, {
      method: 'POST',
      url: `/document-templates/${template.id}/file`,
      as: fx.admin,
      payload: { fileId: docx.id },
    })
    const [again] = await db().execute<{ id: string }>(
      sql`SELECT id FROM document_renders WHERE subject_id = ${template.id} AND kind = 'inspect'
           AND status = 'queued'`,
    )
    await start(again?.id ?? '')
    await done(again?.id ?? '', { status: 'failed', error: "Ошибка в шаблоне: unexpected '}'" })
    expect((await get(fx.admin, `/document-templates/${template.id}`)).json()).toMatchObject({
      inspectStatus: 'failed',
      inspectError: "Ошибка в шаблоне: unexpected '}'",
    })
  })

  it('«Создать по шаблону»: карточка из шаблона, первая версия — DOCX от движка', async () => {
    const starter = (
      (await get(registrar, '/document-templates')).json().items as Array<{
        id: string
        name: string
      }>
    ).find((item) => item.name === 'Исходящее письмо — бланк')
    const created = await call(fx.app, {
      method: 'POST',
      url: '/documents/from-template',
      as: registrar,
      payload: {
        templateId: starter?.id,
        subject: `О предоставлении сведений ${run}`,
        summary: 'Направляем сведения <по запросу> & в срок',
        correspondentId: ministry,
        signerId: fx.admin.id,
        fields: { addressee: 'Министру финансов' },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const { id, renderId } = created.json() as { id: string; renderId: string }
    const planned = await start(renderId)
    expect(planned.plan.kind).toBe('docx')
    const context = planned.plan.context as {
      doc: {
        subject: string
        summary: string
        fields: Record<string, string>
        correspondent: { name: string }
      }
      author: { short_name: string; name: string }
      signer: { name: string }
      org: { name: string }
    }
    expect(context.doc.subject).toBe(`О предоставлении сведений ${run}`)
    // Значения — как есть: экранирует движок (автоэкранирование XML в песочнице)
    expect(context.doc.summary).toBe('Направляем сведения <по запросу> & в срок')
    expect(context.doc.fields.addressee).toBe('Министру финансов')
    expect(context.doc.correspondent.name).toContain('Министерство финансов')
    expect(context.author.short_name).toBe('Тестов R.')
    expect(context.signer.name).toBeTruthy()
    expect(planned.target?.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(planned.target?.fileName).toBe(`О предоставлении сведений ${run}.docx`)

    await done(renderId, { status: 'ready', size: 12_000 })
    const card = (await get(registrar, `/documents/${id}`)).json()
    expect(card.versionCount).toBe(1)
    expect(card.currentVersion).toMatchObject({
      pdfStatus: 'pending',
      note: 'По шаблону «Исходящее письмо — бланк»',
    })
    expect(card.currentVersion.mainFile.name).toBe(`О предоставлении сведений ${run}.docx`)

    // Перезаполнение — новая версия
    const refill = await call(fx.app, {
      method: 'POST',
      url: `/documents/${id}/fill`,
      as: registrar,
      payload: { templateId: starter?.id },
    })
    expect(refill.statusCode, refill.body).toBe(200)
    await start(refill.json().id)
    await done(refill.json().id, { status: 'ready', size: 12_500 })
    expect((await get(registrar, `/documents/${id}`)).json().versionCount).toBe(2)
    // Шаблон другого типа — отказ
    const memo = await createDocument(registrar, 'memo')
    const mismatch = await call(fx.app, {
      method: 'POST',
      url: `/documents/${memo.id}/fill`,
      as: registrar,
      payload: { templateId: starter?.id },
    })
    expect(mismatch.statusCode).toBe(400)
  })
})

describe('сравнение версий', () => {
  it('по словам — из извлечённого текста версий', async () => {
    const doc = await createDocument(registrar, 'memo')
    const first = await addVersion(registrar, doc, {
      name: 'v1.txt',
      mime: 'text/plain',
      content: 'Прошу выделить три машины для вывоза населения',
    })
    const second = await addVersion(registrar, doc, {
      name: 'v2.txt',
      mime: 'text/plain',
      content: 'Прошу срочно выделить пять машин для вывоза населения',
    })
    const compare = () =>
      get(
        registrar,
        `/documents/${doc.id}/versions/compare?from=${first.versionId}&to=${second.versionId}`,
      )
    // Текст ещё не извлечён — ждём
    expect((await compare()).json().status).toBe('pending')

    for (const [fileId, text] of [
      [first.fileId, 'Прошу выделить три машины для вывоза населения'],
      [second.fileId, 'Прошу срочно выделить пять машин для вывоза населения'],
    ] as const) {
      const [file] = await db().execute<{ version_id: string }>(
        sql`SELECT current_version_id AS version_id FROM files WHERE id = ${fileId}`,
      )
      const processed = await engine(`/internal/files/${fileId}/processed`, {
        versionId: file?.version_id,
        previewStatus: 'unsupported',
        textStatus: 'ready',
        text,
      })
      expect(processed.statusCode, processed.body).toBe(200)
    }
    const result = (await compare()).json()
    expect(result.status).toBe('ready')
    expect(result.from.number).toBe(1)
    expect(result.to.number).toBe(2)
    expect(result.stats).toEqual({ inserted: 3, deleted: 2, unchanged: 5 })
    const inserted = result.segments
      .filter((segment: { op: string }) => segment.op === 'insert')
      .map((segment: { text: string }) => segment.text.trim())
    expect(inserted.join(' ')).toContain('срочно')
    expect(inserted.join(' ')).toContain('пять машин')
    // Чужой документ — не найден
    expect(
      (
        await get(
          fx.users.stranger,
          `/documents/${doc.id}/versions/compare?from=${first.versionId}&to=${second.versionId}`,
        )
      ).statusCode,
    ).toBe(404)
  })
})
