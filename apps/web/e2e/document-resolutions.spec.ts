import { type APIRequestContext, request as playwrightRequest } from '@playwright/test'
import { EMPLOYEE_STATE, expect, openInboxItem, resetWorkspaceState, test } from './fixtures.js'
import { ACCOUNTS } from './global-setup.js'

const MANAGER_LOGIN = 'user001'
const CO_EXECUTOR_LOGIN = 'user002'

interface Person {
  id: string
  displayName: string
}

async function csrf(request: APIRequestContext): Promise<Record<string, string>> {
  const me = await request.get('/api/v1/me')
  expect(me.ok(), 'сессия действительна').toBeTruthy()
  return { 'x-csrf-token': (await me.json()).session.csrfToken as string }
}

async function person(request: APIRequestContext, login: string): Promise<Person> {
  const users = await request.get(`/api/v1/users?q=${login}`)
  const found = ((await users.json()).items as Array<Person & { login: string }>).find(
    (user) => user.login === login,
  )
  expect(found, `сотрудник ${login}`).toBeTruthy()
  return found as Person
}

/** Отдельная сессия сотрудника по API (соисполнитель отчитывается без браузера). */
async function signIn(baseURL: string, login: string) {
  const context = await playwrightRequest.newContext({ baseURL })
  const response = await context.post('/api/v1/auth/login', {
    data: { login, password: ACCOUNTS.employee.password, rememberDevice: false },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  return { context, headers: await csrf(context) }
}

/**
 * Зарегистрированное входящее письмо (делопроизводитель — администратор):
 * черновик с реквизитами, скан основной версией, номер из журнала «Входящие».
 */
async function registeredIncoming(
  request: APIRequestContext,
  headers: Record<string, string>,
  subject: string,
): Promise<string> {
  const run = Date.now().toString(36)
  let found = await request.get(`/api/v1/correspondents?q=${encodeURIComponent('Минфин')}`)
  if (((await found.json()).items ?? []).length === 0) {
    const created = await request.post('/api/v1/correspondents', {
      headers,
      data: {
        name: 'Министерство финансов Республики Таджикистан',
        details: { shortName: 'Минфин' },
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    found = await request.get(`/api/v1/correspondents?q=${encodeURIComponent('Минфин')}`)
  }
  const correspondentId = (await found.json()).items[0].id as string
  const types = (await (await request.get('/api/v1/document-types')).json()).items as Array<{
    id: string
    key: string
  }>
  const typeId = types.find((type) => type.key === 'incoming_letter')?.id
  expect(typeId, 'тип «Входящее письмо»').toBeTruthy()

  const draft = await request.post('/api/v1/documents', {
    headers,
    data: {
      typeId,
      subject,
      correspondentId,
      receivedDate: new Date().toISOString().slice(0, 10),
      externalNumber: `12-${run}`,
      deliveryMethod: 'post',
    },
  })
  expect(draft.ok(), await draft.text()).toBeTruthy()
  const id = (await draft.json()).id as string
  const spaceId = (await (await request.get(`/api/v1/documents/${id}`)).json()).spaceId as string

  const scan = `%PDF-1.4 скан входящего письма ${run}\n`
  const session = await request.post('/api/v1/files/upload-sessions', {
    headers,
    data: {
      name: `скан-${run}.pdf`,
      size: Buffer.byteLength(scan),
      mime: 'application/pdf',
      spaceId,
      attachToObjectId: id,
    },
  })
  expect(session.ok(), await session.text()).toBeTruthy()
  const upload = await session.json()
  const put = await request.put(upload.singlePutUrl, {
    data: scan,
    headers: { 'content-type': 'application/pdf' },
  })
  expect(put.ok(), await put.text()).toBeTruthy()
  const completed = await request.post(
    `/api/v1/files/upload-sessions/${upload.uploadId}/complete`,
    { headers, data: { uploadId: upload.uploadId, storageKey: upload.storageKey, parts: [] } },
  )
  expect(completed.ok(), await completed.text()).toBeTruthy()
  const version = await request.post(`/api/v1/documents/${id}/versions`, {
    headers,
    data: { mainFileId: upload.fileId },
  })
  expect(version.ok(), await version.text()).toBeTruthy()
  const registered = await request.post(`/api/v1/documents/${id}/register`, {
    headers,
    data: {},
  })
  expect(registered.ok(), await registered.text()).toBeTruthy()
  return id
}

// biome-ignore lint/suspicious/noExplicitAny: ответы API в тестах — без приведения типов
type Json = any

/**
 * Резолюции и исполнение (P3-E02 S05, сценарий B, шаги 3–4 и 6; ADR-0084):
 * входящее направлено руководителю — он накладывает резолюцию из Входящих
 * формой в карточке (шаблон, ответственный, соисполнитель, срок рабочими
 * днями); поручения созданы, исполнены и приняты — документ «Исполнен».
 * Ознакомление: делопроизводитель отправляет документ сотруднику, тот
 * отмечает «Ознакомлен» в карточке.
 */

test.describe('Документы: резолюции, исполнение, ознакомление', () => {
  test('резолюция из Входящих → поручения → исполнение → документ «Исполнен»', async ({
    request,
    browser,
    baseURL,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const subject = `О подготовке к паводку ${run}`
    const headers = await csrf(request)
    const manager = await person(request, MANAGER_LOGIN)
    const coExecutor = await person(request, CO_EXECUTOR_LOGIN)
    const admin = await person(request, 'admin')

    // Делопроизводитель: входящее зарегистрировано и направлено руководителю
    const documentId = await registeredIncoming(request, headers, subject)
    const before = await (await request.get(`/api/v1/documents/${documentId}/resolutions`)).json()
    const waiting = (before.requests as Json[]).some(
      (item) => item.user.id === manager.id && item.state === 'open',
    )
    if (!waiting) {
      const sent = await request.post(`/api/v1/documents/${documentId}/resolution-requests`, {
        headers,
        data: { userId: manager.id, note: 'Прошу рассмотреть' },
      })
      expect(sent.ok(), await sent.text()).toBeTruthy()
    }

    // Руководитель: дело во Входящих → «Наложить резолюцию» → форма в карточке
    const managerContext = await browser.newContext({ baseURL, storageState: EMPLOYEE_STATE })
    await resetWorkspaceState(managerContext.request)
    const managerPage = await managerContext.newPage()
    await managerPage.goto('/inbox')
    await openInboxItem(managerPage, new RegExp(`Резолюция по документу: ${subject}`))
    await managerPage.getByRole('button', { name: 'Наложить резолюцию', exact: true }).click()
    const dialog = managerPage.getByRole('dialog', { name: 'Наложить резолюцию' })
    await expect(dialog).toBeVisible({ timeout: 15_000 })

    // Шаблон заполняет текст, срок в рабочих днях и контроль
    await dialog.getByRole('combobox', { name: 'Шаблон' }).click()
    await managerPage.getByRole('option', { name: 'Прошу подготовить ответ' }).click()
    await expect(dialog.getByRole('textbox', { name: 'Текст резолюции' })).toHaveValue(
      'Прошу подготовить ответ',
    )
    await expect(dialog.getByRole('spinbutton', { name: 'Рабочих дней' })).toHaveValue('5')
    await expect(dialog.getByText(/^Срок: \d{2}\.\d{2}\.\d{4}, конец дня$/)).toBeVisible()
    await dialog.getByRole('searchbox', { name: 'Ответственный' }).fill('admin')
    await dialog
      .getByRole('list', { name: 'Ответственный' })
      .getByRole('button', { name: new RegExp(admin.displayName) })
      .first()
      .click()
    await dialog.getByRole('searchbox', { name: 'Добавить соисполнителя' }).fill(CO_EXECUTOR_LOGIN)
    await dialog
      .getByRole('list', { name: 'Добавить соисполнителя' })
      .getByRole('button')
      .first()
      .click()
    await expect(
      dialog.getByRole('list', { name: 'Соисполнители' }).getByText(coExecutor.displayName),
    ).toBeVisible()
    await dialog.getByRole('button', { name: 'Наложить', exact: true }).click()
    await expect(managerPage.getByText('Резолюция наложена, поручения созданы')).toBeVisible()
    // Карточка открыта на вкладке резолюций (под диалогом она скрыта от дерева доступности)
    await expect(managerPage.getByRole('tab', { name: 'Резолюции и поручения' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    // Резолюция в карточке: поручения ответственному и соисполнителю, документ на исполнении
    const resolution = managerPage.getByRole('article', { name: /Резолюция от/ })
    await expect(resolution.getByText('Прошу подготовить ответ')).toBeVisible()
    await expect(resolution.getByText('Открыто 2 из 2')).toBeVisible()
    const instructions = resolution.getByRole('list', { name: 'Поручения резолюции' })
    await expect(instructions.getByRole('button')).toHaveCount(2)
    await expect(managerPage.getByText('На исполнении', { exact: true }).first()).toBeVisible()
    // Направление руководителя закрыто его резолюцией
    const requests = managerPage.getByRole('region', { name: 'Направления на резолюцию' })
    await expect(
      requests.getByRole('listitem').filter({ hasText: manager.displayName }),
    ).toContainText('Резолюция наложена')

    // Исполнение: соисполнитель и ответственный отчитываются, отчёты приняты
    const view = await (await request.get(`/api/v1/documents/${documentId}/resolutions`)).json()
    const tasks = view.items[0].instructions as Json[]
    const main = tasks.find((task) => task.parentId === null)
    const part = tasks.find((task) => task.parentId !== null)
    expect(main?.assignee.id).toBe(admin.id)
    expect(part?.assignee.id).toBe(coExecutor.id)
    const co = await signIn(baseURL ?? '', CO_EXECUTOR_LOGIN)
    for (const step of ['start', 'report'] as const) {
      const done = await co.context.post(`/api/v1/tasks/${part.id}/${step}`, {
        headers: co.headers,
        data: step === 'report' ? { text: 'Данные районов собраны' } : {},
      })
      expect(done.ok(), await done.text()).toBeTruthy()
    }
    await co.context.dispose()
    // Отчёт соисполнителя принимает ответственный — контролёр части
    const partAccepted = await request.post(`/api/v1/tasks/${part.id}/accept`, {
      headers,
      data: {},
    })
    expect(partAccepted.ok(), await partAccepted.text()).toBeTruthy()
    for (const step of ['start', 'report'] as const) {
      const done = await request.post(`/api/v1/tasks/${main.id}/${step}`, {
        headers,
        data: step === 'report' ? { text: 'Ответ подготовлен' } : {},
      })
      expect(done.ok(), await done.text()).toBeTruthy()
    }

    // Автор резолюции принимает отчёт во Входящих — документ «Исполнен»
    await managerPage.goto('/inbox')
    await openInboxItem(managerPage, /Отчёт по поручению: Прошу подготовить ответ/)
    await managerPage.getByRole('button', { name: 'Принять отчёт', exact: true }).click()
    await expect(managerPage.getByText('Выполнено')).toBeVisible()
    await expect
      .poll(
        async () =>
          (await (await request.get(`/api/v1/documents/${documentId}`)).json()).status as string,
        { timeout: 30_000 },
      )
      .toBe('executed')
    const executed = await (await request.get(`/api/v1/documents/${documentId}`)).json()
    expect(executed.control).toBe('done')

    // Карточка у руководителя: «Исполнен», все поручения закрыты
    await managerPage.goto(`/o/${documentId}`)
    await managerPage.getByRole('tab', { name: 'Резолюции и поручения' }).click()
    await expect(managerPage.getByText('Все поручения закрыты')).toBeVisible()
    await expect(managerPage.getByText('Исполнен', { exact: true }).first()).toBeVisible()
    await managerContext.close()
  })

  test('ознакомление: делопроизводитель отправляет, сотрудник отмечает в карточке', async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const subject = `О режиме работы ${run}`
    const headers = await csrf(request)
    const employee = await person(request, MANAGER_LOGIN)
    const documentId = await registeredIncoming(request, headers, subject)

    // Делопроизводитель: «Ознакомление» → «Отправить на ознакомление» → сотрудник
    await resetWorkspaceState(request)
    await page.goto(`/o/${documentId}`)
    await page.getByRole('tab', { name: 'Ознакомление' }).click()
    await page.getByRole('button', { name: 'Отправить на ознакомление' }).click()
    const dialog = page.getByRole('dialog', { name: 'Отправить на ознакомление' })
    await dialog.getByRole('searchbox', { name: 'Кому' }).fill(MANAGER_LOGIN)
    await dialog
      .getByRole('list', { name: 'Найдено: Кому' })
      .getByRole('button', { name: new RegExp(employee.displayName) })
      .first()
      .click()
    await dialog.getByRole('button', { name: 'Отправить', exact: true }).click()
    await expect(page.getByText('Отправлено 1 сотруднику')).toBeVisible()
    const list = page.getByRole('list', { name: 'Сотрудники' })
    await expect(list.getByText(employee.displayName)).toBeVisible()
    await expect(list.getByText('Ждёт', { exact: true })).toBeVisible()

    // Сотрудник: документ виден, «Ознакомлен» — отметка
    const context = await browser.newContext({ baseURL, storageState: EMPLOYEE_STATE })
    await resetWorkspaceState(context.request)
    const employeePage = await context.newPage()
    await employeePage.goto(`/o/${documentId}`)
    await employeePage.getByRole('tab', { name: 'Ознакомление' }).click()
    await expect(employeePage.getByText('Вас просят ознакомиться с документом')).toBeVisible()
    await employeePage.getByRole('button', { name: 'Ознакомлен', exact: true }).click()
    await expect(employeePage.getByText('Отметка об ознакомлении поставлена')).toBeVisible()
    await expect(employeePage.getByText('Вас просят ознакомиться с документом')).toHaveCount(0)
    await context.close()

    // Делопроизводитель видит отметку
    await page.reload()
    await page.getByRole('tab', { name: 'Ознакомление' }).click()
    await expect(page.getByText('Ознакомлены 1 из 1')).toBeVisible({ timeout: 15_000 })
    await expect(
      page.getByRole('list', { name: 'Сотрудники' }).getByText('Ознакомлен', { exact: true }),
    ).toBeVisible()
  })
})
