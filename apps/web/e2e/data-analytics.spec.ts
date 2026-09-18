import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Исследование → график → дашборд с фильтром (сценарий приёмки фазы 1 №3 в
 * малом): разрез по району, сохранение графика, плитка на новом дашборде,
 * фильтр «Район» с привязкой к полю плитки сужает её данные.
 */
test.describe('Данные: исследование, график, дашборд', () => {
  test('график из исследования на дашборде с фильтром', async ({ page, request }) => {
    test.setTimeout(120_000)
    await openWorkspace(page, request)
    const run = Date.now().toString(36)

    // Датасет с данными — по API: сценарий проверяет аналитику, а не импорт
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const space = spaces.find((item) => item.kind === 'team') ?? spaces[0]
    const created = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Сводка ${run}`,
        spaceId: space?.id,
        fields: [
          { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
          { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        ],
        primaryKey: ['code'],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const datasetId = (await created.json()).id as string
    const rows = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: {
        rows: ['Хатлон', 'Хатлон', 'Согд', 'ГБАО'].map((district, index) => ({
          values: { code: `K-${index}`, district },
        })),
      },
    })
    expect(rows.ok(), await rows.text()).toBeTruthy()

    // Исследование: количество по районам
    await page.goto(`/o/${datasetId}`)
    await page.getByRole('button', { name: 'Исследовать' }).click()
    await page.getByRole('button', { name: 'Добавить разрез' }).click()
    await page.getByRole('combobox', { name: 'Разрезы' }).click()
    await page.getByRole('option', { name: 'Район' }).click()
    await expect(page.getByText(/3 строки ·/)).toBeVisible({ timeout: 20_000 })

    const chartName = `По районам ${run}`
    await page.getByRole('button', { name: 'Сохранить как график' }).click()
    await page.getByRole('textbox', { name: 'Название' }).fill(chartName)
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить как график' }).click()
    await expect(page.getByRole('tab', { name: new RegExp(chartName) })).toBeVisible()

    // На новый дашборд
    const dashboardName = `Обстановка ${run}`
    await page.getByRole('button', { name: 'На дашборд' }).click()
    await page.getByRole('textbox', { name: 'Название' }).fill(dashboardName)
    await page.getByRole('dialog').getByRole('button', { name: 'На дашборд' }).click()
    await expect(page.getByRole('tab', { name: new RegExp(dashboardName) })).toBeVisible()

    // Фильтр «Район», привязанный к полю плитки
    await page.getByRole('button', { name: 'Изменить' }).click()
    await page.getByRole('button', { name: 'Фильтр', exact: true }).click()
    await page.getByRole('textbox', { name: 'Подпись' }).fill('Район')
    await page.getByRole('dialog').getByRole('button', { name: 'Создать' }).click()
    await page.getByRole('button', { name: 'Фильтры плитки' }).click()
    await page.getByRole('combobox', { name: /Поле для фильтра/ }).click()
    await page.getByRole('option', { name: 'Район' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click()
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Дашборд сохранён')).toBeVisible()

    await page.getByRole('textbox', { name: 'Район' }).fill('Согд')
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: 'Таблица данных' }).click()
    // Таблица данных плитки: первый столбец — заголовки строк
    await expect(page.getByRole('rowheader', { name: 'Согд', exact: true })).toBeVisible()
    await expect(page.getByRole('rowheader', { name: 'Хатлон', exact: true })).toHaveCount(0)
    // Подпись меры — из исследования, а не имя столбца
    await expect(page.getByRole('columnheader', { name: 'Количество' })).toBeVisible()
  })
})
