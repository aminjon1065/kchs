import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createUser,
  registerLifecycle,
  setupFixture,
  type TestContext,
  type TestUser,
} from './helpers.js'

/**
 * Почта установки (ADR-0150): ящик у каждого действующего сотрудника и ящик канцелярии,
 * файл учёток почтового сервера, пароль для почты из профиля (показывается один раз,
 * хеш {SSHA512} проверяет Dovecot), заблокированный теряет ящик. Блок «живой сервер»
 * идёт при KCHS_MAIL_E2E=1 на поднятом профиле mail: вход по IMAP, исходящий письмом
 * из ящика канцелярии и приём в очередь «Из почты».
 */
registerLifecycle()

const { resetConfigCache } = await import('../src/shared/config/env.js')
const { resetMailer } = await import('../src/shared/mail/index.js')
const { MailPublic } = await import('../src/modules/mail/public.js')

const run = Date.now().toString(36)
const saved = { ...process.env }
let fx: TestContext
let dir = ''
let employee: TestUser

function verify(line: string, password: string): boolean {
  const raw = Buffer.from(line.split('{SSHA512}')[1] ?? '', 'base64')
  const digest = raw.subarray(0, 64)
  const salt = raw.subarray(64)
  const expected = createHash('sha512')
    .update(Buffer.concat([Buffer.from(password), salt]))
    .digest()
  return expected.equals(digest)
}

async function accounts(): Promise<string[]> {
  return (await readFile(join(dir, 'postfix-accounts.cf'), 'utf8')).trim().split('\n')
}

beforeAll(async () => {
  dir = process.env.KCHS_MAIL_E2E_CONFIG_DIR ?? (await mkdtemp(join(tmpdir(), 'kchs-mail-')))
  process.env.MAIL_DOMAIN = 'kchs.test'
  process.env.MAIL_CONFIG_DIR = dir
  process.env.MAIL_REGISTRY_LOCAL = `kanc${run}`
  resetConfigCache()
  fx = await setupFixture()
  employee = await createUser(fx.app, `mailer_${run}`)
})

afterAll(() => {
  for (const key of ['MAIL_DOMAIN', 'MAIL_CONFIG_DIR', 'MAIL_REGISTRY_LOCAL']) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  resetConfigCache()
  resetMailer()
})

describe('почтовые ящики установки', () => {
  it('синхронизация пишет файл учёток: канцелярия и каждый действующий сотрудник', async () => {
    const report = await MailPublic.sync()
    expect(report.file).toBe(join(dir, 'postfix-accounts.cf'))
    const lines = await accounts()
    expect(lines[0]).toMatch(new RegExp(`^kanc${run}@kchs\\.test\\|\\{SSHA512\\}`))
    expect(lines.some((line) => line.startsWith(`mailer_${run}@kchs.test|{SSHA512}`))).toBe(true)
    // Повтор ничего не заводит заново
    expect((await MailPublic.sync()).created).toBe(0)
  })

  it('пароль для почты — один раз, проверяется хешем файла; отзыв его гасит', async () => {
    const status = await call(fx.app, { url: '/me/mail', as: employee })
    expect(status.json()).toMatchObject({
      enabled: true,
      address: `mailer_${run}@kchs.test`,
      passwordSet: false,
    })
    const issued = await call(fx.app, { method: 'POST', url: '/me/mail/password', as: employee })
    expect(issued.statusCode, issued.body).toBe(200)
    const { password, address } = issued.json() as { password: string; address: string }
    expect(password).toMatch(/^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){3}$/)
    await MailPublic.sync()
    const line = (await accounts()).find((item) => item.startsWith(`${address}|`)) ?? ''
    expect(verify(line, password)).toBe(true)
    expect((await call(fx.app, { url: '/me/mail', as: employee })).json().passwordSet).toBe(true)

    const revoked = await call(fx.app, { method: 'DELETE', url: '/me/mail/password', as: employee })
    expect(revoked.json().passwordSet).toBe(false)
    await MailPublic.sync()
    const after = (await accounts()).find((item) => item.startsWith(`${address}|`)) ?? ''
    expect(verify(after, password)).toBe(false)
  })

  it('заблокированный сотрудник пропадает из файла учёток', async () => {
    const leaving = await createUser(fx.app, `leaving_${run}`)
    await MailPublic.sync()
    expect((await accounts()).some((line) => line.startsWith(`leaving_${run}@`))).toBe(true)
    const blocked = await call(fx.app, {
      method: 'PATCH',
      url: `/users/${leaving.id}`,
      as: fx.admin,
      payload: { status: 'blocked' },
    })
    expect(blocked.statusCode, blocked.body).toBe(200)
    await MailPublic.sync()
    expect((await accounts()).some((line) => line.startsWith(`leaving_${run}@`))).toBe(false)
  })

  it('без домена почта выключена', async () => {
    process.env.MAIL_DOMAIN = ''
    resetConfigCache()
    const status = await call(fx.app, { url: '/me/mail', as: employee })
    expect(status.json()).toMatchObject({ enabled: false, address: null })
    expect(
      (await call(fx.app, { method: 'POST', url: '/me/mail/password', as: employee })).statusCode,
    ).toBe(409)
    process.env.MAIL_DOMAIN = 'kchs.test'
    resetConfigCache()
  })
})

describe.runIf(process.env.KCHS_MAIL_E2E === '1')('живой почтовый сервер (профиль mail)', () => {
  it('вход по IMAP паролем для почты, письмо из ящика канцелярии доходит сотруднику', async () => {
    const { ImapFlow } = await import('imapflow')
    process.env.MAIL_SUBMISSION_URL =
      process.env.KCHS_MAIL_E2E_SUBMISSION ?? 'smtp://localhost:15587'
    process.env.MAIL_IMAP_HOST = 'localhost'
    process.env.MAIL_IMAP_PORT = process.env.KCHS_MAIL_E2E_IMAP_PORT ?? '19993'
    resetConfigCache()
    const issued = await call(fx.app, { method: 'POST', url: '/me/mail/password', as: employee })
    const { password, address } = issued.json() as { password: string; address: string }
    await MailPublic.sync()
    // Сервер подхватывает файл учёток за несколько секунд
    await new Promise((resolve) => setTimeout(resolve, 12_000))

    const sender = await MailPublic.registrySender()
    expect(sender?.from).toBe(`kanc${run}@kchs.test`)
    const { sendMailWithReceipt } = await import('../src/shared/mail/index.js')
    const receipt = await sendMailWithReceipt(
      {
        from: sender?.from as string,
        to: address,
        subject: `Проверка почты ${run}`,
        text: 'проверка',
        html: '<p>проверка</p>',
        messageId: `<kchs-e2e-${run}@kchs.test>`,
        attachments: [],
      },
      sender?.url,
    )
    expect(receipt?.accepted).toEqual([address])
    await new Promise((resolve) => setTimeout(resolve, 3000))

    const client = new ImapFlow({
      host: 'localhost',
      port: Number(process.env.MAIL_IMAP_PORT),
      secure: true,
      tls: { rejectUnauthorized: false },
      auth: { user: address, pass: password },
      logger: false,
    })
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      const found = await client.search({ subject: `Проверка почты ${run}` })
      expect(found ? found.length : 0).toBeGreaterThan(0)
    } finally {
      lock.release()
      await client.logout()
    }

    // Письмо на ящик канцелярии → `kchs mail sync` заводит приём → очередь «Из почты»
    await createUser(fx.app, `registrar_mail_${run}`, ['employee', 'registrar'])
    const { DocumentsSeed } = await import('../src/modules/documents/public.js')
    const { systemCtx } = await import('../src/shared/context.js')
    await DocumentsSeed.ensureStarterSet(systemCtx('test'), { demo: false })
    const personal = new URL(process.env.MAIL_SUBMISSION_URL as string)
    personal.username = address
    personal.password = password
    personal.searchParams.set('tls.rejectUnauthorized', 'false')
    const incoming = await sendMailWithReceipt(
      {
        from: address,
        to: sender?.from as string,
        subject: `Входящее письмо ${run}`,
        text: 'Просим рассмотреть',
        html: '<p>Просим рассмотреть</p>',
        messageId: `<in-${run}@kchs.test>`,
        attachments: [],
      },
      personal.toString(),
    )
    expect(incoming?.accepted).toEqual([sender?.from])
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const { runMailSync } = await import('../src/cli/mail.js')
    expect((await runMailSync()).intake).toBe('created')
    // Новый сотрудник в файле учёток — сервер перезагружается; опрашиваем после
    await new Promise((resolve) => setTimeout(resolve, 15_000))
    const { MailIntake } = await import('../src/modules/documents/domain/mail/mail-service.js')
    const polled = await MailIntake.poll({ force: true })
    expect(polled.errors).toEqual([])
    expect(polled.mailboxes).toBe(1)
    const queue = await call(fx.app, { url: '/documents/mail?scope=all&limit=50', as: fx.admin })
    expect(
      (queue.json().items as Array<{ subject: string }>).some(
        (item) => item.subject === `Входящее письмо ${run}`,
      ),
    ).toBe(true)
  }, 120_000)
})
