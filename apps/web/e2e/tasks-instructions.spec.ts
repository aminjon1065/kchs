import { EMPLOYEE_STATE, expect, test } from './fixtures.js'

const EMPLOYEE_LOGIN = 'user001'

/**
 * Сценарий приёмки фазы 1 №6 (04-verification.md): руководитель создаёт
 * поручение из строки датасета; исполнитель принимает его и отчитывается;
 * руководитель принимает отчёт; дела во Входящих обоих закрыты. Доставка
 * назначения в Telegram со ссылкой на поручение проверена интеграционным тестом
 * `apps/api/test/telegram.test.ts` (поддельный Bot API): на стенде бот не настроен.
 */
test.describe('Задачи: поручение из строки датасета', () => {
  test('поручение → принято → отчёт → принят; Входящие закрыты', async ({
    page,
    request,
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }

    const users = await request.get(`/api/v1/users?q=${EMPLOYEE_LOGIN}`)
    const employee = ((await users.json()).items as Array<{ login: string }>).find(
      (user) => user.login === EMPLOYEE_LOGIN,
    )
    expect(employee).toBeTruthy()
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const space = spaces.find((item) => item.kind === 'team') ?? spaces[0]
    const created = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Сводка происшествий ${run}`,
        spaceId: space?.id,
        fields: [
          { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
          { key: 'district', label: { ru: 'Район' }, type: 'text' },
        ],
        primaryKey: ['code'],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const datasetId = (await created.json()).id as string
    const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: { rows: [{ values: { code: `P-${run}`, district: 'Бохтар' } }] },
    })
    expect(inserted.ok(), await inserted.text()).toBeTruthy()

    // Руководитель: карточка строки → «Создать поручение»
    const title = `Проверить сводку ${run}`
    await page.goto(`/o/${datasetId}`)
    await page.getByRole('grid').getByRole('rowheader', { name: '1', exact: true }).dblclick()
    await page.getByRole('button', { name: 'Создать поручение' }).click()
    const dialog = page.getByRole('dialog', { name: 'Новое поручение' })
    await expect(dialog.getByText(/По строке «/)).toBeVisible()
    await dialog.getByRole('textbox', { name: 'Название' }).fill(title)
    await dialog.getByRole('searchbox', { name: 'Исполнитель' }).fill(EMPLOYEE_LOGIN)
    await dialog.getByRole('list', { name: 'Исполнитель' }).getByRole('button').first().click()
    const due = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
    await dialog.getByLabel('Срок').fill(due)
    await dialog.getByRole('button', { name: 'Создать' }).click()
    await expect(page.getByText('Поручение создано')).toBeVisible()

    // Исполнитель — в своём браузере: принимает и отчитывается
    const assignee = await browser.newContext({ baseURL, storageState: EMPLOYEE_STATE })
    const executor = await assignee.newPage()
    await executor.goto('/inbox')
    const executorInbox = executor.getByRole('list', { name: 'Входящие' })
    await executorInbox.getByRole('option', { name: new RegExp(`Поручение: ${title}`) }).click()
    await executor.getByRole('button', { name: 'Принять', exact: true }).click()
    await executorInbox
      .getByRole('option', { name: new RegExp(`Отчитаться по поручению: ${title}`) })
      .click()
    await executor.getByRole('button', { name: 'Отчитаться', exact: true }).click()
    const report = executor.getByRole('dialog', { name: 'Отчитаться' })
    await report
      .getByRole('textbox', { name: 'Комментарий' })
      .fill('Сводка проверена, расхождений нет')
    await report.getByRole('button', { name: 'Отчитаться' }).click()
    await expect(executorInbox.getByRole('option', { name: new RegExp(title) })).toHaveCount(0)

    // Руководитель принимает отчёт
    await page.goto('/inbox')
    const authorInbox = page.getByRole('list', { name: 'Входящие' })
    await authorInbox
      .getByRole('option', { name: new RegExp(`Отчёт по поручению: ${title}`) })
      .click()
    await page.getByRole('button', { name: 'Принять отчёт', exact: true }).click()
    await expect(authorInbox.getByRole('option', { name: new RegExp(title) })).toHaveCount(0)

    // Поручение закрыто: у обоих Входящие по нему пусты, статус «Принято»
    await executor.reload()
    await expect(
      executor
        .getByRole('list', { name: 'Входящие' })
        .getByRole('option', { name: new RegExp(title) }),
    ).toHaveCount(0)
    const tasks = await request.get(`/api/v1/tasks?scope=assigned_by_me&state=all&q=${run}`)
    expect(tasks.ok(), await tasks.text()).toBeTruthy()
    const task = ((await tasks.json()).items as Array<{ title: string; status: string }>).find(
      (item) => item.title === title,
    )
    expect(task?.status).toBe('accepted')
    await assignee.close()
  })
})
