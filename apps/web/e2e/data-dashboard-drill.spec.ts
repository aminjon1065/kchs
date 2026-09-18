import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Сценарий приёмки фазы 1 №3 (04-verification.md): «Исследование» — фильтр по
 * периоду, разрезы по территории и месяцу, вычисляемая мера; график сохраняется
 * и ставится на дашборд с фильтром «Территория»; щелчок по столбцу — детализация
 * до строк. Датасет — по API: сценарий проверяет аналитику, а не импорт.
 */
test.describe('Данные: дашборд с фильтром «Территория» и детализацией', () => {
  test('исследование → график → дашборд → фильтр по территории → строки столбца', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000)
    await openWorkspace(page, request)
    const run = Date.now().toString(36)
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
        name: `Происшествия ${run}`,
        spaceId: space?.id,
        fields: [
          { key: 'code', label: { ru: 'Номер' }, type: 'identifier' },
          { key: 'occurred_at', label: { ru: 'Дата и время' }, type: 'datetime', semantic: 'time' },
          {
            key: 'territory',
            label: { ru: 'Территория' },
            type: 'territory',
            semantic: 'territory',
          },
          { key: 'damage', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
        ],
        primaryKey: ['code'],
        timeField: 'occurred_at',
        territoryField: 'territory',
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const datasetId = (await created.json()).id as string
    // Территория — кодом справочника; строка 2025 года вне периода фильтра
    const rows = [
      ['2026-01-10T09:00:00+05:00', 'TJ-KT-01', 100],
      ['2026-01-12T10:00:00+05:00', 'TJ-KT-01', 200],
      ['2026-01-20T11:00:00+05:00', 'TJ-KT-01', 300],
      ['2026-02-03T08:00:00+05:00', 'TJ-KT-02', 50],
      ['2026-02-04T08:30:00+05:00', 'TJ-KT-02', 150],
      ['2026-02-10T12:00:00+05:00', 'TJ-SU-01', 1000],
      ['2026-02-11T13:00:00+05:00', 'TJ-SU-01', 3000],
      ['2025-06-01T10:00:00+05:00', 'TJ-KT-01', 9999],
    ]
    const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: {
        rows: rows.map(([at, territory, damage], index) => ({
          values: { code: `D-${run}-${index}`, occurred_at: at, territory, damage },
        })),
      },
    })
    expect(inserted.ok(), await inserted.text()).toBeTruthy()

    // Исследование: период, разрезы «Территория» и «Дата и время» по месяцам
    await page.goto(`/o/${datasetId}`)
    await page.getByRole('button', { name: 'Исследовать' }).click()
    await page.getByRole('button', { name: 'Фильтр', exact: true }).click()
    await page
      .getByRole('list', { name: 'Поле' })
      .getByRole('button', { name: 'Дата и время' })
      .click()
    await page.getByRole('combobox', { name: 'Условие' }).click()
    await page.getByRole('option', { name: 'между' }).click()
    await page.getByLabel('от', { exact: true }).fill('2026-01-01')
    await page.getByLabel('до', { exact: true }).fill('2026-03-31')
    await page.getByRole('button', { name: 'Применить' }).click()

    await page.getByRole('button', { name: 'Добавить разрез' }).click()
    await page.getByRole('combobox', { name: 'Разрезы' }).last().click()
    await page.getByRole('option', { name: 'Территория' }).click()
    await page.getByRole('button', { name: 'Добавить разрез' }).click()
    await page.getByRole('combobox', { name: 'Разрезы' }).last().click()
    await page.getByRole('option', { name: 'Дата и время' }).click()
    await page.getByRole('combobox', { name: 'Интервал' }).click()
    await page.getByRole('option', { name: 'Месяц' }).click()

    // Вычисляемая мера: средний ущерб на происшествие
    await page.getByRole('combobox', { name: 'Меры' }).first().click()
    await page.getByRole('option', { name: 'Формула' }).click()
    const formula = page.getByRole('textbox', { name: 'Формула меры' })
    await formula.fill('sum(damage) / count()')
    await formula.press('Enter')

    // Три группы в периоде: Бохтар (январь), Куляб и Худжанд (февраль); подписи — названия
    await page.getByRole('radio', { name: 'Таблица' }).click()
    const result = page.getByRole('grid')
    await expect(result.getByRole('gridcell', { name: 'Худжанд' })).toBeVisible({ timeout: 20_000 })
    await expect(result.getByRole('gridcell', { name: /^2\s?000$/ })).toBeVisible()
    await expect(page.getByText(/3 строки ·/)).toBeVisible()

    // График столбцами → сохранить → на новый дашборд
    await page.getByRole('radio', { name: 'График' }).click()
    await page.getByRole('combobox', { name: 'Вид графика' }).click()
    await page.getByRole('option', { name: 'Столбцы' }).click()
    const chartName = `Средний ущерб ${run}`
    await page.getByRole('button', { name: 'Сохранить как график' }).click()
    await page.getByRole('textbox', { name: 'Название' }).fill(chartName)
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить как график' }).click()
    await expect(page.getByRole('tab', { name: new RegExp(chartName) })).toBeVisible()
    const dashboardName = `Обстановка по территориям ${run}`
    await page.getByRole('button', { name: 'На дашборд' }).click()
    await page.getByRole('textbox', { name: 'Название' }).fill(dashboardName)
    await page.getByRole('dialog').getByRole('button', { name: 'На дашборд' }).click()
    await expect(page.getByRole('tab', { name: new RegExp(dashboardName) })).toBeVisible()

    // Фильтр «Территория» с привязкой к полю плитки
    await page.getByRole('button', { name: 'Изменить' }).click()
    await page.getByRole('button', { name: 'Фильтр', exact: true }).click()
    const filterDialog = page.getByRole('dialog')
    await filterDialog.getByRole('textbox', { name: 'Подпись' }).fill('Территория')
    await filterDialog.getByRole('radio', { name: 'Территория' }).click()
    await filterDialog.getByRole('button', { name: 'Создать' }).click()
    await page.getByRole('button', { name: 'Фильтры плитки' }).click()
    await page.getByRole('combobox', { name: /Поле для фильтра/ }).click()
    await page.getByRole('option', { name: 'Территория' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Сохранить' }).click()
    await page.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Дашборд сохранён')).toBeVisible()

    // Согдийская область: остаётся один столбец — Худжанд в феврале
    await page.getByRole('button', { name: 'Территория', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Найти территорию' }).fill('Согд')
    await page
      .getByRole('list', { name: 'Найденные территории' })
      .getByRole('button', { name: /^Согдийская область/ })
      .click()
    await page.getByRole('button', { name: 'Таблица данных' }).click()
    await expect(page.getByRole('rowheader', { name: 'Худжанд', exact: true })).toBeVisible()
    await expect(page.getByRole('rowheader', { name: 'Бохтар', exact: true })).toHaveCount(0)
    await expect(page.getByRole('cell', { name: /^2\s?000$/ })).toBeVisible()
    await page.getByRole('button', { name: 'График', exact: true }).click()

    // Детализация: щелчок по столбцу — строки источника под фильтром и периодом
    const canvas = page.locator('canvas').first()
    await expect(canvas).toBeVisible()
    const box = await canvas.boundingBox()
    if (!box) throw new Error('нет холста графика')
    // Столбец один и узкий: ведём щелчком по нижней части области графика до попадания
    const drill = page.getByRole('dialog')
    for (let x = box.x + box.width * 0.25; x < box.x + box.width * 0.85; x += 5) {
      await page.mouse.click(x, box.y + box.height * 0.75)
      if (await drill.isVisible()) break
    }
    await expect(drill.getByText('2 строки').first()).toBeVisible({ timeout: 20_000 })
    await expect(drill.getByRole('gridcell', { name: `D-${run}-5` })).toBeVisible()
    await expect(drill.getByRole('gridcell', { name: `D-${run}-6` })).toBeVisible()
  })
})
