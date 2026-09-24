import { expect, openScreen, openWorkspace, test } from './fixtures.js'

/**
 * Табличная форма сбора (N49, ADR-0129): сводка за период — таблица строк с
 * «Итого»; поле со справочником выбирается по подписи, а не вводится кодом;
 * территория — деревом справочника. Сданные строки видны в матрице контроля
 * числом. Датасеты и форма готовятся по API — сценарий проверяет экраны.
 */
test.describe('Данные: табличная форма сбора', () => {
  test('строки сводки с подписями справочника, итог и сдача', async ({ page, request }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const formName = `Происшествия за сутки ${run}`

    const me = await request.get('/api/v1/me')
    const profile = await me.json()
    const headers = { 'x-csrf-token': profile.session.csrfToken as string }
    const userId = profile.user.id as string
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id

    // Справочник видов: сводка хранит код, заполняющий выбирает подпись
    const kinds = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Виды происшествий ${run}`,
        spaceId,
        kind: 'reference',
        fields: [
          { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
          { key: 'name', label: { ru: 'Название' }, type: 'text' },
        ],
        primaryKey: ['code'],
      },
    })
    expect(kinds.ok(), await kinds.text()).toBeTruthy()
    const kindsId = (await kinds.json()).id as string
    const kindRows = await request.post(`/api/v1/datasets/${kindsId}/rows`, {
      headers,
      data: {
        rows: [
          { values: { code: 'FIRE', name: 'Пожар' } },
          { values: { code: 'ROAD', name: 'Дорожное происшествие' } },
        ],
      },
    })
    expect(kindRows.ok(), await kindRows.text()).toBeTruthy()

    const dataset = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Происшествия ${run}`,
        spaceId,
        fields: [
          { key: 'type_code', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
          { key: 'territory', label: { ru: 'Район' }, type: 'territory', semantic: 'territory' },
          { key: 'injured', label: { ru: 'Пострадавшие' }, type: 'integer', semantic: 'measure' },
          { key: 'period', label: { ru: 'Сутки' }, type: 'date', semantic: 'time' },
        ],
      },
    })
    expect(dataset.ok(), await dataset.text()).toBeTruthy()
    const datasetId = (await dataset.json()).id as string
    const lookup = await request.patch(`/api/v1/datasets/${datasetId}/fields/type_code`, {
      headers,
      data: { lookup: { datasetId: kindsId, keyField: 'code', labelField: 'name' } },
    })
    expect(lookup.ok(), await lookup.text()).toBeTruthy()

    const form = await request.post('/api/v1/forms', {
      headers,
      data: {
        name: formName,
        spaceId,
        definition: {
          datasetId,
          layout: 'table',
          fields: [
            { key: 'type_code', required: true },
            { key: 'territory', required: false },
            { key: 'injured', required: false },
          ],
          auto: { period: 'period' },
          schedule: { periodicity: 'daily', time: '08:00', dueMode: 'calendar', dueWorkingDays: 1 },
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
    await page.getByRole('row', { name: new RegExp(formName) }).click()
    await expect(page.getByRole('tab', { name: new RegExp(formName) })).toBeVisible()

    await page.getByRole('combobox', { name: 'Период' }).click()
    await page.getByRole('option').first().click()
    await page.getByRole('button', { name: 'Открыть период' }).click()
    // Пустая таблица: главная кнопка — сдача без записей
    await expect(page.getByRole('button', { name: 'Записей не было — сдать' })).toBeVisible()

    const table = page.getByRole('table', { name: 'Строки сводки' })
    await page.getByRole('button', { name: 'Добавить строку' }).click()
    await page.getByRole('button', { name: 'Добавить строку' }).click()

    // Вид — выбором подписи из справочника, а не кодом
    await table.getByRole('button', { name: 'Вид, строка 1' }).click()
    await page.getByRole('button', { name: 'Пожар' }).click()
    await expect(table.getByRole('button', { name: 'Вид, строка 1' })).toHaveText('Пожар')
    await table.getByRole('button', { name: 'Вид, строка 2' }).click()
    await page.getByRole('button', { name: 'Дорожное происшествие' }).click()
    // Территория — деревом справочника, не текстовым полем
    await expect(table.getByRole('button', { name: 'Район, строка 1' })).toBeVisible()

    await table.getByLabel('Пострадавшие, строка 1').fill('2')
    await table.getByLabel('Пострадавшие, строка 2').fill('1')
    await expect(table.getByRole('row', { name: /Итого/ })).toContainText('3')

    await page.getByRole('button', { name: 'Сдать сводку' }).click()
    await expect(page.getByText('Сводка сдана')).toBeVisible()

    // Матрица: ячейка с числом сданных строк ведёт к таблице сдачи
    await page.getByRole('tab', { name: 'Контроль сдачи' }).click()
    const cell = page.getByRole('button', { name: /Принята, строк: 2/ })
    await expect(cell).toBeVisible()
    await cell.click()
    await expect(page.getByRole('table', { name: 'Строки сводки' })).toContainText('Пожар')

    await request.delete(`/api/v1/objects/${formId}`, { headers })
    await request.delete(`/api/v1/objects/${datasetId}`, { headers })
    await request.delete(`/api/v1/objects/${kindsId}`, { headers })
  })
})
