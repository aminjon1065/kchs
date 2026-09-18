import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Browser,
  type BrowserContext,
  type Page,
  request as playwrightRequest,
} from '@playwright/test'
import { ADMIN_STATE, EMPLOYEE_STATE, expect, openScreen, test, totp } from './fixtures.js'

/**
 * Приёмка фазы 0 (04-verification.md §3) — сценарии 1–7 подряд, через интерфейс.
 * Действующие лица: администратор с MFA (создаётся для прогона), новый
 * сотрудник-владелец, коллега (user001 из seed), гость по ссылке и четвёртый —
 * участник пространства, принятый уже после разрыва наследования.
 * Что в браузере не воспроизвести, проверяют интеграционные тесты:
 * - сценарий 6, «заместитель видит элемент Входящих»: в фазе 0 элементы Входящих
 *   ещё никто не создаёт (поручения и согласования — фазы 1 и 3), поэтому элемент
 *   открывается напрямую через InboxService в acceptance.test.ts;
 * - сценарий 7, «worker убит во время задания»: events.test.ts и jobs.test.ts.
 */
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

const BASE = 'http://localhost:5173'
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025'
const run = Date.now().toString(36)

const admin = {
  login: `acc-admin-${run}`,
  password: 'Priyomka-Admin-2026!',
  secret: '',
  lastStep: 0,
}
const owner = {
  login: `acc-owner-${run}`,
  email: `acc-owner-${run}@kchs.test`,
  lastName: `Приёмова${run}`,
  firstName: 'Зарина',
  password: 'Svoy-Parol-Priyomki-2026!',
  temporary: '',
}
const ownerName = `${owner.lastName} ${owner.firstName}`
const unitName = `Отдел приёмки ${run}`
const spaceName = `Проект ${run}`
const folderName = `Сводки ${run}`
const pdfName = `svodka-${run}.pdf`
let fileId = ''
let spaceId = ''

/** PDF с одной страницей текста и балластом до нужного размера — корректный xref. */
function bigPdf(sizeBytes: number): Buffer {
  const chunks: Buffer[] = []
  const offsets: number[] = []
  let size = 0
  const add = (data: string | Buffer) => {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'latin1') : data
    chunks.push(buffer)
    size += buffer.length
  }
  const object = (id: number, ...body: Array<string | Buffer>) => {
    offsets[id] = size
    add(`${id} 0 obj\n`)
    for (const part of body) add(part)
    add('\nendobj\n')
  }
  const text = 'BT /F1 28 Tf 72 740 Td (Flood report: water level 412 cm) Tj ET'
  const padding = Buffer.alloc(Math.max(0, sizeBytes - 1024), 0x41)
  add('%PDF-1.4\n')
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  object(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  )
  object(4, `<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
  object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  object(6, `<< /Length ${padding.length} >>\nstream\n`, padding, '\nendstream')
  const xref = size
  add('xref\n0 7\n0000000000 65535 f \n')
  for (let id = 1; id <= 6; id++) add(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`)
  add(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return Buffer.concat(chunks)
}

async function adminApi() {
  const api = await playwrightRequest.newContext({ baseURL: BASE, storageState: ADMIN_STATE })
  const me = await api.get('/api/v1/me')
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
  return { api, headers }
}

/** Отдельный браузерный контекст без сессии — как новый сотрудник за своим компьютером. */
async function freshPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE, storageState: undefined })
  await context.addInitScript(() => {
    localStorage.removeItem('kchs.workspace')
    localStorage.removeItem('kchs.appearance')
  })
  return { context, page: await context.newPage() }
}

/** Код TOTP новее последнего принятого: повтор шага сервер отклоняет, окно — ±1 шаг. */
async function nextCode(): Promise<string> {
  while (Math.floor(Date.now() / 30_000) < admin.lastStep) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  const at = Date.now() + 30_000
  admin.lastStep = Math.floor(at / 30_000)
  return totp(admin.secret, at)
}

/** Прошлые сценарии оставили вкладки на сервере — каждый шаг начинает с чистого листа. */
async function resetWorkspace(page: Page): Promise<void> {
  const me = await page.request.get('/api/v1/me')
  const csrf = (await me.json()).session.csrfToken as string
  await page.request.put('/api/v1/me/workspace-state', {
    data: { state: null },
    headers: { 'x-csrf-token': csrf },
  })
  await page.evaluate(() => localStorage.removeItem('kchs.workspace'))
  await page.reload()
  await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
}

async function signIn(page: Page, login: string, password: string): Promise<void> {
  await page.goto('/')
  await page.getByLabel('Логин или почта').fill(login)
  await page.getByLabel('Пароль', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
}

test.beforeAll(async () => {
  // Администратор организации для прогона: seed создаёт одного, MFA включается на новом,
  // чтобы не менять вход общего администратора остальных сценариев
  const { api, headers } = await adminApi()
  const created = await api.post('/api/v1/users', {
    headers,
    data: {
      login: admin.login,
      lastName: 'Администраторов',
      firstName: `Приёмка${run}`,
      roleKeys: ['system_admin'],
      password: admin.password,
      mustChangePassword: false,
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  await api.dispose()
})

test('1. Администратор входит с MFA, создаёт подразделение и сотрудника, назначает роль', async ({
  browser,
}) => {
  const { context, page } = await freshPage(browser)
  await signIn(page, admin.login, admin.password)
  await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })

  // Второй фактор: подключение в профиле
  await openScreen(page, 'Настройки')
  await page.getByRole('button', { name: 'Подключить' }).click()
  admin.secret = (await page.locator('code').first().innerText()).replace(/\s/g, '')
  admin.lastStep = Math.floor(Date.now() / 30_000)
  await page.getByLabel('Код из приложения').fill(totp(admin.secret))
  await page.getByRole('button', { name: 'Подтвердить' }).click()
  await page.getByRole('checkbox', { name: 'Я сохранил коды в надёжном месте' }).check()
  await page.getByRole('button', { name: 'Готово' }).click()
  await expect(page.getByText('Двухфакторная аутентификация включена')).toBeVisible()

  // Выход и вход уже с кодом (следующий шаг TOTP — повтор того же кода запрещён)
  await page.getByRole('button', { name: 'Выйти' }).first().click()
  await signIn(page, admin.login, admin.password)
  await expect(page.getByText('Подтверждение входа')).toBeVisible()
  await page.getByLabel('Код', { exact: true }).fill(await nextCode())
  await page.getByRole('button', { name: 'Подтвердить' }).click()
  await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })

  // Подразделение
  await openScreen(page, 'Администрирование')
  await page.getByRole('tab', { name: 'Оргструктура' }).click()
  await page.getByRole('button', { name: 'Новое подразделение' }).click()
  const unitDialog = page.getByRole('dialog')
  await unitDialog.getByLabel('Название (рус.)').fill(unitName)
  await unitDialog.getByLabel('Код').fill(`ACC-${run}`)
  await unitDialog.getByRole('button', { name: 'Создать' }).click()
  await expect(page.getByText('Подразделение создано')).toBeVisible()
  await expect(page.getByText(unitName)).toBeVisible()

  // Сотрудник с ролью, дающей право создавать пространства
  await page.getByRole('tab', { name: 'Пользователи' }).click()
  await page.getByRole('button', { name: 'Новый пользователь' }).click()
  const userDialog = page.getByRole('dialog')
  await userDialog.getByLabel('Фамилия').fill(owner.lastName)
  await userDialog.getByLabel(/^Имя/).fill(owner.firstName)
  await userDialog.getByLabel('Логин').fill(owner.login)
  await userDialog.getByLabel('Электронная почта').fill(owner.email)
  await userDialog.getByRole('combobox', { name: 'Подразделение' }).click()
  await page.getByRole('option', { name: unitName }).click()
  await userDialog.getByRole('checkbox', { name: 'Ответственный за данные' }).check()
  await userDialog.getByRole('button', { name: 'Создать' }).click()
  owner.temporary = (await userDialog.locator('code').innerText()).trim()
  expect(owner.temporary.length).toBeGreaterThan(8)
  await userDialog.getByRole('button', { name: 'Готово' }).click()

  // Роль назначается и позже — «Изменить роли»
  await page.getByPlaceholder('Имя, логин или почта').fill(owner.login)
  // Поиск применяется с задержкой — ждём, пока в списке останется один сотрудник
  await expect(page.getByRole('button', { name: /^Действия: / })).toHaveCount(1)
  await page.getByRole('button', { name: `Действия: ${ownerName}` }).click()
  await page.getByRole('menuitem', { name: 'Изменить роли' }).click()
  const rolesDialog = page.getByRole('dialog')
  await expect(rolesDialog.getByRole('checkbox', { name: 'Ответственный за данные' })).toBeChecked()
  await rolesDialog.getByRole('checkbox', { name: 'Сотрудник' }).check()
  await rolesDialog.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByText('Роли сохранены')).toBeVisible()
  await context.close()
})

test('2. Сотрудник входит, видит «Мой день», создаёт пространство и приглашает коллегу', async ({
  browser,
}) => {
  const { context, page } = await freshPage(browser)
  await signIn(page, owner.login, owner.temporary)
  await page.getByLabel('Временный пароль').fill(owner.temporary)
  await page.getByLabel('Новый пароль', { exact: true }).fill(owner.password)
  await page.getByLabel('Повторите новый пароль').fill(owner.password)
  await page.getByRole('button', { name: 'Сменить пароль' }).click()
  await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Новое пространство' }).first().click()
  const spaceDialog = page.getByRole('dialog')
  await spaceDialog.getByLabel('Название').fill(spaceName)
  await spaceDialog.getByRole('button', { name: 'Создать' }).click()
  await expect(page.getByRole('tab', { name: new RegExp(spaceName) })).toBeVisible()

  await page.getByRole('button', { name: 'Добавить участника' }).click()
  const inviteDialog = page.getByRole('dialog')
  await inviteDialog.getByPlaceholder('Имя, логин или почта').fill('user001')
  await inviteDialog
    .getByRole('list', { name: 'Найденные сотрудники' })
    .getByRole('button')
    .first()
    .click()
  await inviteDialog.getByRole('combobox', { name: 'Роль' }).click()
  await page.getByRole('option', { name: 'Редактор' }).click()
  await inviteDialog.getByRole('button', { name: 'Добавить' }).click()
  await expect(page.getByText(/в пространстве/)).toBeVisible()

  const spaces = await page.request.get('/api/v1/spaces')
  spaceId = (await spaces.json()).items.find(
    (space: { name: string }) => space.name === spaceName,
  ).id
  const members = await page.request.get(`/api/v1/spaces/${spaceId}/members`)
  const roles = (await members.json()).items.map((member: { role: string }) => member.role)
  expect(roles).toContain('editor')
  await context.close()
})

test('3. PDF 50 МБ в папке: коллега видит превью, упоминает автора — уведомление и письмо', async ({
  browser,
}) => {
  const { context, page } = await freshPage(browser)
  await signIn(page, owner.login, owner.password)
  await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })

  // Папка в новом пространстве и загрузка 50 МБ (multipart напрямую в хранилище)
  await resetWorkspace(page)
  await page.goto(`/spaces/${spaceId}`)
  await page
    .getByRole('tab', { name: /^Файлы/ })
    .first()
    .click()
  await page.getByRole('button', { name: 'Новая папка' }).click()
  await page.getByLabel('Имя папки').fill(folderName)
  await page.getByRole('button', { name: 'Создать' }).click()
  await page.getByRole('gridcell', { name: folderName }).click()
  const dir = mkdtempSync(path.join(tmpdir(), 'kchs-acc-'))
  const pdfPath = path.join(dir, pdfName)
  writeFileSync(pdfPath, bigPdf(50 * 1024 * 1024))
  await page.locator('input[type="file"]').first().setInputFiles(pdfPath)
  await expect(page.getByText(`Загружен «${pdfName}»`)).toBeVisible({ timeout: 120_000 })
  const listed = await page.request.get(
    `/api/v1/objects?spaceId=${spaceId}&type=file&q=${encodeURIComponent(pdfName)}`,
  )
  fileId = (await listed.json()).items[0].id as string
  await context.close()

  // Коллега: превью от движка и комментарий с упоминанием
  const colleague = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
  const colleaguePage = await colleague.newPage()
  await colleaguePage.goto(`/o/${fileId}`)
  await expect(colleaguePage.getByRole('img', { name: /Страница 1/ })).toBeVisible({
    timeout: 90_000,
  })
  await colleaguePage.getByRole('button', { name: 'Обсуждение', exact: true }).click()
  const composer = colleaguePage.getByLabel('Оставьте комментарий…')
  // Фамилия с меткой прогона: у прошлых прогонов то же начало фамилии
  await composer.fill(`@${owner.lastName}`)
  await expect(colleaguePage.getByRole('option', { name: new RegExp(ownerName) })).toBeVisible()
  await composer.press('Enter')
  await composer.pressSequentially('проверьте уровень воды')
  await colleaguePage.getByRole('button', { name: 'Отправить' }).click()
  await expect(colleaguePage.getByText(`@${ownerName} проверьте уровень воды`)).toBeVisible()
  await colleague.close()

  // Автор: уведомление в приложении и письмо (упоминание уходит сразу)
  const author = await freshPage(browser)
  await signIn(author.page, owner.login, owner.password)
  await expect(author.page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(
      async () => {
        const list = await author.page.request.get('/api/v1/notifications')
        return (await list.json()).items.map((item: { category: string }) => item.category)
      },
      { timeout: 30_000 },
    )
    .toContain('mention')
  // Письмо именно об упоминании в этом файле, а не любое письмо автору
  await expect
    .poll(
      async () => {
        const found = await author.page.request.get(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${owner.email}`)}`,
        )
        if (!found.ok()) return false
        for (const message of (await found.json()).messages as Array<{ ID: string }>) {
          const full = await author.page.request.get(`${MAILPIT}/api/v1/message/${message.ID}`)
          const html = (await full.json()).HTML as string
          // С именем автора: шаблон «{actor} упомянул вас…» подставляется целиком
          if (html.includes(`упомянул вас в «${pdfName}»`) && !html.includes('{actor}')) {
            return true
          }
        }
        return false
      },
      { timeout: 60_000 },
    )
    .toBe(true)
  await author.context.close()
})

test('4. Разрыв наследования, ссылка с паролем для третьего, четвёртый не находит файл', async ({
  browser,
}) => {
  // Четвёртый — сотрудник, которого добавят в пространство уже после разрыва:
  // роль пространства не открывает закрытую папку
  const { api, headers } = await adminApi()
  const fourth = { login: `acc-fourth-${run}`, password: 'Chetvyortyi-Parol-2026!' }
  const created = await api.post('/api/v1/users', {
    headers,
    data: {
      login: fourth.login,
      lastName: 'Четвёртов',
      firstName: 'Приёмка',
      password: fourth.password,
      mustChangePassword: false,
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const fourthId = (await created.json()).id as string
  await api.dispose()

  const { context, page } = await freshPage(browser)
  await signIn(page, owner.login, owner.password)
  await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
  await resetWorkspace(page)
  await page.goto(`/spaces/${spaceId}`)
  await page
    .getByRole('tab', { name: /^Файлы/ })
    .first()
    .click()

  // Разрыв наследования у папки
  const folderRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell', { name: folderName }) })
  await folderRow.hover()
  await folderRow.getByRole('button', { name: 'Поделиться' }).click()
  await page.getByRole('switch', { name: 'Наследовать доступ от родителя' }).click()
  await expect(page.getByText('Текущие права будут скопированы явно')).toBeVisible()
  await page.keyboard.press('Escape')

  // Ссылка с паролем на файл
  await page.getByRole('gridcell', { name: folderName }).click()
  const fileRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell', { name: pdfName }) })
  await fileRow.hover()
  await fileRow.getByRole('button', { name: 'Поделиться' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Создать ссылку' }).click()
  await dialog.getByLabel('Пароль', { exact: true }).fill('priyomka-link')
  await dialog.getByRole('button', { name: 'Создать ссылку' }).click()
  const url = new URL(await dialog.getByLabel('Адрес гостевой ссылки').inputValue())

  // После разрыва владелец принимает четвёртого в пространство
  const csrf = (await (await page.request.get('/api/v1/me')).json()).session.csrfToken as string
  const joined = await page.request.post(`/api/v1/spaces/${spaceId}/members`, {
    data: { userId: fourthId, role: 'member' },
    headers: { 'x-csrf-token': csrf },
  })
  expect(joined.ok(), await joined.text()).toBeTruthy()
  await context.close()

  // Третий — по ссылке, без входа
  const guest = await freshPage(browser)
  await guest.page.goto(url.pathname)
  await guest.page.getByLabel('Пароль ссылки').fill('priyomka-link')
  await guest.page.getByRole('button', { name: 'Открыть' }).click()
  await expect(guest.page.getByRole('heading', { name: pdfName })).toBeVisible()
  await guest.context.close()

  // Коллега из пространства по-прежнему находит файл: права скопированы при разрыве.
  // Тот же запрос у четвёртого ниже пуст не потому, что поиск ничего не находит
  const colleague = await playwrightRequest.newContext({
    baseURL: BASE,
    storageState: EMPLOYEE_STATE,
  })
  const found = async (request: typeof colleague) => {
    const search = await request.get(`/api/v1/search?q=${encodeURIComponent(pdfName)}`)
    return (await search.json()).hits.map((hit: { objectId: string }) => hit.objectId) as string[]
  }
  await expect.poll(() => found(colleague), { timeout: 30_000 }).toContain(fileId)
  await colleague.dispose()

  // Четвёртый: участник пространства, но ни поиска, ни прямого адреса файла
  const outsider = await freshPage(browser)
  await signIn(outsider.page, fourth.login, fourth.password)
  await expect(outsider.page.getByRole('tab', { name: /Мой день/ })).toBeVisible({
    timeout: 20_000,
  })
  expect((await outsider.page.request.get(`/api/v1/objects/${spaceId}`)).status()).toBe(200)
  expect(await found(outsider.page.request)).not.toContain(fileId)
  expect((await outsider.page.request.get(`/api/v1/objects/${fileId}`)).status()).toBe(404)
  // Ссылка на файл открывает «Мой день» с предупреждением, не раскрывая, что файл есть
  await outsider.page.goto(`/o/${fileId}`)
  await expect(outsider.page.getByText('Объект недоступен или удалён')).toBeVisible({
    timeout: 15_000,
  })
  await expect(outsider.page.getByRole('tab', { name: new RegExp(pdfName) })).toHaveCount(0)
  await outsider.context.close()
})

test('5. Пять вкладок и разделение переживают перезагрузку', async ({ browser }) => {
  const { context, page } = await freshPage(browser)
  await signIn(page, owner.login, owner.password)
  await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
  await resetWorkspace(page)
  for (const screen of ['Файлы', 'Входящие', 'Уведомления', 'Корзина']) {
    await openScreen(page, screen)
  }
  await expect(page.getByRole('tab')).toHaveCount(5)
  await page.keyboard.press('Meta+\\')
  await expect(page.getByRole('tablist')).toHaveCount(2)
  await page.waitForTimeout(3000)
  await page.reload()
  await expect(page.getByRole('tablist')).toHaveCount(2, { timeout: 20_000 })
  await expect(page.getByRole('tab')).toHaveCount(5)
  await context.close()
})

test('6. Замещение: заместитель действует «от имени», аудит видит обоих', async ({ browser }) => {
  const { context, page } = await freshPage(browser)
  await signIn(page, owner.login, owner.password)
  await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
  await openScreen(page, 'Настройки')
  await page.getByRole('button', { name: 'Назначить заместителя' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('Имя, логин или почта').fill('user001')
  await dialog.locator('ul button').first().click()
  await dialog.getByRole('button', { name: 'Назначить' }).click()
  await expect(page.getByText(/замещает вас/)).toBeVisible()
  const ownerId = (await (await page.request.get('/api/v1/me')).json()).user.id as string
  await context.close()

  // Заместитель: баннер, режим «от имени», скачивание файла владельца
  const deputy = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
  const deputyPage = await deputy.newPage()
  const deputyId = (await (await deputyPage.request.get('/api/v1/me')).json()).user.id as string
  await deputyPage.goto(`/o/${fileId}`)
  await expect(deputyPage.getByText('Вы замещаете', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await deputyPage.getByRole('combobox', { name: 'Вы замещаете' }).click()
  await deputyPage.getByRole('option', { name: new RegExp(ownerName) }).click()
  await expect(deputyPage.getByRole('button', { name: 'Выйти из режима' })).toBeVisible()
  const [download] = await Promise.all([
    deputyPage.waitForEvent('download'),
    deputyPage.getByRole('button', { name: 'Скачать' }).first().click(),
  ])
  expect(download.suggestedFilename()).toBe(pdfName)
  await deputy.close()

  // Аудит: скачивание записано за заместителем «от имени» владельца
  const { api } = await adminApi()
  await expect
    .poll(
      async () => {
        const audit = await api.get('/api/v1/admin/audit?action=file.downloaded&limit=50')
        return (await audit.json()).items.some(
          (entry: { actorId: string | null; onBehalfOf: string | null; objectId: string | null }) =>
            entry.actorId === deputyId && entry.onBehalfOf === ownerId && entry.objectId === fileId,
        )
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  await api.dispose()
})

test('7. Администратор смотрит здоровье и аудит', async ({ browser }) => {
  const { context, page } = await freshPage(browser)
  await signIn(page, admin.login, admin.password)
  await page.getByLabel('Код', { exact: true }).fill(await nextCode())
  await page.getByRole('button', { name: 'Подтвердить' }).click()
  await expect(page.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
  await openScreen(page, 'Администрирование')
  await expect(page.getByText('postgres')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Работает').first()).toBeVisible()
  await page.getByRole('tab', { name: 'Аудит' }).click()
  await page.getByPlaceholder('Действие, например user.login').fill('user.mfa_enabled')
  await expect(page.getByText('user.mfa_enabled').first()).toBeVisible({ timeout: 15_000 })
  await context.close()
})
