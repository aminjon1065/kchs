import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MailboxConfig } from '@kchs/contracts'
import { beforeAll, describe, expect, it } from 'vitest'
import type { FetchedLetter, MailboxPort } from '../src/shared/mail/imap.js'
import { setMailboxPort } from '../src/shared/mail/imap.js'
import {
  call,
  createUser,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Регистрация входящих из ящика канцелярии (P5-E04, ADR-0113).
 *
 * Настоящий IMAP-сервер здесь не нужен: подменяется порт ящика, а письма —
 * те же фикстуры `.eml`, что и в unit-тестах разбора. Проверяется то, что
 * относится к платформе: черновик с вложениями, сопоставление корреспондента,
 * дедупликация по `Message-ID`, правила отбора, неразобранное письмо, журнал
 * синхронизаций интеграции, отклонение с причиной и уход из очереди после
 * регистрации.
 */
registerLifecycle()

const { DocumentsSeed } = await import('../src/modules/documents/public.js')
const { systemCtx } = await import('../src/shared/context.js')
const bus = await import('../src/kernel/events/index.js')
const { documentSubscribers } = await import('../src/modules/documents/domain/subscribers.js')

const fixtures = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/modules/documents/domain/mail/__fixtures__',
)
const letter = (name: string) => readFileSync(path.join(fixtures, name))

let fx: TestContext
let registrar: TestUser
let integrationId = ''
let inbox: FetchedLetter[] = []
const seen: number[] = []

interface MailItem {
  id: string
  status: string
  subject: string
  fromEmail: string
  documentId: string | null
  correspondent: { id: string; name: string } | null
  suggestedCorrespondentName: string | null
  attachments: Array<{ id: string; name: string; size: number }>
  error: string | null
  rejectReason: string | null
  body: string
}

/** Ящик канцелярии: письма выдаёт тест, пометка прочитанного — в массив. */
const fakeMailbox: MailboxPort = {
  fetch: async (_config, _password, limit) => inbox.slice(0, limit),
  markSeen: async (_config, _password, uids) => {
    seen.push(...uids)
  },
  check: async () => ({ ok: true, message: 'Ящик открыт, писем в папке: 0' }),
}

const mailbox = (patch: Partial<MailboxConfig> = {}) => ({
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
  ...patch,
})

const poll = () => call(fx.app, { method: 'POST', url: '/documents/mail/poll', as: registrar })
const list = (query = '') => call(fx.app, { url: `/documents/mail${query}`, as: registrar })

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('условие не выполнилось за отведённое время')
}

async function setConfig(patch: Partial<MailboxConfig>): Promise<void> {
  const response = await call(fx.app, {
    method: 'PATCH',
    url: `/integrations/${integrationId}`,
    as: fx.admin,
    payload: { config: mailbox(patch) },
  })
  expect(response.statusCode, response.body).toBe(200)
}

beforeAll(async () => {
  fx = await setupFixture()
  registrar = await createUser(fx.app, 'registrar_mail', ['employee', 'registrar'])
  await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: true })
  setMailboxPort(fakeMailbox)

  const created = await call(fx.app, {
    method: 'POST',
    url: '/integrations',
    as: fx.admin,
    payload: {
      key: 'office-mailbox',
      kind: 'imap',
      name: 'Ящик канцелярии',
      enabled: true,
      config: mailbox(),
      secrets: { password: 'не-настоящий-пароль' },
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  integrationId = created.json().id
})

describe('очередь «Из почты»', () => {
  it('письмо становится черновиком входящего с вложением', async () => {
    inbox = [
      { uid: 11, uidValidity: '7', source: letter('simple.eml') },
      { uid: 12, uidValidity: '7', source: letter('with-attachment.eml') },
    ]

    const report = await poll()
    expect(report.statusCode, report.body).toBe(200)
    expect(report.json().result).toMatchObject({ fetched: 2, created: 2, duplicates: 0 })
    // Разобранные письма помечены прочитанными: второй раз их не заберут
    expect(seen).toEqual([11, 12])

    const items = list().then((r) => r.json().items as MailItem[])
    const queue = await items
    expect(queue).toHaveLength(2)
    const donesenie = queue.find((item) => item.subject === 'Донесение о паводке')
    expect(donesenie?.status).toBe('draft')
    expect(donesenie?.documentId).toBeTruthy()
    expect(donesenie?.attachments.map((file) => file.name)).toEqual(['Донесение №77.pdf'])
    expect(donesenie?.body).toContain('Направляем донесение о паводке')

    // Черновик — обычный документ: тип, суть письма и вложения на месте
    const draft = await call(fx.app, {
      url: `/documents/${donesenie?.documentId}`,
      as: registrar,
    })
    expect(draft.statusCode, draft.body).toBe(200)
    expect(draft.json()).toMatchObject({
      status: 'draft',
      subject: 'Донесение о паводке',
      deliveryMethod: 'email',
    })
    expect(draft.json().summary).toContain('донесение')
    const links = await call(fx.app, {
      url: `/objects/${donesenie?.documentId}/links`,
      as: registrar,
    })
    expect(links.statusCode, links.body).toBe(200)
    const attached = (links.json().links as Array<{ kind: string }>).filter(
      (link) => link.kind === 'attachment',
    )
    expect(attached).toHaveLength(1)
    // Вложение письма сразу стало версией документа: черновик готов к регистрации
    expect(draft.json().currentVersion?.mainFile?.name).toBe('Донесение №77.pdf')
  })

  it('корреспондент подбирается по адресу, иначе предлагается завести', async () => {
    const queue = (await list()).json().items as MailItem[]
    const unknown = queue.find((item) => item.fromEmail === 'kanc@mvd.example.tj')
    expect(unknown?.correspondent).toBeNull()
    expect(unknown?.suggestedCorrespondentName).toBe('Канцелярия МВД')

    // Заводим корреспондента с этим адресом и повторяем письмо из другого ящика
    const correspondent = await call(fx.app, {
      method: 'POST',
      url: '/correspondents',
      as: registrar,
      payload: {
        kind: 'organization',
        name: 'Министерство внутренних дел',
        contacts: { email: 'KANC@mvd.example.tj' },
      },
    })
    expect(correspondent.statusCode, correspondent.body).toBe(200)

    const second = await call(fx.app, {
      method: 'POST',
      url: '/integrations',
      as: fx.admin,
      payload: {
        key: 'office-mailbox-2',
        kind: 'imap',
        name: 'Второй ящик',
        enabled: true,
        config: mailbox(),
        secrets: { password: 'не-настоящий-пароль' },
      },
    })
    expect(second.statusCode, second.body).toBe(200)

    inbox = [{ uid: 21, uidValidity: '9', source: letter('simple.eml') }]
    const report = await call(fx.app, {
      method: 'POST',
      url: `/documents/mail/poll?integrationId=${second.json().id}`,
      as: registrar,
    })
    expect(report.json().result).toMatchObject({ created: 1 })

    const matched = ((await list()).json().items as MailItem[]).find(
      (item) => item.correspondent !== null,
    )
    expect(matched?.correspondent?.name).toBe('Министерство внутренних дел')

    // Уборка: второй ящик больше не нужен
    await call(fx.app, {
      method: 'DELETE',
      url: `/integrations/${second.json().id}`,
      as: fx.admin,
    })
  })

  it('то же письмо второй раз не регистрируется', async () => {
    inbox = [
      { uid: 11, uidValidity: '7', source: letter('simple.eml') },
      { uid: 12, uidValidity: '7', source: letter('with-attachment.eml') },
    ]
    const before = ((await list()).json().items as MailItem[]).length

    const report = await poll()
    expect(report.json().result).toMatchObject({ fetched: 2, created: 0, duplicates: 2 })
    expect(((await list()).json().items as MailItem[]).length).toBe(before)
  })

  it('правила отбора отсекают рассылку, а письмо остаётся в очереди с причиной', async () => {
    await setConfig({
      filters: {
        fromExcludes: ['noreply'],
        fromContains: [],
        subjectContains: [],
        requireAttachment: false,
      },
    })
    inbox = [{ uid: 31, uidValidity: '7', source: letter('bare.eml') }]

    const report = await poll()
    expect(report.json().result).toMatchObject({ created: 0, skipped: 1 })

    const rejected = ((await list('?status=rejected')).json().items as MailItem[]).find(
      (item) => item.fromEmail === 'noreply@rassylka.example.org',
    )
    expect(rejected?.rejectReason).toContain('исключений')
    expect(rejected?.documentId).toBeNull()
    await setConfig({})
  })

  it('письмо, из которого не вышел черновик, помечается в очереди, а не теряется', async () => {
    // Тип документа из конфигурации ящика убрали — черновик не завести
    await setConfig({ documentTypeKey: 'no-such-type' })
    inbox = [{ uid: 41, uidValidity: '7', source: letter('bare.eml') }]

    const report = await poll()
    expect(report.json().result).toMatchObject({ created: 0, failed: 1 })

    const broken = ((await list('?status=failed')).json().items as MailItem[])[0]
    expect(broken?.error).toContain('no-such-type')
    expect(broken?.documentId).toBeNull()
    // Непонятое письмо остаётся непрочитанным в ящике: с ним разберётся человек
    expect(seen).not.toContain(41)
    await setConfig({})
  })

  it('прогон попадает в журнал синхронизаций интеграции', async () => {
    const syncs = await call(fx.app, { url: `/integrations/${integrationId}/syncs`, as: fx.admin })

    expect(syncs.statusCode, syncs.body).toBe(200)
    const items = syncs.json().items as Array<{ status: string; stats: Record<string, number> }>
    expect(items.length).toBeGreaterThan(0)
    expect(items[0]?.status).toBe('ok')
    expect(items.some((item) => (item.stats.created ?? 0) > 0)).toBe(true)
  })

  it('отклонение с причиной убирает черновик и закрывает письмо', async () => {
    const pending = ((await list('?status=draft')).json().items as MailItem[])[0]
    expect(pending).toBeTruthy()

    const rejected = await call(fx.app, {
      method: 'POST',
      url: `/documents/mail/${pending?.id}/reject`,
      as: registrar,
      payload: { reason: 'Письмо не относится к делопроизводству' },
    })
    expect(rejected.statusCode, `${pending?.id}: ${rejected.body}`).toBe(200)
    expect(rejected.json()).toMatchObject({
      status: 'rejected',
      rejectReason: 'Письмо не относится к делопроизводству',
    })
    // Черновик ушёл в корзину — в очереди на него больше не ссылаются
    expect(rejected.json().documentId).toBeNull()

    const again = await call(fx.app, {
      method: 'POST',
      url: `/documents/mail/${pending?.id}/reject`,
      as: registrar,
      payload: { reason: 'Повторное отклонение' },
    })
    expect(again.statusCode).toBe(200)
  })

  it('регистрация документа убирает письмо из очереди', async () => {
    const pending = ((await list('?status=draft')).json().items as MailItem[]).find(
      (item) => item.documentId !== null && item.attachments.length > 0,
    )
    expect(pending?.documentId).toBeTruthy()

    // Корреспондента по адресу не нашлось — делопроизводитель указывает его в
    // карточке, как и при обычной регистрации
    const correspondents = await call(fx.app, { url: '/correspondents?limit=1', as: registrar })
    const filled = await call(fx.app, {
      method: 'PATCH',
      url: `/documents/${pending?.documentId}`,
      as: registrar,
      payload: { correspondentId: correspondents.json().items[0].id },
    })
    expect(filled.statusCode, filled.body).toBe(200)

    const registered = await call(fx.app, {
      method: 'POST',
      url: `/documents/${pending?.documentId}/register`,
      as: registrar,
      payload: {},
    })
    expect(registered.statusCode, registered.body).toBe(200)
    expect(registered.json().regNumber).toBeTruthy()

    // Письмо уходит из очереди подписчиком события, а не опросом (ADR-0113)
    const subscriber = documentSubscribers.find((item) => item.name === 'documents-mail-queue')
    expect(subscriber).toBeTruthy()
    bus.clearSubscribers()
    if (subscriber) bus.registerSubscriber(subscriber)
    bus.startConsumers({ blockMs: 100, retryIdleMs: 300, claimIntervalMs: 100 })
    try {
      while ((await bus.dispatchOnce()) > 0) {
        // выкладываем накопленный outbox в шину
      }
      await waitFor(async () => {
        const item = await call(fx.app, { url: `/documents/mail/${pending?.id}`, as: registrar })
        return item.json().status === 'registered'
      })
    } finally {
      await bus.stopConsumers()
      bus.clearSubscribers()
    }

    const item = await call(fx.app, { url: `/documents/mail/${pending?.id}`, as: registrar })
    expect(item.json().documentRegNumber).toBe(registered.json().regNumber)
  })

  it('очередь закрыта для тех, кто не регистрирует документы', async () => {
    const denied = await call(fx.app, { url: '/documents/mail', as: fx.users.member })
    expect(denied.statusCode).toBe(403)
  })
})
