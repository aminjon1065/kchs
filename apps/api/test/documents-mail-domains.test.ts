import type { MailboxConfig } from '@kchs/contracts'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import type { FetchedLetter, MailboxPort } from '../src/shared/mail/imap.js'
import { setMailboxPort } from '../src/shared/mail/imap.js'
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
 * Приём из почты по решениям N66–N67 (ADR-0136): почтовые домены ведомств в справочнике
 * корреспондентов (белый список), подстановка корреспондента по домену, самый точный домен,
 * общие почтовые сервисы — нет; очистка отклонённых и неразобранных писем через 180 дней
 * заданием единого планировщика.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { MailIntake } = await import('../src/modules/documents/domain/mail/mail-service.js')
const { systemCtx } = await import('../src/shared/context.js')
const { mailMessages } = await import('../src/shared/db/schema/index.js')
const { newId } = await import('../src/shared/ids.js')

const run = Date.now().toString(36)
const agency = `mvd-${run}.example.tj`

let fx: TestContext
let registrar: TestUser
let integrationId = ''
let inbox: FetchedLetter[] = []

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

const fakeMailbox: MailboxPort = {
  fetch: async (_config, _password, limit) => inbox.slice(0, limit),
  markSeen: async () => undefined,
  check: async () => ({ ok: true, message: 'Ящик открыт' }),
}

async function json(
  url: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  payload?: unknown,
  status = 200,
): Promise<Json> {
  const response = await call(fx.app, {
    method,
    url,
    as: registrar,
    ...(payload === undefined ? {} : { payload }),
  })
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status)
  return response.json()
}

/** Простое письмо без вложений: отправитель, тема, `Message-ID`. */
function eml(uid: number, from: string, subject: string): FetchedLetter {
  const source = [
    `From: Duty officer <${from}>`,
    'To: office@kchs.example.tj',
    `Subject: ${subject}`,
    `Message-ID: <${run}-${uid}@example.tj>`,
    'Date: Wed, 24 Sep 2026 09:00:00 +0500',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Informatsiya o dezhurstve.',
    '',
  ].join('\r\n')
  return { uid, uidValidity: '9', source: Buffer.from(source) }
}

beforeAll(async () => {
  fx = await setupFixture()
  registrar = await createUser(fx.app, `mreg_${run}`, ['employee', 'registrar'])
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  setMailboxPort(fakeMailbox)
  const config: Partial<MailboxConfig> = {
    host: 'imap.example.tj',
    port: 993,
    secure: true,
    user: 'office@kchs.example.tj',
    folder: 'INBOX',
    pollMinutes: 5,
    batchSize: 25,
    runAsUserId: registrar.id,
    documentTypeKey: 'incoming_letter',
    markSeen: true,
  }
  const created = await call(fx.app, {
    method: 'POST',
    url: '/integrations',
    as: fx.admin,
    payload: {
      key: `mailbox-${run}`,
      kind: 'imap',
      name: `Ящик ${run}`,
      enabled: true,
      config,
      secrets: { password: 'не-настоящий-пароль' },
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  integrationId = created.json().id
})

describe('почтовые домены ведомств', () => {
  let ministry = ''
  let department = ''
  let known = ''

  it('домены — белый список в карточке организации: без повторов и общих сервисов', async () => {
    const created = await json('/correspondents', 'POST', {
      name: `Министерство внутренних дел ${run}`,
      mailDomains: [`@MVD-${run}.example.tj`, `mvd-${run}.example.tj`],
    })
    ministry = created.id
    expect(created.mailDomains).toEqual([agency])

    // Домен принадлежит одному корреспонденту; поддомен — может другому
    const duplicate = await json(
      '/correspondents',
      'POST',
      { name: `Двойник ${run}`, mailDomains: [agency] },
      409,
    )
    expect(duplicate.detail).toContain(`Министерство внутренних дел ${run}`)
    department = (
      await json('/correspondents', 'POST', {
        name: `УВД города Душанбе ${run}`,
        mailDomains: [`dushanbe.${agency}`],
      })
    ).id

    await json('/correspondents', 'POST', { name: `Почта ${run}`, mailDomains: ['gmail.com'] }, 400)
    await json(
      '/correspondents',
      'POST',
      { name: `Лицо ${run}`, kind: 'person', mailDomains: [`p-${run}.example.tj`] },
      400,
    )
    known = (
      await json('/correspondents', 'POST', {
        name: `Агентство связи ${run}`,
        contacts: { email: `chief@${agency}` },
      })
    ).id

    // Правка: домен добавлен и снят — повторно занять его можно
    const patched = await json(`/correspondents/${department}`, 'PATCH', {
      mailDomains: [`dushanbe.${agency}`, `dsh-${run}.example.tj`],
    })
    expect(patched.mailDomains).toEqual([`dushanbe.${agency}`, `dsh-${run}.example.tj`])
  })

  it('письмо получает корреспондента по адресу, иначе по самому точному домену', async () => {
    inbox = [
      eml(1, `duty@${agency}`, `Сводка ${run}`),
      eml(2, `ops@post.dushanbe.${agency}`, `Сводка отдела ${run}`),
      eml(3, `chief@${agency}`, `Письмо руководителя ${run}`),
      eml(4, `citizen-${run}@gmail.com`, `Обращение ${run}`),
      eml(5, `noreply@tj`, `Без домена ${run}`),
    ]
    const report = await json(`/documents/mail/poll?integrationId=${integrationId}`, 'POST')
    expect(report.result).toMatchObject({ fetched: 5, created: 5 })

    const list = await json(`/documents/mail?q=${run}&limit=20`)
    const bySubject = new Map<string, Json>(
      (list.items as Json[]).map((item) => [item.subject, item]),
    )
    expect(bySubject.get(`Сводка ${run}`)).toMatchObject({
      correspondent: { id: ministry },
      correspondentMatch: 'domain',
      suggestedCorrespondentName: null,
      purgeAt: null,
    })
    expect(bySubject.get(`Сводка отдела ${run}`)).toMatchObject({
      correspondent: { id: department },
      correspondentMatch: 'domain',
    })
    expect(bySubject.get(`Письмо руководителя ${run}`)).toMatchObject({
      correspondent: { id: known },
      correspondentMatch: 'email',
    })
    for (const subject of [`Обращение ${run}`, `Без домена ${run}`]) {
      expect(bySubject.get(subject)).toMatchObject({
        correspondent: null,
        correspondentMatch: null,
      })
    }

    // Черновик входящего — с тем же корреспондентом
    const draft = await json(`/documents/${bySubject.get(`Сводка ${run}`).documentId}`)
    expect(draft.correspondent).toMatchObject({ id: ministry })
  })
})

describe('срок хранения очереди «Из почты»', () => {
  const day = 86_400_000
  const ago = (days: number) => new Date(Date.now() - days * day).toISOString()

  it('отклонённые и неразобранные старше 180 дней удаляются, остальное остаётся', async () => {
    const rows = {
      rejectedOld: { status: 'rejected', receivedAt: ago(300), decidedAt: ago(181) },
      failedOld: { status: 'failed', receivedAt: ago(200), decidedAt: null },
      rejectedRecently: { status: 'rejected', receivedAt: ago(400), decidedAt: ago(10) },
      failedRecent: { status: 'failed', receivedAt: ago(20), decidedAt: null },
      draftOld: { status: 'draft', receivedAt: ago(400), decidedAt: null },
      registeredOld: { status: 'registered', receivedAt: ago(400), decidedAt: ago(390) },
    } as const
    const ids = new Map<string, string>()
    for (const [name, row] of Object.entries(rows)) {
      const id = newId()
      ids.set(name, id)
      await db()
        .insert(mailMessages)
        .values({
          id,
          integrationId,
          messageKey: `purge-${run}-${name}`,
          fromEmail: `old@${agency}`,
          subject: `Старое письмо ${run} ${name}`,
          status: row.status,
          receivedAt: row.receivedAt,
          decidedAt: row.decidedAt,
          ...(row.status === 'rejected' ? { rejectReason: 'Рассылка' } : {}),
          ...(row.status === 'failed' ? { error: 'письмо не разобралось' } : {}),
        })
    }

    const before = await json(`/documents/mail/${ids.get('rejectedRecently')}`)
    const expected = new Date(Date.parse(rows.rejectedRecently.decidedAt) + 180 * day)
    expect(Date.parse(before.purgeAt)).toBe(expected.getTime())
    expect((await json(`/documents/mail/${ids.get('draftOld')}`)).purgeAt).toBeNull()

    expect(await MailIntake.purge()).toBeGreaterThanOrEqual(2)
    const left = await db().execute<{ message_key: string }>(
      sql`SELECT message_key FROM mail_messages WHERE message_key LIKE ${`purge-${run}-%`}`,
    )
    expect(left.map((row) => row.message_key.replace(`purge-${run}-`, '')).sort()).toEqual([
      'draftOld',
      'failedRecent',
      'registeredOld',
      'rejectedRecently',
    ])
    const events = await db().execute<{ event: Json }>(
      sql`SELECT event FROM ops.outbox WHERE event->>'type' = 'mail.purged' ORDER BY id DESC LIMIT 1`,
    )
    expect(events[0]?.event.payload.count).toBeGreaterThanOrEqual(2)
    // Повтор ничего не находит
    expect(await MailIntake.purge()).toBe(0)
  })

  it('очистка — задание обслуживания единого планировщика раз в сутки', async () => {
    const { listSchedules } = await import('../src/kernel/schedules/index.js')
    const { scheduleDocumentsJobs } = await import('../src/modules/documents/module.js')
    if (!listSchedules().some((item) => item.name === 'documents.mail-purge')) {
      scheduleDocumentsJobs()
    }
    expect(listSchedules().find((item) => item.name === 'documents.mail-purge')).toMatchObject({
      queue: 'maintenance',
      pattern: '25 3 * * *',
      labelKey: 'schedules.jobs.documentsMailPurge',
    })
  })
})
