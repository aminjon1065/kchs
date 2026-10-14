import { expect, openWorkspace, test } from './fixtures.js'

/**
 * «Исследование» для аналитика (ADR-0217): открывается обзором датасета, готовый
 * вопрос «год к предыдущему» строит сравнение периодов по категории, элемент
 * таблицы детализируется до строк и фильтра, результат уходит ячейкой в тетрадь;
 * территория — уровнем справочника, точки — на карте, результат — датасетом и показателем.
 */
test.describe('Данные: исследование для аналитика', () => {
  test('обзор → вопрос → сравнение периодов → детализация → в тетрадь', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    await openWorkspace(page, request)
    const run = Date.now().toString(36)

    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const space = spaces.find((item) => item.kind === 'team') ?? spaces[0]
    const name = `Происшествия ${run}`
    const created = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name,
        spaceId: space?.id,
        fields: [
          { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
          { key: 'kind', label: { ru: 'Вид ЧС' }, type: 'text', semantic: 'category' },
          { key: 'occurred_on', label: { ru: 'Дата' }, type: 'date' },
          { key: 'victims', label: { ru: 'Пострадавшие' }, type: 'integer' },
        ],
        primaryKey: ['code'],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const datasetId = (await created.json()).id as string
    // 2025 год: пожаров 3, паводок 1; 2024 год: пожар 1, паводков 2. Данные кончаются 31.12.2025
    const data: Array<[string, string, number]> = [
      ['Пожар', '2025-03-10', 1],
      ['Пожар', '2025-07-01', 2],
      ['Пожар', '2025-12-31', 0],
      ['Паводок', '2025-04-15', 4],
      ['Пожар', '2024-05-05', 0],
      ['Паводок', '2024-04-01', 1],
      ['Паводок', '2024-04-20', 1],
    ]
    const rows = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: {
        rows: data.map(([kind, occurred_on, victims], index) => ({
          values: { code: `E-${index}`, kind, occurred_on, victims },
        })),
      },
    })
    expect(rows.ok(), await rows.text()).toBeTruthy()

    // Обзор вместо одинокого числа: объём, готовые вопросы, поля
    await page.goto(`/o/${datasetId}`)
    await page.getByRole('button', { name: 'Исследовать' }).click()
    await expect(page.getByRole('heading', { name: 'Обзор датасета' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'С чего начать' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Исследовать «Вид ЧС»' })).toBeVisible()

    // Готовый вопрос: 2025 год к 2024-му по виду ЧС — таблицей с периодами
    await page.getByRole('button', { name: 'Год 2025 к предыдущему по «Вид ЧС»' }).click()
    await expect(page.getByText(/Текущий период: 01\.01\.2025/)).toBeVisible({ timeout: 20_000 })
    const grid = page.getByRole('grid')
    await expect(grid.getByRole('columnheader', { name: 'Количество · текущий' })).toBeVisible()
    await expect(grid.getByRole('columnheader', { name: 'Количество · изменение' })).toBeVisible()
    await expect(grid.getByRole('gridcell', { name: 'Пожар', exact: true })).toBeVisible()
    // Итоги — отдельной строкой: всего 4 события в 2025 году против 3 в 2024-м
    await expect(page.getByRole('region', { name: 'Итого' })).toContainText('4')

    // Детализация: строка «Пожар» → строки за ней → оставить только пожары
    await grid.getByRole('gridcell', { name: 'Пожар', exact: true }).dblclick()
    await expect(page.getByRole('region', { name: 'Выбрано: Пожар' })).toBeVisible()
    await page.getByRole('button', { name: 'Показать строки' }).click()
    await expect(page.getByRole('region', { name: 'Строки: Пожар' })).toContainText(
      'Первые 4 строки',
    )
    await page.getByRole('button', { name: 'Оставить только это' }).click()
    await expect(page.getByText(/^1 строка ·/)).toBeVisible({ timeout: 20_000 })

    // В тетрадь: новая тетрадь с ячейкой-запросом открывается вкладкой
    await page.getByRole('button', { name: 'Ещё действия' }).click()
    await page.getByRole('menuitem', { name: 'В тетрадь…' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить' }).click()
    await expect(page.getByText('Запрос добавлен в тетрадь')).toBeVisible()
    await expect(page.getByRole('tab', { name: new RegExp(name) }).last()).toBeVisible()
  })

  /**
   * Следующие шаги ADR-0217 («Дополнено»): территория уровнем справочника и спуск
   * на уровень ниже, точки на карте с кластерами, исследование датасетом через
   * пайплайн и показателем.
   */
  test('область → уровнем ниже → точки на карте → датасетом и показателем', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    await openWorkspace(page, request)
    const run = Date.now().toString(36)

    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const space = spaces.find((item) => item.kind === 'team') ?? spaces[0]
    const territories = (await (await request.get('/api/v1/territories')).json()).items as Array<{
      id: string
      code: string
      parentId: string | null
      level: string
      name: { ru: string }
      centroid: { lon: number; lat: number } | null
    }>
    const region = territories.find((item) => item.code === 'TJ-KT')
    const districts = territories
      .filter((item) => item.parentId === region?.id && item.level === 'district' && item.centroid)
      .slice(0, 3)
    expect(region && districts.length === 3).toBeTruthy()

    const name = `Подтопления ${run}`
    const created = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name,
        spaceId: space?.id,
        territoryField: 'territory',
        fields: [
          { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
          { key: 'territory', label: { ru: 'Территория' }, type: 'territory' },
          { key: 'place', label: { ru: 'Место' }, type: 'geometry', geometryType: 'point' },
          { key: 'victims', label: { ru: 'Пострадавшие' }, type: 'integer' },
        ],
        primaryKey: ['code'],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const datasetId = (await created.json()).id as string
    // По одному, два и три события в трёх районах Хатлона — точками в их центрах
    const rows = districts.flatMap((district, index) =>
      Array.from({ length: index + 1 }, (_, n) => ({
        values: {
          code: `F-${index}-${n}`,
          territory: district.id,
          place: { type: 'Point', coordinates: [district.centroid?.lon, district.centroid?.lat] },
          victims: n,
        },
      })),
    )
    const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: { rows },
    })
    expect(inserted.ok(), await inserted.text()).toBeTruthy()

    // Готовый вопрос по территории — и разрез уровнем «Область»
    await page.goto(`/o/${datasetId}`)
    await page.getByRole('button', { name: 'Исследовать' }).click()
    await page.getByRole('button', { name: 'Где больше всего: по «Территория»' }).click()
    await page.getByRole('combobox', { name: 'Уровень территории' }).click()
    await page.getByRole('option', { name: 'Область' }).click()
    await page.getByRole('radio', { name: 'Таблица' }).click()
    const grid = page.getByRole('grid')
    await expect(grid.getByRole('columnheader', { name: 'Территория · Область' })).toBeVisible({
      timeout: 20_000,
    })
    const regionName = region?.name.ru as string
    await expect(grid.getByRole('gridcell', { name: regionName, exact: true })).toBeVisible()

    // Уровнем ниже: область раскрывается районами
    await grid.getByRole('gridcell', { name: regionName, exact: true }).dblclick()
    await page.getByRole('button', { name: 'Уровнем ниже: Районы' }).click()
    await expect(grid.getByRole('columnheader', { name: 'Территория · Район' })).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText(/^3 строки ·/)).toBeVisible()
    await expect(
      grid.getByRole('gridcell', { name: districts[2]?.name.ru as string, exact: true }),
    ).toBeVisible()

    // Карта: точки с кластерами
    await page.getByRole('radio', { name: 'Карта' }).click()
    await page.getByRole('radio', { name: 'Точки' }).click()
    await expect(page.getByRole('region', { name: 'Точки на карте' })).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText('6 точек, близкие собраны в кластеры')).toBeVisible()

    // Датасетом: пайплайн из шагов исследования запускается и открывается вкладкой
    await page.getByRole('button', { name: 'Ещё действия' }).click()
    await page.getByRole('menuitem', { name: 'Как датасет…' }).click()
    const datasetDialog = page.getByRole('dialog', { name: 'Сохранить как датасет' })
    await datasetDialog.getByRole('textbox', { name: 'Название' }).fill(`${name} по районам`)
    await datasetDialog.getByRole('button', { name: 'Создать' }).click()
    await expect(page.getByText('Пайплайн создан и запущен')).toBeVisible()
    await expect(page.getByRole('tab', { name: `${name} по районам` })).toBeVisible()

    // Показателем: количество событий с условиями исследования
    await page.getByRole('tab', { name: `${name} — Исследование` }).click()
    await page.getByRole('button', { name: 'Ещё действия' }).click()
    await page.getByRole('menuitem', { name: 'Как показатель…' }).click()
    const metricDialog = page.getByRole('dialog', { name: 'Сохранить как показатель' })
    await metricDialog.getByRole('button', { name: 'Создать' }).click()
    await expect(page.getByText('Показатель создан')).toBeVisible()
  })
})
