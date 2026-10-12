import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  type APIRequestContext,
  type Browser,
  type Page,
  request as playwrightRequest,
} from '@playwright/test'
import { ADMIN_STATE, expect, test, totp } from './fixtures.js'

/**
 * Доработка проекта и подпись как реквизит (ADR-0197, ADR-0198) — сценарий с видео
 * эталонной системы: подписант загружает факсимиле в профиле; приказ уходит на
 * визирование; визирующий даёт замечания; автор видит подсказку доработки,
 * загружает версию 2 и сравнивает версии; повторно — согласовано; подпись с
 * кодом; номер — сразу после подписи; появляется подписанный экземпляр с
 * факсимиле, а страница проверки по QR без входа показывает «Подпись верна».
 *
 * Подписанный экземпляр строит движок: нужен образ движка с наложением факсимиле.
 */
test.describe.configure({ mode: 'serial' })

const BASE = process.env.KCHS_BASE_URL ?? 'http://localhost:5173'
const run = Date.now().toString(36)
const PASSWORD = 'Podpis-Proverka-2026!'
const subject = `Приказ о дежурстве ${run}`

interface Actor {
  login: string
  id: string
  name: string
}

interface Session {
  api: APIRequestContext
  csrf: string
}

const actors: Record<'author' | 'approver' | 'signer', Actor> = {} as never
const sessions = new Map<string, Session>()
let signerSecret = ''
let documentId = ''
const signerShort = `Подписантов${run} Ш. Р.`

async function login(loginName: string): Promise<Session> {
  const cached = sessions.get(loginName)
  if (cached) return cached
  const api = await playwrightRequest.newContext({ baseURL: BASE })
  const response = await api.post('/api/v1/auth/login', {
    data: { login: loginName, password: PASSWORD, rememberDevice: false },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const me = await api.get('/api/v1/me')
  const session = { api, csrf: (await me.json()).session.csrfToken as string }
  sessions.set(loginName, session)
  return session
}

async function pageOf(browser: Browser, actor: Actor): Promise<Page> {
  const { api } = await login(actor.login)
  const context = await browser.newContext({
    baseURL: BASE,
    storageState: await api.storageState(),
  })
  await context.addInitScript(() => {
    localStorage.removeItem('kchs.workspace')
    localStorage.removeItem('kchs.appearance')
  })
  return context.newPage()
}

/** PDF проекта: текст и фамилия подписанта справа — там встанет факсимиле. */
async function draftPdf(page: Page, name: string, body: string): Promise<string> {
  const scan = await page.context().newPage()
  await scan.setContent(
    `<h1>${subject}</h1><p>${body}</p><p style="text-align:right;margin-top:30mm">${signerShort}</p>`,
  )
  const dir = mkdtempSync(path.join(tmpdir(), 'kchs-e2e-'))
  const file = path.join(dir, name)
  await scan.pdf({ path: file, format: 'A4' })
  await scan.close()
  return file
}

/** Картинка подписи: PNG 240×96, синие штрихи на прозрачном фоне. */
function facsimileFile(): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (data: Buffer) => {
    let c = 0xffffffff
    for (const byte of data) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.byteLength, 0)
    head.write(type, 4, 'latin1')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, tail])
  }
  const width = 240
  const height = 96
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4)
    for (let x = 0; x < width; x++) {
      const stroke = Math.abs(y - (48 + 30 * Math.sin(x / 18))) < 3
      if (stroke) row.set([20, 40, 160, 255], 1 + x * 4)
    }
    rows.push(row)
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ])
  const dir = mkdtempSync(path.join(tmpdir(), 'kchs-e2e-'))
  const file = path.join(dir, 'podpis.png')
  writeFileSync(file, png)
  return file
}

async function decideByApi(actor: Actor, action: string, extra: Record<string, unknown> = {}) {
  const { api, csrf } = await login(actor.login)
  const list = await api.get(`/api/v1/processes?objectId=${documentId}`)
  const [instance] = (await list.json()).items as Array<{ id: string }>
  const view = await (await api.get(`/api/v1/processes/${instance?.id}`)).json()
  const [mine] = view.myActions as Array<{ stepId: string }>
  expect(mine, `${actor.login} ждёт решения`).toBeTruthy()
  const acted = await api.post(`/api/v1/processes/${instance?.id}/steps/${mine?.stepId}/act`, {
    headers: { 'x-csrf-token': csrf },
    data: { action, ...extra },
  })
  expect(acted.ok(), await acted.text()).toBeTruthy()
}

test.beforeAll(async () => {
  const admin = await playwrightRequest.newContext({ baseURL: BASE, storageState: ADMIN_STATE })
  const me = await admin.get('/api/v1/me')
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
  const created = await admin.post('/api/v1/org/units', {
    headers,
    data: {
      code: `PD-${run}`,
      name: { ru: `Отдел подписи ${run}` },
      kind: 'division',
      createSpace: false,
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const unitId = (await created.json()).id as string
  const people: Array<[keyof typeof actors, string, string, string]> = [
    ['author', 'Авторова', 'Нигина', 'Саидовна'],
    ['approver', 'Визирующий', 'Фаррух', 'Олимович'],
    ['signer', 'Подписантов', 'Шариф', 'Рустамович'],
  ]
  for (const [key, lastName, firstName, middleName] of people) {
    const loginName = `pd-${key}-${run}`
    const user = await admin.post('/api/v1/users', {
      headers,
      data: {
        login: loginName,
        lastName: `${lastName}${run}`,
        firstName,
        middleName,
        unitId,
        roleKeys: ['employee'],
        password: PASSWORD,
        mustChangePassword: false,
      },
    })
    expect(user.ok(), await user.text()).toBeTruthy()
    actors[key] = {
      login: loginName,
      id: (await user.json()).id as string,
      name: `${lastName}${run}`,
    }
  }
  await admin.dispose()

  const signer = await login(actors.signer.login)
  const setup = await signer.api.post('/api/v1/me/mfa/setup', {
    headers: { 'x-csrf-token': signer.csrf },
  })
  signerSecret = (await setup.json()).secret as string
  const enabled = await signer.api.post('/api/v1/me/mfa/enable', {
    headers: { 'x-csrf-token': signer.csrf },
    data: { code: totp(signerSecret) },
  })
  expect(enabled.ok(), await enabled.text()).toBeTruthy()

  const author = await login(actors.author.login)
  const types = await (await author.api.get('/api/v1/document-types')).json()
  const order = (types.items as Array<{ id: string; key: string }>).find(
    (item) => item.key === 'order',
  )
  const draft = await author.api.post('/api/v1/documents', {
    headers: { 'x-csrf-token': author.csrf },
    data: { typeId: order?.id, subject, signerId: actors.signer.id },
  })
  expect(draft.ok(), await draft.text()).toBeTruthy()
  documentId = (await draft.json()).id as string
})

test.afterAll(async () => {
  for (const session of sessions.values()) await session.api.dispose()
})

test('доработка проекта, версия 2, подпись с факсимиле и проверка по QR', async ({ browser }) => {
  test.setTimeout(300_000)

  // ── Подписант: факсимиле в профиле ────────────────────────────────────────
  const signerPage = await pageOf(browser, actors.signer)
  await signerPage.goto('/profile')
  const card = signerPage.getByRole('region', { name: 'Факсимиле' })
  await expect(card.or(signerPage.getByText('Факсимиле не загружено')).first()).toBeVisible({
    timeout: 20_000,
  })
  await signerPage.locator('input[type="file"][accept="image/png"]').setInputFiles(facsimileFile())
  await expect(signerPage.getByText('Факсимиле сохранено')).toBeVisible({ timeout: 15_000 })
  await expect(signerPage.getByRole('img', { name: 'Факсимиле' })).toBeVisible()

  // ── Автор: версия 1 и отправка на визирование ─────────────────────────────
  const author = await pageOf(browser, actors.author)
  await author.goto(`/o/${documentId}`)
  await expect(author.getByRole('heading', { name: subject })).toBeVisible({ timeout: 20_000 })
  await author.getByRole('tab', { name: /Файлы и версии/ }).click()
  const files = author.getByRole('tabpanel', { name: /Файлы и версии/ })
  await files
    .locator('input[type="file"]')
    .first()
    .setInputFiles(await draftPdf(author, `prikaz-${run}-v1.pdf`, 'Первая редакция приказа.'))
  await files.getByRole('button', { name: 'Добавить версию' }).click()
  await expect(author.getByText('Версия добавлена')).toBeVisible({ timeout: 20_000 })
  const { api, csrf } = await login(actors.author.login)
  const started = await api.post(`/api/v1/documents/${documentId}/routes`, {
    headers: { 'x-csrf-token': csrf },
    data: { definitionKey: 'document_order', assignees: { review: [actors.approver.id] } },
  })
  expect(started.ok(), await started.text()).toBeTruthy()

  // ── Визирующий: замечания «внести правки» ────────────────────────────────
  await decideByApi(actors.approver, 'remarks', { comment: 'Внести правки' })

  // ── Автор: подсказка доработки, версия 2, сравнение, повторная отправка ───
  await author.reload()
  await author.getByRole('tab', { name: /Файлы и версии/ }).click()
  await expect(files.getByText('Документ возвращён на доработку', { exact: false })).toBeVisible({
    timeout: 20_000,
  })
  await files
    .locator('input[type="file"]')
    .first()
    .setInputFiles(await draftPdf(author, `prikaz-${run}-v2.pdf`, 'Вторая редакция приказа.'))
  await files.getByRole('button', { name: 'Добавить версию' }).click()
  await expect(author.getByText('Версия добавлена')).toBeVisible({ timeout: 20_000 })
  await expect(files.getByText('Версия 2')).toBeVisible()
  await files.getByRole('button', { name: 'Сравнить' }).click()
  await expect(author.getByRole('dialog', { name: /Сравнение версий/ })).toBeVisible()
  await author.keyboard.press('Escape')
  await decideByApi(actors.author, 'resubmit')

  // ── Визирование и подпись с кодом ────────────────────────────────────────
  await decideByApi(actors.approver, 'approve')
  await decideByApi(actors.signer, 'sign', { code: totp(signerSecret, Date.now() + 30_000) })

  // ── Подписанный экземпляр с факсимиле: строит движок ─────────────────────
  await author.getByRole('tab', { name: 'Маршрут', exact: true }).click()
  const route = author.getByRole('tabpanel', { name: 'Маршрут' })
  await expect
    .poll(
      async () => {
        await author.reload()
        await author.getByRole('tab', { name: 'Маршрут', exact: true }).click()
        return route.getByText('Подписанный экземпляр — с факсимиле и штампом подписи').count()
      },
      { timeout: 120_000, intervals: [3_000] },
    )
    .toBeGreaterThan(0)
  await expect(route.getByText('С факсимиле', { exact: true })).toBeVisible()

  const signatures = await (await api.get(`/api/v1/documents/${documentId}/signatures`)).json()
  const [signature] = signatures.items as Array<{ id: string; state: string }>
  expect(signature?.state).toBe('valid')
  const card2 = await (await api.get(`/api/v1/documents/${documentId}`)).json()
  expect(card2.status).toBe('registered')
  // Имя файла — по номеру документа («/» в именах файлов недопустим)
  expect(card2.currentVersion.signedCopy.name).toContain(
    String(card2.regNumber).replaceAll('/', '-'),
  )

  // ── Страница проверки по QR: без входа ───────────────────────────────────
  const anonymous = await browser.newContext({ baseURL: BASE })
  const verify = await anonymous.newPage()
  await verify.goto(`/api/v1/verify/${signature?.id}`)
  await expect(verify.getByRole('heading', { name: 'Проверка электронной подписи' })).toBeVisible()
  await expect(verify.getByText('Подпись верна', { exact: false }).first()).toBeVisible()
  await expect(verify.getByText(actors.signer.name, { exact: false })).toBeVisible()
  await expect(verify.getByText(subject)).toHaveCount(0)
  await anonymous.close()
})
