import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type APIRequestContext,
  type Browser,
  type Page,
  request as playwrightRequest,
} from '@playwright/test'
import { ADMIN_STATE, expect, test, totp } from './fixtures.js'

/**
 * КЭП ключом устройства (ADR-0218): администратор создаёт УЦ Комитета; подписант в
 * профиле создаёт ключ подписи на своём устройстве (код второго фактора), получает
 * сертификат; подписывает записку на шаге «Подписать КЭП» — страница подписания берёт
 * ключ из того же браузера; движок встраивает подпись со штампом времени и списками
 * отзыва, а страница проверки по QR без входа показывает «Подпись верна».
 *
 * Нужны движок (подготовка и встраивание PAdES) и временный стенд — не стенд разработки.
 */
test.describe.configure({ mode: 'serial' })

const BASE = process.env.KCHS_BASE_URL ?? 'http://localhost:5173'
const run = Date.now().toString(36)
const PASSWORD = 'Klyuch-Ustroystva-2026!'
const subject = `Служебная записка ключом устройства ${run}`
const definitionKey = `pki_device_${run}`

interface Actor {
  login: string
  id: string
  name: string
}

interface Session {
  api: APIRequestContext
  csrf: string
}

const actors: Record<'author' | 'signer', Actor> = {} as never
const sessions = new Map<string, Session>()
let signerSecret = ''
let documentId = ''

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
  return context.newPage()
}

async function memoPdf(page: Page): Promise<string> {
  const scan = await page.context().newPage()
  await scan.setContent(`<h1>${subject}</h1><p>Текст записки на подпись КЭП.</p>`)
  const dir = mkdtempSync(path.join(tmpdir(), 'kchs-e2e-'))
  const file = path.join(dir, `zapiska-${run}.pdf`)
  await scan.pdf({ path: file, format: 'A4' })
  await scan.close()
  return file
}

test.beforeAll(async () => {
  const admin = await playwrightRequest.newContext({ baseURL: BASE, storageState: ADMIN_STATE })
  const me = await admin.get('/api/v1/me')
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
  // УЦ Комитета создаётся один раз; повторный вызов ничего не меняет
  const pki = await admin.post('/api/v1/admin/pki/init', { headers })
  expect(pki.ok(), await pki.text()).toBeTruthy()

  for (const [key, lastName] of [
    ['author', 'Автор'],
    ['signer', 'Ключевой'],
  ] as const) {
    const loginName = `pki-${key}-${run}`
    const user = await admin.post('/api/v1/users', {
      headers,
      data: {
        login: loginName,
        lastName: `${lastName}${run}`,
        firstName: 'Тест',
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

  const definition = await admin.post('/api/v1/process-definitions', {
    headers,
    data: {
      definition: {
        version: 1,
        key: definitionKey,
        objectType: 'document',
        name: { ru: `КЭП ключом устройства ${run}` },
        start: 'sign',
        steps: {
          sign: {
            type: 'sign',
            name: { ru: 'Подпись КЭП' },
            mode: 'sequential',
            assignees: [`user:${actors.signer.id}`],
            requireMfa: true,
            signatureKind: 'qualified',
            next: 'end',
          },
          end: { type: 'end', outcome: 'completed' },
        },
      },
    },
  })
  expect(definition.ok(), await definition.text()).toBeTruthy()
  const published = await admin.post(`/api/v1/process-definitions/${definitionKey}/publish`, {
    headers,
  })
  expect(published.ok(), await published.text()).toBeTruthy()
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
  const memo = (types.items as Array<{ id: string; key: string }>).find(
    (item) => item.key === 'memo',
  )
  const draft = await author.api.post('/api/v1/documents', {
    headers: { 'x-csrf-token': author.csrf },
    data: { typeId: memo?.id, subject },
  })
  expect(draft.ok(), await draft.text()).toBeTruthy()
  documentId = (await draft.json()).id as string
})

test.afterAll(async () => {
  for (const session of sessions.values()) await session.api.dispose()
})

test('ключ на устройстве → подпись КЭП → страница проверки «Подпись верна»', async ({
  browser,
}) => {
  test.setTimeout(300_000)

  // ── Подписант: ключ подписи на этом устройстве ───────────────────────────
  const signerPage = await pageOf(browser, actors.signer)
  await signerPage.goto('/profile')
  // Карточка — не landmark: поля и кнопки на профиле подписаны однозначно
  await expect(signerPage.getByRole('heading', { name: 'Ключ подписи' })).toBeVisible({
    timeout: 20_000,
  })
  await signerPage.getByLabel('Название устройства').fill(`Ноутбук ${run}`)
  await signerPage.getByLabel('Код второго фактора').fill(totp(signerSecret, Date.now() + 30_000))
  await signerPage.getByRole('button', { name: 'Создать ключ на этом устройстве' }).click()
  await expect(signerPage.getByText('Ключ создан, сертификат выпущен')).toBeVisible({
    timeout: 30_000,
  })
  // «Это устройство» — и в списке, и в подсказках; строку устройства проверяет следующий шаг
  await expect(signerPage.getByText('Это устройство').first()).toBeVisible()
  await expect(signerPage.getByText(`Ноутбук ${run}`)).toBeVisible()

  // ── Автор: PDF записки и маршрут с КЭП ───────────────────────────────────
  const author = await pageOf(browser, actors.author)
  await author.goto(`/o/${documentId}`)
  await expect(author.getByRole('heading', { name: subject })).toBeVisible({ timeout: 20_000 })
  await author.getByRole('tab', { name: /Файлы и версии/ }).click()
  const files = author.getByRole('tabpanel', { name: /Файлы и версии/ })
  await files
    .locator('input[type="file"]')
    .first()
    .setInputFiles(await memoPdf(author))
  await files.getByRole('button', { name: 'Добавить версию' }).click()
  await expect(author.getByText('Версия добавлена')).toBeVisible({ timeout: 20_000 })
  const { api, csrf } = await login(actors.author.login)
  const started = await api.post(`/api/v1/documents/${documentId}/routes`, {
    headers: { 'x-csrf-token': csrf },
    data: { definitionKey },
  })
  expect(started.ok(), await started.text()).toBeTruthy()

  // ── Подписант: «Подписать КЭП» → страница подписания тем же браузером ────
  await signerPage.goto(`/o/${documentId}`)
  await expect(signerPage.getByRole('heading', { name: subject })).toBeVisible({ timeout: 20_000 })
  await signerPage.getByRole('button', { name: 'Подписать КЭП' }).first().click()
  const dialog = signerPage.getByRole('dialog', { name: 'Квалифицированная подпись' })
  await expect(dialog).toBeVisible()
  const [signing] = await Promise.all([
    signerPage.context().waitForEvent('page'),
    dialog.getByRole('button', { name: 'Открыть страницу подписания' }).click(),
  ])
  await expect(
    signing.getByRole('heading', { name: 'Подписание квалифицированной подписью' }),
  ).toBeVisible({ timeout: 20_000 })
  await expect(signing.getByText('ключ этого устройства', { exact: false }).first()).toBeVisible({
    timeout: 20_000,
  })
  await signing.getByRole('button', { name: 'Подписать' }).click()
  await expect(signing.getByText('Документ подписан', { exact: true })).toBeVisible({
    timeout: 180_000,
  })
  await signing.close()
  await expect(signerPage.getByText('Документ подписан квалифицированной подписью')).toBeVisible({
    timeout: 30_000,
  })

  // ── Подпись: квалифицированная, сертификат УЦ Комитета, проверка движком ──
  const signatures = await (await api.get(`/api/v1/documents/${documentId}/signatures`)).json()
  const [signature] = signatures.items as Array<{
    id: string
    kind: string
    certificate: { owner: string; issuer: string } | null
    validation: { trusted: boolean; revocation: string } | null
  }>
  expect(signature?.kind).toBe('qualified')
  expect(signature?.certificate?.owner).toContain(actors.signer.name)
  expect(signature?.validation).toMatchObject({ trusted: true, revocation: 'good' })

  // ── Страница проверки по QR: без входа ───────────────────────────────────
  const anonymous = await browser.newContext({ baseURL: BASE })
  const verify = await anonymous.newPage()
  await verify.goto(`/api/v1/verify/${signature?.id}`)
  await expect(verify.getByRole('heading', { name: 'Проверка электронной подписи' })).toBeVisible()
  await expect(verify.getByText('Подпись верна', { exact: false }).first()).toBeVisible()
  await expect(verify.getByText('Квалифицированная электронная подпись').first()).toBeVisible()
  await anonymous.close()
})
