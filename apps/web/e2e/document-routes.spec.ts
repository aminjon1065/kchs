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
 * Маршрут исходящего письма (P3-E02 S04, ADR-0083; сценарии фазы 3 №2 и №3):
 * автор отправляет письмо по стартовому маршруту с выбранными согласующими,
 * согласующий решает во Входящих, второй даёт замечания в карточке, автор
 * загружает новую версию и отправляет повторно, заместитель согласует,
 * подписант подписывает с кодом второго фактора, делопроизводитель
 * регистрирует из Входящих. Участники — своя ветка оргструктуры прогона.
 * Сроки с праздником, просрочка и эскалация, Telegram, перезапуск worker —
 * интеграционные тесты `apps/api/test/document-routes.test.ts`,
 * `processes.test.ts`, `process-worker.test.ts`.
 */
test.describe.configure({ mode: 'serial' })

const BASE = process.env.KCHS_BASE_URL ?? 'http://localhost:5173'
const run = Date.now().toString(36)
const PASSWORD = 'Marshrut-Proverka-2026!'
const subject = `Ответ Минфину о паводке ${run}`

interface Actor {
  login: string
  id: string
  name: string
}

interface Session {
  api: APIRequestContext
  csrf: string
}

const actors: Record<
  'author' | 'approverA' | 'approverB' | 'head' | 'deputy' | 'signer' | 'registrar',
  Actor
> = {} as never
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

/** Браузер сотрудника с его сессией и чистым рабочим пространством. */
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

async function openDocument(page: Page): Promise<void> {
  await page.goto(`/o/${documentId}`)
  await expect(page.getByRole('heading', { name: subject })).toBeVisible({ timeout: 20_000 })
}

/**
 * Действия шага в контекст-панели карточки: панель открыта — секция появится
 * после загрузки маршрута; закрыта — в шапке кнопка «Действия».
 */
async function stepActions(page: Page) {
  const panel = page.getByRole('region', { name: 'Действия' })
  const opener = page.getByRole('button', { name: 'Действия', exact: true })
  await expect(panel.or(opener).first()).toBeVisible({ timeout: 15_000 })
  if (!(await panel.isVisible())) await opener.click()
  await expect(panel).toBeVisible()
  return panel
}

async function addVersion(page: Page, name: string): Promise<void> {
  const scan = await page.context().newPage()
  await scan.setContent(`<h1>${subject}</h1><p>${name}</p>`)
  const dir = mkdtempSync(path.join(tmpdir(), 'kchs-e2e-'))
  const file = path.join(dir, name)
  await scan.pdf({ path: file, format: 'A4' })
  await scan.close()
  await page.getByRole('tab', { name: /Файлы и версии/ }).click()
  const files = page.getByRole('tabpanel', { name: /Файлы и версии/ })
  await files.locator('input[type="file"]').first().setInputFiles(file)
  await files.getByRole('button', { name: 'Добавить версию' }).click()
  await expect(page.getByText('Версия добавлена')).toBeVisible({ timeout: 20_000 })
}

/** Решение шага через API движка — для участников, чей шаг не проверяется в интерфейсе. */
async function decideByApi(actor: Actor, action: string): Promise<void> {
  const { api, csrf } = await login(actor.login)
  const list = await api.get(`/api/v1/processes?objectId=${documentId}`)
  const [instance] = (await list.json()).items as Array<{ id: string }>
  const view = await (await api.get(`/api/v1/processes/${instance?.id}`)).json()
  const [mine] = view.myActions as Array<{ stepId: string }>
  expect(mine, `${actor.login} ждёт решения`).toBeTruthy()
  const acted = await api.post(`/api/v1/processes/${instance?.id}/steps/${mine?.stepId}/act`, {
    headers: { 'x-csrf-token': csrf },
    data: { action },
  })
  expect(acted.ok(), await acted.text()).toBeTruthy()
}

/** Дело во Входящих по документу: элемент списка — по теме письма. */
async function openInboxItem(page: Page): Promise<void> {
  await page.goto('/inbox')
  const item = page.getByRole('option').filter({ hasText: subject }).first()
  await expect(item).toBeVisible({ timeout: 20_000 })
  await item.click()
}

test.beforeAll(async () => {
  const admin = await playwrightRequest.newContext({ baseURL: BASE, storageState: ADMIN_STATE })
  const me = await admin.get('/api/v1/me')
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
  const unit = async (body: Record<string, unknown>) => {
    const created = await admin.post('/api/v1/org/units', { headers, data: body })
    expect(created.ok(), await created.text()).toBeTruthy()
    return (await created.json()).id as string
  }
  const department = await unit({
    code: `MR-${run}`,
    name: { ru: `Управление маршрутов ${run}` },
    kind: 'department',
    createSpace: false,
  })
  const division = await unit({
    code: `MR-${run}-1`,
    parentId: department,
    name: { ru: `Отдел маршрутов ${run}` },
    kind: 'division',
    createSpace: false,
  })
  const people: Array<[keyof typeof actors, string, string, string[], string]> = [
    ['author', 'Авторова', 'Нигина', ['employee'], division],
    ['approverA', 'Юристов', 'Фаррух', ['employee'], division],
    ['approverB', 'Отделова', 'Мадина', ['employee'], division],
    ['head', 'Начальников', 'Рустам', ['employee'], division],
    ['deputy', 'Заместителев', 'Далер', ['employee'], department],
    ['signer', 'Подписантов', 'Шариф', ['employee'], division],
    ['registrar', 'Канцелярова', 'Зебо', ['employee', 'registrar'], division],
  ]
  for (const [key, lastName, firstName, roleKeys, unitId] of people) {
    const loginName = `mr-${key.toLowerCase()}-${run}`
    const created = await admin.post('/api/v1/users', {
      headers,
      data: {
        login: loginName,
        lastName: `${lastName}${run}`,
        firstName,
        unitId,
        roleKeys,
        password: PASSWORD,
        mustChangePassword: false,
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    actors[key] = {
      login: loginName,
      id: (await created.json()).id as string,
      name: `${lastName}${run}`,
    }
  }
  for (const [unitId, headUserId] of [
    [division, actors.head.id],
    [department, actors.deputy.id],
  ] as const) {
    const patched = await admin.patch(`/api/v1/org/units/${unitId}`, {
      headers,
      data: { headUserId },
    })
    expect(patched.ok(), await patched.text()).toBeTruthy()
  }
  await admin.dispose()

  // Подписант подключает второй фактор: подпись маршрута требует кода
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

  // Черновик исходящего письма с подписантом в карточке
  const author = await login(actors.author.login)
  const types = await (await author.api.get('/api/v1/document-types')).json()
  const outgoing = (types.items as Array<{ id: string; key: string }>).find(
    (item) => item.key === 'outgoing_letter',
  )
  const created = await author.api.post('/api/v1/documents', {
    headers: { 'x-csrf-token': author.csrf },
    data: { typeId: outgoing?.id, subject, signerId: actors.signer.id },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  documentId = (await created.json()).id as string
})

test.afterAll(async () => {
  for (const session of sessions.values()) await session.api.dispose()
})

test('маршрут исходящего: согласование, замечания, повторная отправка, подпись с кодом, регистрация', async ({
  browser,
}) => {
  test.setTimeout(240_000)

  // ── Автор: версия письма и отправка по маршруту типа ──────────────────────
  const author = await pageOf(browser, actors.author)
  await openDocument(author)
  await addVersion(author, `otvet-${run}-v1.pdf`)
  await author.getByRole('tab', { name: 'Маршрут', exact: true }).click()
  await author.getByRole('button', { name: 'Отправить на согласование' }).first().click()
  const dialog = author.getByRole('dialog', { name: 'Отправить по маршруту' })
  await expect(dialog).toBeVisible()
  for (const person of [actors.approverA, actors.approverB]) {
    await dialog.getByRole('searchbox', { name: 'Добавить сотрудника' }).first().fill(person.name)
    await dialog
      .getByRole('list', { name: 'Добавить сотрудника' })
      .getByRole('button', { name: new RegExp(person.name) })
      .click()
  }
  // Кто будет назначен: заместитель — руководитель руководителя, подпись — из карточки
  const preview = dialog.getByRole('list', { name: 'Кто будет назначен' })
  await expect(preview.getByText(actors.deputy.name)).toBeVisible({ timeout: 10_000 })
  await expect(preview.getByText(actors.signer.name)).toBeVisible()
  await expect(preview.getByText(actors.registrar.name)).toBeVisible()
  await dialog.getByRole('button', { name: 'Отправить на согласование' }).click()
  await expect(author.getByText('Документ отправлен по маршруту')).toBeVisible()
  await expect(author.getByText('На согласовании', { exact: true }).first()).toBeVisible()
  // Линия маршрута: текущий шаг с двумя ждущими согласующими
  const line = author.getByRole('tabpanel', { name: 'Маршрут' })
  await expect(line.getByText('Ждёт решения')).toHaveCount(2, { timeout: 10_000 })

  // ── Согласующий А: «Согласовать» во Входящих ──────────────────────────────
  const approverA = await pageOf(browser, actors.approverA)
  await openInboxItem(approverA)
  await approverA.getByRole('button', { name: 'Согласовать', exact: true }).click()
  await expect(approverA.getByText('Выполнено')).toBeVisible()

  // ── Согласующий Б: замечания в карточке ──────────────────────────────────
  const approverB = await pageOf(browser, actors.approverB)
  await openDocument(approverB)
  let panel = await stepActions(approverB)
  await panel.getByRole('button', { name: 'Замечания', exact: true }).click()
  const remarks = approverB.getByRole('dialog', { name: 'Замечания' })
  await remarks.getByRole('textbox', { name: 'Комментарий' }).fill('Добавьте ссылку на договор')
  await remarks.getByRole('button', { name: 'Замечания', exact: true }).click()
  await expect(approverB.getByText('Готово', { exact: true })).toBeVisible()

  // ── Автор: возврат, новая версия, повторная отправка ─────────────────────
  await author.reload()
  await expect(author.getByRole('heading', { name: subject })).toBeVisible({ timeout: 20_000 })
  await expect(author.getByText('Возвращён', { exact: true }).first()).toBeVisible()
  await author.getByRole('tab', { name: 'Маршрут', exact: true }).click()
  await expect(
    author.getByRole('tabpanel', { name: 'Маршрут' }).getByText('Добавьте ссылку на договор'),
  ).toBeVisible()
  await addVersion(author, `otvet-${run}-v2.pdf`)
  panel = await stepActions(author)
  await panel.getByRole('button', { name: 'Отправить повторно' }).click()
  await expect(author.getByText('На согласовании', { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  })

  // Второй круг: одобрение А засчитано, решает только Б; затем заместитель
  await decideByApi(actors.approverB, 'approve')
  await decideByApi(actors.deputy, 'approve')

  // ── Подписант: «Подписать» с кодом второго фактора ───────────────────────
  const signer = await pageOf(browser, actors.signer)
  await openDocument(signer)
  await expect(signer.getByText('На подписи', { exact: true }).first()).toBeVisible()
  panel = await stepActions(signer)
  await panel.getByRole('button', { name: 'Подписать', exact: true }).click()
  const sign = signer.getByRole('dialog', { name: 'Подписать' })
  await sign
    .getByRole('textbox', { name: 'Код подтверждения' })
    .fill(totp(signerSecret, Date.now() + 30_000))
  await sign.getByRole('button', { name: 'Подписать', exact: true }).click()
  await expect(signer.getByText('Подписан', { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  })

  // ── Делопроизводитель: регистрация из Входящих ───────────────────────────
  const registrar = await pageOf(browser, actors.registrar)
  await openInboxItem(registrar)
  await registrar.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
  await expect(registrar.getByText('Выполнено')).toBeVisible()

  // ── Автор: номер исходящего, завершённый маршрут в два круга, подпись ─────
  await author.reload()
  await expect(author.getByRole('heading', { name: subject })).toBeVisible({ timeout: 20_000 })
  await expect(author.getByText('Зарегистрирован', { exact: true }).first()).toBeVisible()
  await expect(author.getByText(/№ ИСХ-\d{4}\/\d{2}/).first()).toBeVisible()
  await author.getByRole('tab', { name: 'Маршрут', exact: true }).click()
  const finished = author.getByRole('tabpanel', { name: 'Маршрут' })
  await expect(finished.getByText('Завершён', { exact: true })).toBeVisible()
  await expect(finished.getByText('Круг 2')).toBeVisible()
  await expect(finished.getByText('Засчитано')).toBeVisible()
  const signatures = finished.getByRole('region', { name: 'Подписи' })
  await expect(signatures.getByText(actors.signer.name)).toBeVisible()
  await expect(signatures.getByText(/подтверждена кодом/)).toBeVisible()
})
