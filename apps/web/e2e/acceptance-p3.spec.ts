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
 * Приёмка фазы 3, сценарий №1 (04-verification.md §3; сценарий B,
 * 02-users-and-scenarios.md): входящее письмо → резолюция → поручения →
 * ответ → маршрут → подпись → регистрация → отправка → исполнение → дело.
 *
 * Участники — своя ветка оргструктуры прогона: руководитель организации
 * (резолюция с планшета, подпись с кодом второго фактора), заместитель —
 * глава управления, начальник отдела, ответственный исполнитель и
 * соисполнитель, юрист и специалист профильного отдела, делопроизводитель.
 * Письмо приходит сканом (приём с почтового ящика — фаза 5, P5-E04);
 * предзаполнение карточки ИИ — `document-assist.spec.ts`.
 */
test.describe.configure({ mode: 'serial' })

const BASE = process.env.KCHS_BASE_URL ?? 'http://localhost:5173'
const run = Date.now().toString(36)
const PASSWORD = 'Priyomka-Fazy3-2026!'
const subject = `О готовности к паводковому сезону ${run}`
const resolutionText = `Подготовить ответ Минфину ${run}`
const caseIndex = `05-${run}`
const caseTitle = `Переписка о паводках ${run}`
/** Руководитель пишет резолюцию и подписывает с планшета. */
const TABLET = { width: 1024, height: 768 }

type Role =
  | 'registrar'
  | 'boss'
  | 'deputy'
  | 'head'
  | 'executor'
  | 'coExecutor'
  | 'lawyer'
  | 'specialist'

interface Actor {
  login: string
  id: string
  name: string
}

interface Session {
  api: APIRequestContext
  csrf: string
}

const actors: Record<Role, Actor> = {} as never
const sessions = new Map<string, Session>()
let bossSecret = ''

async function login(actor: Actor): Promise<Session> {
  const cached = sessions.get(actor.login)
  if (cached) return cached
  const api = await playwrightRequest.newContext({ baseURL: BASE })
  const response = await api.post('/api/v1/auth/login', {
    data: { login: actor.login, password: PASSWORD, rememberDevice: false },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const me = await api.get('/api/v1/me')
  const session = { api, csrf: (await me.json()).session.csrfToken as string }
  sessions.set(actor.login, session)
  return session
}

/** Браузер сотрудника с его сессией и чистым рабочим пространством. */
async function pageOf(
  browser: Browser,
  actor: Actor,
  viewport?: { width: number; height: number },
): Promise<Page> {
  const { api } = await login(actor)
  const context = await browser.newContext({
    baseURL: BASE,
    storageState: await api.storageState(),
    ...(viewport ? { viewport, hasTouch: true } : {}),
  })
  await context.addInitScript(() => {
    localStorage.removeItem('kchs.workspace')
    localStorage.removeItem('kchs.appearance')
  })
  return context.newPage()
}

async function openDocument(page: Page, id: string): Promise<void> {
  await page.goto(`/o/${id}`)
  await expect(page.getByRole('heading', { name: subject })).toBeVisible({ timeout: 20_000 })
}

/**
 * Секция контекст-панели карточки (действия шага, делопроизводство): панель
 * открыта — секция появится после загрузки; закрыта — в шапке «Действия».
 */
async function contextSection(page: Page, name: 'Действия' | 'Делопроизводство') {
  const section = page
    .getByRole('complementary', { name: 'Контекст' })
    .getByRole('region', { name, exact: true })
  const opener = page.getByRole('button', { name: 'Действия', exact: true })
  await expect(section.or(opener).first()).toBeVisible({ timeout: 15_000 })
  if (!(await section.isVisible())) await opener.click()
  await expect(section).toBeVisible()
  return section
}

/** Дело во Входящих сотрудника — по началу заголовка элемента. */
async function openInbox(page: Page, title: string): Promise<void> {
  await page.goto('/inbox')
  const item = page
    .getByRole('list', { name: 'Входящие' })
    .getByRole('option', { name: new RegExp(title) })
    .first()
  await expect(item).toBeVisible({ timeout: 20_000 })
  await item.click()
}

/** Решение шага маршрута по API — для участников, чей шаг не проверяется в интерфейсе. */
async function decideByApi(actor: Actor, documentId: string, action: string): Promise<void> {
  const { api, csrf } = await login(actor)
  const list = await api.get(`/api/v1/processes?objectId=${documentId}`)
  const [instance] = (await list.json()).items as Array<{ id: string }>
  let stepId = ''
  await expect
    .poll(
      async () => {
        const view = await (await api.get(`/api/v1/processes/${instance?.id}`)).json()
        stepId = (view.myActions as Array<{ stepId: string }>)[0]?.stepId ?? ''
        return stepId
      },
      { message: `${actor.login} ждёт решения`, timeout: 15_000 },
    )
    .not.toBe('')
  const acted = await api.post(`/api/v1/processes/${instance?.id}/steps/${stepId}/act`, {
    headers: { 'x-csrf-token': csrf },
    data: { action },
  })
  expect(acted.ok(), await acted.text()).toBeTruthy()
}

async function statusOf(actor: Actor, documentId: string): Promise<string> {
  const { api } = await login(actor)
  return (await (await api.get(`/api/v1/documents/${documentId}`)).json()).status as string
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
  // Организация → управление (заместитель) → отдел исполнителя
  const organization = await unit({
    code: `PR-${run}`,
    name: { ru: `Служба приёмки ${run}` },
    kind: 'department',
    createSpace: false,
  })
  const department = await unit({
    code: `PR-${run}-1`,
    parentId: organization,
    name: { ru: `Управление мониторинга ${run}` },
    kind: 'department',
    createSpace: false,
  })
  const division = await unit({
    code: `PR-${run}-11`,
    parentId: department,
    name: { ru: `Отдел прогнозов ${run}` },
    kind: 'division',
    createSpace: false,
  })
  const people: Array<[Role, string, string, string[], string]> = [
    ['registrar', 'Делопроизводова', 'Малика', ['employee', 'registrar'], organization],
    ['boss', 'Руководов', 'Бахтиёр', ['employee'], organization],
    ['lawyer', 'Правоведова', 'Зарина', ['employee'], organization],
    ['deputy', 'Замов', 'Фирдавс', ['employee'], department],
    ['specialist', 'Профильный', 'Сухроб', ['employee'], department],
    ['head', 'Отделов', 'Комрон', ['employee'], division],
    ['executor', 'Исполнителев', 'Джамшед', ['employee'], division],
    ['coExecutor', 'Помощникова', 'Шахло', ['employee'], division],
  ]
  for (const [key, lastName, firstName, roleKeys, unitId] of people) {
    const loginName = `p3-${key.toLowerCase()}-${run}`
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
    [organization, actors.boss.id],
    [department, actors.deputy.id],
    [division, actors.head.id],
  ] as const) {
    const patched = await admin.patch(`/api/v1/org/units/${unitId}`, {
      headers,
      data: { headUserId },
    })
    expect(patched.ok(), await patched.text()).toBeTruthy()
  }

  // Корреспондент — из демо-сида; на стенде без него заводится здесь
  const found = await admin.get(`/api/v1/correspondents?q=${encodeURIComponent('Минфин')}`)
  if (((await found.json()).items ?? []).length === 0) {
    const created = await admin.post('/api/v1/correspondents', {
      headers,
      data: {
        name: 'Министерство финансов Республики Таджикистан',
        details: { shortName: 'Минфин' },
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
  }
  await admin.dispose()

  // Руководитель подключает второй фактор: подпись по маршруту требует кода
  const boss = await login(actors.boss)
  const setup = await boss.api.post('/api/v1/me/mfa/setup', {
    headers: { 'x-csrf-token': boss.csrf },
  })
  bossSecret = (await setup.json()).secret as string
  const enabled = await boss.api.post('/api/v1/me/mfa/enable', {
    headers: { 'x-csrf-token': boss.csrf },
    data: { code: totp(bossSecret) },
  })
  expect(enabled.ok(), await enabled.text()).toBeTruthy()
})

test.afterAll(async () => {
  for (const session of sessions.values()) await session.api.dispose()
})

test('сценарий B: входящее → резолюция → поручения → ответ по маршруту → подпись → регистрация → отправка → исполнение → дело', async ({
  browser,
}) => {
  test.setTimeout(420_000)

  // Скан письма — настоящий PDF со страницей текста
  const dir = mkdtempSync(path.join(tmpdir(), 'kchs-e2e-'))
  const scanPath = path.join(dir, `письмо-${run}.pdf`)
  const scan = await (await browser.newContext()).newPage()
  await scan.setContent(
    `<h1>Министерство финансов</h1><p>Исх. № 21-${run}</p><p>${subject}</p><p>Просим сообщить о готовности районов.</p>`,
  )
  await scan.pdf({ path: scanPath, format: 'A4' })
  await scan.context().close()

  // ── 1–2. Делопроизводитель: регистрация входящего со скана ────────────────
  const registrar = await pageOf(browser, actors.registrar)
  await registrar.goto('/')
  await expect(registrar.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
  await registrar.getByRole('button', { name: 'Документы', exact: true }).click()
  await registrar.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
  const screen = registrar.getByRole('region', { name: 'Регистрация входящего' })
  // Критерий фазы: регистрация со скана — не дольше 2 минут (02-roadmap.md)
  const registrationStarted = Date.now()
  await screen.locator('input[type="file"]').setInputFiles(scanPath)
  await expect(screen.getByRole('button', { name: 'Крупнее' })).toBeVisible({ timeout: 20_000 })
  await screen.getByRole('textbox', { name: 'Тема' }).fill(subject)
  await screen.getByRole('searchbox', { name: 'Корреспондент' }).fill('Минфин')
  await screen
    .getByRole('list', { name: 'Корреспондент' })
    .getByRole('button', { name: /Министерство финансов/ })
    .click()
  await screen.getByRole('textbox', { name: 'Исходящий номер отправителя' }).fill(`21-${run}`)
  await screen.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
  const registered = registrar.getByText(/Зарегистрирован № ВХ-\d{4}\/\d{2}/)
  await expect(registered).toBeVisible({ timeout: 15_000 })
  expect(Date.now() - registrationStarted).toBeLessThan(120_000)
  const incomingNumber = ((await registered.textContent()) ?? '').replace(/^.*№\s*/, '').trim()
  await registrar.getByRole('tab', { name: new RegExp(incomingNumber) }).click()
  await expect(registrar).toHaveURL(/\/o\/[0-9a-f-]{36}$/)
  const incomingId = new URL(registrar.url()).pathname.split('/').at(-1) ?? ''

  // ── 3. Руководитель с планшета: резолюция из Входящих ─────────────────────
  // Направление на резолюцию — по правилу типа: руководителю подразделения письма
  const boss = await pageOf(browser, actors.boss, TABLET)
  await openInbox(boss, `Резолюция по документу: ${subject}`)
  await boss.getByRole('button', { name: 'Наложить резолюцию', exact: true }).click()
  const resolution = boss.getByRole('dialog', { name: 'Наложить резолюцию' })
  await expect(resolution).toBeVisible({ timeout: 15_000 })
  await resolution.getByRole('combobox', { name: 'Шаблон' }).click()
  await boss.getByRole('option', { name: 'Прошу подготовить ответ' }).click()
  // Срок — рабочие дни по производственному календарю
  await expect(resolution.getByRole('spinbutton', { name: 'Рабочих дней' })).toHaveValue('5')
  await expect(resolution.getByText(/^Срок: \d{2}\.\d{2}\.\d{4}, конец дня$/)).toBeVisible()
  await resolution.getByRole('textbox', { name: 'Текст резолюции' }).fill(resolutionText)
  await resolution.getByRole('searchbox', { name: 'Ответственный' }).fill(actors.executor.name)
  await resolution
    .getByRole('list', { name: 'Ответственный' })
    .getByRole('button', { name: new RegExp(actors.executor.name) })
    .first()
    .click()
  await resolution
    .getByRole('searchbox', { name: 'Добавить соисполнителя' })
    .fill(actors.coExecutor.name)
  await resolution
    .getByRole('list', { name: 'Добавить соисполнителя' })
    .getByRole('button', { name: new RegExp(actors.coExecutor.name) })
    .first()
    .click()
  await resolution.getByRole('button', { name: 'Наложить', exact: true }).click()
  await expect(boss.getByText('Резолюция наложена, поручения созданы')).toBeVisible()
  await expect(boss.getByText('На исполнении', { exact: true }).first()).toBeVisible()

  // ── 4. Поручения созданы: исполнитель принимает своё во Входящих ──────────
  const executor = await pageOf(browser, actors.executor)
  await openInbox(executor, `Поручение: ${resolutionText}`)
  await executor.getByRole('button', { name: 'Принять', exact: true }).click()
  await expect(
    executor
      .getByRole('list', { name: 'Входящие' })
      .getByRole('option', { name: new RegExp(`Отчитаться по поручению: ${resolutionText}`) }),
  ).toBeVisible({ timeout: 15_000 })

  // ── 5. Ответ: «Ответить» из входящего, текст по бланку, подписант ─────────
  await openDocument(executor, incomingId)
  const office = await contextSection(executor, 'Делопроизводство')
  await office.getByRole('button', { name: 'Ответить', exact: true }).click()
  await expect(executor.getByText('Создан ответ', { exact: false })).toBeVisible()
  await expect(executor).not.toHaveURL(new RegExp(incomingId))
  await expect(executor).toHaveURL(/\/o\/[0-9a-f-]{36}$/)
  const replyId = new URL(executor.url()).pathname.split('/').at(-1) ?? ''
  await expect(executor.getByText('Исходящее письмо', { exact: true }).first()).toBeVisible()
  await expect(executor.getByText('Черновик', { exact: true }).first()).toBeVisible()

  await executor.getByRole('tab', { name: /Файлы и версии/ }).click()
  const templates = executor.getByRole('region', { name: 'Печатные формы и шаблоны' })
  await templates.getByRole('button', { name: 'По шаблону', exact: true }).click()
  await expect(executor.getByText('Новая версия по шаблону готова')).toBeVisible({
    timeout: 90_000,
  })
  await expect(executor.getByText('Версия 1', { exact: true })).toBeVisible()

  await executor.getByRole('tab', { name: 'Карточка', exact: true }).click()
  const card = executor.getByRole('tabpanel', { name: 'Карточка' })
  await card.getByRole('searchbox', { name: 'Подписант' }).fill(actors.boss.name)
  await card
    .getByRole('list', { name: 'Подписант' })
    .getByRole('button', { name: new RegExp(actors.boss.name) })
    .click()
  await card.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(executor.getByText('Карточка сохранена')).toBeVisible()

  // Маршрут типа: юрист и профильный отдел параллельно, затем заместитель,
  // подпись руководителя, регистрация
  await executor.getByRole('tab', { name: 'Маршрут', exact: true }).click()
  await executor.getByRole('button', { name: 'Отправить на согласование' }).first().click()
  const start = executor.getByRole('dialog', { name: 'Отправить по маршруту' })
  await expect(start).toBeVisible()
  for (const person of [actors.lawyer, actors.specialist]) {
    await start.getByRole('searchbox', { name: 'Добавить сотрудника' }).first().fill(person.name)
    await start
      .getByRole('list', { name: 'Добавить сотрудника' })
      .getByRole('button', { name: new RegExp(person.name) })
      .click()
  }
  const preview = start.getByRole('list', { name: 'Кто будет назначен' })
  await expect(preview.getByText(actors.deputy.name)).toBeVisible({ timeout: 10_000 })
  await expect(preview.getByText(actors.boss.name)).toBeVisible()
  await start.getByRole('button', { name: 'Отправить на согласование' }).click()
  await expect(executor.getByText('Документ отправлен по маршруту')).toBeVisible()
  await expect(executor.getByText('На согласовании', { exact: true }).first()).toBeVisible()

  // Юрист согласует во Входящих, профильный отдел и заместитель — своими решениями
  const lawyer = await pageOf(browser, actors.lawyer)
  await openInbox(lawyer, subject)
  await lawyer.getByRole('button', { name: 'Согласовать', exact: true }).click()
  await expect(lawyer.getByText('Выполнено')).toBeVisible()
  await decideByApi(actors.specialist, replyId, 'approve')
  await decideByApi(actors.deputy, replyId, 'approve')

  // ── Руководитель: подпись с кодом второго фактора (планшет) ───────────────
  await openDocument(boss, replyId)
  await expect(boss.getByText('На подписи', { exact: true }).first()).toBeVisible()
  const steps = await contextSection(boss, 'Действия')
  await steps.getByRole('button', { name: 'Подписать', exact: true }).click()
  const sign = boss.getByRole('dialog', { name: 'Подписать' })
  await sign
    .getByRole('textbox', { name: 'Код подтверждения' })
    .fill(totp(bossSecret, Date.now() + 30_000))
  await sign.getByRole('button', { name: 'Подписать', exact: true }).click()
  await expect(boss.getByText('Подписан', { exact: true }).first()).toBeVisible({
    timeout: 10_000,
  })

  // ── Делопроизводитель: регистрация из Входящих и отметка об отправке ─────
  await openInbox(registrar, subject)
  await registrar.getByRole('button', { name: 'Зарегистрировать', exact: true }).click()
  await expect(registrar.getByText('Выполнено')).toBeVisible()
  await expect
    .poll(() => statusOf(actors.registrar, replyId), { timeout: 15_000 })
    .toBe('registered')

  await openDocument(registrar, replyId)
  await expect(registrar.getByText(/№ ИСХ-\d{4}\/\d{2}/).first()).toBeVisible()
  const outgoingNumber = (
    (await registrar
      .getByText(/ИСХ-\d{4}\/\d{2}/)
      .first()
      .textContent()) ?? ''
  ).match(/ИСХ-\d{4}\/\d{2}/)?.[0] as string
  const dispatchSection = await contextSection(registrar, 'Делопроизводство')
  await dispatchSection.getByRole('button', { name: 'Отметить отправку', exact: true }).click()
  const dispatch = registrar.getByRole('dialog', { name: 'Отметка об отправке' })
  await expect(dispatch.getByText('Министерство финансов Республики Таджикистан')).toBeVisible()
  await dispatch.getByRole('textbox', { name: 'Номер отправления' }).fill(`RR${run}TJ`)
  await dispatch.getByRole('button', { name: 'Отметить отправку', exact: true }).click()
  await expect(registrar.getByText('Отправка отмечена')).toBeVisible()
  await expect(registrar.getByText('Исполнен', { exact: true }).first()).toBeVisible()

  // ── 6. Исполнение поручения: соисполнитель, ответственный, руководитель ───
  const coExecutor = await login(actors.coExecutor)
  const tasks = await (
    await coExecutor.api.get(`/api/v1/tasks?scope=mine&state=all&q=${run}`)
  ).json()
  const part = (tasks.items as Array<{ id: string; title: string }>).find(
    (item) => item.title === resolutionText,
  )
  expect(part, 'поручение соисполнителю').toBeTruthy()
  for (const step of ['start', 'report'] as const) {
    const done = await coExecutor.api.post(`/api/v1/tasks/${part?.id}/${step}`, {
      headers: { 'x-csrf-token': coExecutor.csrf },
      data: step === 'report' ? { text: 'Сведения районов собраны' } : {},
    })
    expect(done.ok(), await done.text()).toBeTruthy()
  }
  // Отчёт соисполнителя принимает ответственный — контролёр части
  await openInbox(executor, `Отчёт по поручению: ${resolutionText}`)
  await executor.getByRole('button', { name: 'Принять отчёт', exact: true }).click()
  await expect(executor.getByText('Выполнено')).toBeVisible()
  await openInbox(executor, `Отчитаться по поручению: ${resolutionText}`)
  await executor.getByRole('button', { name: 'Отчитаться', exact: true }).click()
  const report = executor.getByRole('dialog', { name: 'Отчитаться' })
  await report
    .getByRole('textbox', { name: 'Комментарий' })
    .fill(`Ответ ${outgoingNumber} подписан и отправлен`)
  await report.getByRole('button', { name: 'Отчитаться' }).click()
  await expect(report).toBeHidden()

  await openInbox(boss, `Отчёт по поручению: ${resolutionText}`)
  await boss.getByRole('button', { name: 'Принять отчёт', exact: true }).click()
  await expect(boss.getByText('Выполнено')).toBeVisible()
  await expect
    .poll(() => statusOf(actors.registrar, incomingId), { timeout: 30_000 })
    .toBe('executed')

  // ── Дело: номенклатура, подшивка ответа и входящего ───────────────────────
  await registrar.getByRole('button', { name: 'Документы', exact: true }).click()
  await registrar
    .getByRole('navigation', { name: 'Разделы документов' })
    .getByRole('button', { name: 'Номенклатура дел', exact: true })
    .click()
  const cases = registrar.getByRole('region', { name: 'Номенклатура дел' })
  await cases.getByRole('button', { name: 'Новое дело', exact: true }).click()
  const create = registrar.getByRole('dialog', { name: 'Новое дело' })
  await create.getByRole('textbox', { name: 'Индекс' }).fill(caseIndex)
  await create.getByRole('textbox', { name: 'Заголовок' }).fill(caseTitle)
  await create.getByRole('checkbox', { name: 'Исходящее письмо' }).check()
  await create.getByRole('checkbox', { name: 'Входящее письмо' }).check()
  await create.getByRole('button', { name: 'Создать', exact: true }).click()
  await expect(create).toBeHidden()
  await expect(cases.getByRole('heading', { name: caseTitle })).toBeVisible()

  for (const id of [replyId, incomingId]) {
    await openDocument(registrar, id)
    const section = await contextSection(registrar, 'Делопроизводство')
    await section.getByRole('button', { name: 'Подшить в дело', exact: true }).click()
    const filing = registrar.getByRole('dialog', { name: 'Подшить в дело' })
    await filing.getByRole('radio', { name: new RegExp(caseIndex) }).check()
    await filing.getByRole('button', { name: 'Подшить в дело', exact: true }).click()
    await expect(registrar.getByText(`Подшит в дело ${caseIndex}`)).toBeVisible()
    await expect(registrar.getByText('В деле', { exact: true }).first()).toBeVisible()
  }

  // ── Итог: связь «в ответ на», маршрут, лист согласования в PDF ───────────
  await openDocument(executor, replyId)
  await executor.getByRole('tab', { name: 'Связи', exact: true }).click()
  const chain = executor.getByRole('region', { name: 'Переписка' })
  await expect(chain.getByText(incomingNumber)).toBeVisible()
  await expect(executor.getByRole('heading', { name: 'В ответ на', exact: true })).toBeVisible()
  await executor.getByRole('tab', { name: 'Маршрут', exact: true }).click()
  const line = executor.getByRole('tabpanel', { name: 'Маршрут' })
  await expect(line.getByText('Завершён', { exact: true })).toBeVisible()
  const signatures = line.getByRole('region', { name: 'Подписи' })
  await expect(signatures.getByText(actors.boss.name)).toBeVisible()
  await expect(signatures.getByText(/подтверждена кодом/)).toBeVisible()

  await executor.getByRole('button', { name: 'Печать', exact: true }).click()
  await executor.getByRole('menuitem', { name: /Лист согласования/ }).click()
  await expect(executor.getByText('Готово: Лист согласования')).toBeVisible({ timeout: 90_000 })

  for (const page of [registrar, boss, executor, lawyer]) await page.context().close()
})
