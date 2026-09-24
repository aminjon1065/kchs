import { createServiceAccount, expect, openScreen, openWorkspace, test } from './fixtures.js'

/**
 * Формы сбора данных и алерты (P5-E03, ADR-0103, ADR-0104): сводка сдаётся с
 * экрана заполнения и попадает в матрицу контроля; алерт на показатель
 * проверяется тестовым прогоном и «сейчас», срабатывание видно в истории.
 * Датасет, форма и показатель готовятся по API — сценарий проверяет экраны.
 */
test.describe('Данные: формы сбора и алерты', () => {
  test('сводка сдаётся и попадает в матрицу контроля', async ({ page, request }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const formName = `Суточная сводка ${run}`

    const me = await request.get('/api/v1/me')
    const profile = await me.json()
    const headers = { 'x-csrf-token': profile.session.csrfToken as string }
    const userId = profile.user.id as string

    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id

    const dataset = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Происшествия ${run}`,
        spaceId,
        fields: [
          { key: 'people', label: { ru: 'Людей' }, type: 'integer', semantic: 'measure' },
          { key: 'note', label: { ru: 'Примечание' }, type: 'text' },
          { key: 'period', label: { ru: 'Период' }, type: 'date', semantic: 'time' },
        ],
      },
    })
    expect(dataset.ok(), await dataset.text()).toBeTruthy()
    const datasetId = (await dataset.json()).id as string

    // Строки сводки пишет служебная учётная запись с правкой пространства (ADR-0130)
    const writer = await createServiceAccount(request, `Сводки ${formName}`, [
      { spaceId: spaceId as string, role: 'editor' },
    ])
    const form = await request.post('/api/v1/forms', {
      headers,
      data: {
        name: formName,
        spaceId,
        runAs: writer.id,
        definition: {
          datasetId,
          fields: [
            { key: 'people', required: true },
            { key: 'note', required: false },
          ],
          auto: { period: 'period' },
          schedule: { periodicity: 'daily', time: '08:00', dueWorkingDays: 1 },
          // Сдаёт сам администратор: назначение на человека, а не на подразделение
          assignments: [{ kind: 'user', id: userId }],
          review: { enabled: false, reviewers: [] },
        },
      },
    })
    expect(form.ok(), await form.text()).toBeTruthy()
    const formId = (await form.json()).id as string
    const enabled = await request.post(`/api/v1/forms/${formId}/enabled`, {
      headers,
      data: { enabled: true },
    })
    expect(enabled.ok(), await enabled.text()).toBeTruthy()

    await openWorkspace(page, request)
    await openScreen(page, 'Формы сбора')
    await expect(page.getByRole('heading', { name: 'Формы сбора' })).toBeVisible()

    // Список форм: открываем свою строкой таблицы
    await page.getByRole('row', { name: new RegExp(formName) }).click()
    await expect(page.getByRole('tab', { name: new RegExp(formName) })).toBeVisible()

    // Заполнение: период → открыть → значения → сдать
    await page.getByRole('combobox', { name: 'Период' }).click()
    await page.getByRole('option').first().click()
    await page.getByRole('button', { name: 'Открыть период' }).click()
    await page.getByLabel('Людей').fill('7')
    await page.getByRole('button', { name: 'Сдать сводку' }).click()
    await expect(page.getByText('Сводка сдана')).toBeVisible()

    // Контроль сдачи: матрица показывает принятую сводку, ячейка ведёт к отправке
    await page.getByRole('tab', { name: 'Контроль сдачи' }).click()
    await expect(page.getByRole('table', { name: 'Матрица сдачи' })).toBeVisible()
    const cell = page.getByRole('button', { name: /Принята/ })
    await expect(cell).toBeVisible()
    await cell.click()
    await expect(page.getByText('Людей')).toBeVisible()

    // Уборка
    await request.delete(`/api/v1/objects/${formId}`, { headers })
    await request.delete(`/api/v1/objects/${datasetId}`, { headers })
  })

  test('алерт на показатель: тестовый прогон, проверка сейчас и история', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const alertName = `Всплеск обращений ${run}`

    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id

    const dataset = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Обращения ${run}`,
        spaceId,
        fields: [
          { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
          { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        ],
      },
    })
    expect(dataset.ok(), await dataset.text()).toBeTruthy()
    const datasetId = (await dataset.json()).id as string
    const rows = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: {
        rows: ['Хатлон', 'Согд', 'ГБАО'].map((district, index) => ({
          values: { code: `A-${index}`, district },
        })),
      },
    })
    expect(rows.ok(), await rows.text()).toBeTruthy()

    const metricName = `Обращений всего ${run}`
    const metric = await request.post('/api/v1/metrics', {
      headers,
      data: {
        name: metricName,
        spaceId,
        datasetId,
        definition: { measure: { agg: 'count' }, period: null, comparison: 'none' },
      },
    })
    expect(metric.ok(), await metric.text()).toBeTruthy()
    const metricId = (await metric.json()).id as string

    await openWorkspace(page, request)
    await openScreen(page, 'Алерты')
    await expect(page.getByRole('heading', { name: 'Алерты' })).toBeVisible()

    // Конструктор: название, пространство, показатель
    await page.getByRole('button', { name: 'Создать алерт' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Название').fill(alertName)
    await dialog.getByRole('combobox', { name: 'Пространство' }).click()
    await page.getByRole('option').first().click()
    await dialog.getByRole('combobox', { name: 'Показатель' }).click()
    await page.getByRole('option', { name: metricName }).click()
    await dialog.getByRole('button', { name: 'Создать алерт' }).click()
    await expect(page.getByText('Алерт создан')).toBeVisible()
    await expect(page.getByRole('tab', { name: new RegExp(alertName) })).toBeVisible()

    // Порог: три обращения больше двух
    await page.getByRole('spinbutton', { name: 'Порог' }).fill('2')
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Алерт сохранён')).toBeVisible()

    // Тестовый прогон считает, но ничего не рассылает
    await page.getByRole('button', { name: 'Тестовый прогон' }).click()
    await expect(page.getByText('Сработало 1 из 1')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Срабатываний пока не было')).toBeVisible()

    // Проверка сейчас пишет срабатывание в историю
    await page.getByRole('button', { name: 'Проверить сейчас' }).click()
    await expect(page.getByText(/выше порога 2/)).toBeVisible({ timeout: 20_000 })

    // Уборка
    const list = await request.get('/api/v1/alerts?limit=200', { headers })
    const alert = ((await list.json()).items as Array<{ id: string; name: string }>).find(
      (item) => item.name === alertName,
    )
    if (alert) await request.delete(`/api/v1/objects/${alert.id}`, { headers })
    await request.delete(`/api/v1/objects/${metricId}`, { headers })
    await request.delete(`/api/v1/objects/${datasetId}`, { headers })
  })
})
