import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
 * Исходящий письмом (ADR-0149): постановка проверяет права, гриф и вложения; задание
 * отправляет письмо с PDF версии из ящика канцелярии; отметка в реестре отправки — только
 * после того, как сервер принял письмо; сбой и возврат — состояние, уведомление и повтор.
 * SMTP — mailpit стенда разработки.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { DocumentMailOut } = await import('../src/modules/documents/domain/mail-out.js')
const { systemCtx } = await import('../src/shared/context.js')
const { documents } = await import('../src/shared/db/schema/index.js')
const { resetConfigCache } = await import('../src/shared/config/env.js')
const { resetMailer } = await import('../src/shared/mail/index.js')

const run = Date.now().toString(36)
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8026'
const SMTP_URL = process.env.SMTP_URL

let fx: TestContext
let registrar: TestUser
let clerk: TestUser
const types = new Map<string, string>()
let ministry = ''
const address = `minfin-${run}@example.tj`

const post = (as: TestUser, url: string, payload: Record<string, unknown> = {}) =>
  call(fx.app, { method: 'POST', url, as, payload })

interface EmailBody {
  id: string
  status: string
  messageId: string | null
  error: string | null
  dispatchId: string | null
  to: string
}

async function emailsOf(id: string): Promise<EmailBody[]> {
  const response = await call(fx.app, { url: `/documents/${id}/emails`, as: registrar })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().items
}

/** Зарегистрированный исходящий с PDF версии — адресат Минфин. */
async function registeredOutgoing(subject: string): Promise<{ id: string; regNumber: string }> {
  const created = await post(registrar, '/documents', {
    typeId: types.get('outgoing_letter'),
    subject,
    correspondentId: ministry,
  })
  expect(created.statusCode, created.body).toBe(200)
  const id = created.json().id as string
  const doc = (await call(fx.app, { url: `/documents/${id}`, as: registrar })).json()
  const pdf = await uploadFile(fx.app, registrar, {
    spaceId: doc.spaceId,
    name: `письмо-${run}.pdf`,
    mime: 'application/pdf',
    content: '%PDF-1.4 исходящее письмо',
    attachToObjectId: id,
  })
  const version = await post(registrar, `/documents/${id}/versions`, { mainFileId: pdf.id })
  expect(version.statusCode, version.body).toBe(200)
  const registered = await post(registrar, `/documents/${id}/register`)
  expect(registered.statusCode, registered.body).toBe(200)
  return { id, regNumber: registered.json().regNumber }
}

function useSmtp(url: string | undefined): void {
  if (url === undefined) delete process.env.SMTP_URL
  else process.env.SMTP_URL = url
  resetConfigCache()
  resetMailer()
}

beforeAll(async () => {
  fx = await setupFixture()
  registrar = await createUser(fx.app, `registrar_mail_${run}`, ['employee', 'registrar'])
  clerk = await createUser(fx.app, `clerk_mail_${run}`, ['employee'])
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  const typeList = await call(fx.app, { url: '/document-types', as: fx.admin })
  for (const item of typeList.json().items as Array<{ id: string; key: string }>) {
    types.set(item.key, item.id)
  }
  const found = await call(fx.app, { url: '/correspondents?q=Минфин', as: registrar })
  ministry = found.json().items[0].id
  const patched = await call(fx.app, {
    method: 'PATCH',
    url: `/correspondents/${ministry}`,
    as: fx.admin,
    payload: { contacts: { email: address } },
  })
  expect(patched.statusCode, patched.body).toBe(200)
})

afterAll(() => useSmtp(SMTP_URL))

describe('исходящий письмом', () => {
  it('письмо уходит с PDF на адрес корреспондента, отметка отправки — после приёма сервером', async () => {
    const outgoing = await registeredOutgoing(`О готовности к паводку ${run}`)
    expect((await post(clerk, `/documents/${outgoing.id}/emails`)).statusCode).toBe(404)

    const status = await call(fx.app, { url: '/documents/mail-out/status', as: registrar })
    expect(status.json()).toMatchObject({ configured: true })

    const queued = await post(registrar, `/documents/${outgoing.id}/emails`, {
      message: 'Прошу подтвердить получение.',
    })
    expect(queued.statusCode, queued.body).toBe(200)
    // Пока письмо в очереди, в реестре отправки его нет и документ не исполнен
    expect(queued.json()).toMatchObject({ status: 'registered', dispatchCount: 0 })
    const [email] = await emailsOf(outgoing.id)
    expect(email).toMatchObject({ status: 'queued', to: address })

    expect(await DocumentMailOut.send(email?.id as string)).toEqual({ status: 'sent' })
    const [sent] = await emailsOf(outgoing.id)
    expect(sent?.status).toBe('sent')
    expect(sent?.messageId).toMatch(/^<kchs-[0-9a-f-]{36}@/)
    expect(sent?.dispatchId).not.toBeNull()

    const doc = (await call(fx.app, { url: `/documents/${outgoing.id}`, as: registrar })).json()
    expect(doc).toMatchObject({ status: 'executed', dispatchCount: 1 })
    const dispatches = (
      await call(fx.app, { url: `/documents/${outgoing.id}/dispatches`, as: registrar })
    ).json().items as Array<{ method: string; tracking: string | null }>
    expect(dispatches).toEqual([
      expect.objectContaining({ method: 'email', tracking: sent?.messageId }),
    ])

    // Письмо — в почтовом ящике адресата (mailpit): тема с номером, PDF во вложении
    const found = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`,
    )
    const messages = (
      (await found.json()) as {
        messages: Array<{ Subject: string; Attachments: number }>
      }
    ).messages
    expect(messages[0]?.Subject).toContain(outgoing.regNumber)
    expect(messages[0]?.Attachments).toBeGreaterThanOrEqual(1)
  })

  it('гриф «Конфиденциально» почтой не уходит; адрес обязателен', async () => {
    const outgoing = await registeredOutgoing(`Конфиденциально ${run}`)
    await db()
      .update(documents)
      .set({ confidentiality: 'confidential' })
      .where(eq(documents.id, outgoing.id))
    expect((await post(registrar, `/documents/${outgoing.id}/emails`)).statusCode).toBe(403)

    const plain = await registeredOutgoing(`Без адреса ${run}`)
    const noAddress = await post(registrar, `/documents/${plain.id}/emails`, {
      correspondentId: null,
      to: null,
    })
    // Корреспондент документа — Минфин с адресом: без явного адреса берётся его
    expect(noAddress.statusCode, noAddress.body).toBe(200)
    const bad = await post(registrar, `/documents/${plain.id}/emails`, { to: 'не-адрес' })
    expect(bad.statusCode).toBe(400)
  })

  it('письмо не ушло — состояние, уведомление, повтор; вернулось — «Вернулось»', async () => {
    const outgoing = await registeredOutgoing(`Сбой отправки ${run}`)
    const queued = await post(registrar, `/documents/${outgoing.id}/emails`, { to: address })
    expect(queued.statusCode, queued.body).toBe(200)
    const [email] = await emailsOf(outgoing.id)

    useSmtp('smtp://127.0.0.1:1')
    expect(await DocumentMailOut.send(email?.id as string)).toEqual({ status: 'failed' })
    const [failed] = await emailsOf(outgoing.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBeTruthy()
    const doc = (await call(fx.app, { url: `/documents/${outgoing.id}`, as: registrar })).json()
    expect(doc).toMatchObject({ status: 'registered', dispatchCount: 0 })

    useSmtp(SMTP_URL)
    const retry = await post(registrar, `/documents/${outgoing.id}/emails/${email?.id}/retry`)
    expect(retry.statusCode, retry.body).toBe(200)
    expect((await emailsOf(outgoing.id))[0]?.status).toBe('queued')
    expect(await DocumentMailOut.send(email?.id as string)).toEqual({ status: 'sent' })
    const [sent] = await emailsOf(outgoing.id)

    // Уведомление о недоставке из ящика канцелярии находит письмо по Message-ID
    expect(
      await DocumentMailOut.bounced([sent?.messageId as string], '550 Mailbox not found'),
    ).toBe(true)
    const [bounced] = await emailsOf(outgoing.id)
    expect(bounced).toMatchObject({ status: 'bounced', error: '550 Mailbox not found' })
    expect(await DocumentMailOut.bounced(['<чужое@example.org>'], 'x')).toBe(false)
  })
})
