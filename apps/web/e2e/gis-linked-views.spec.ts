import type { APIRequestContext, Page } from '@playwright/test'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Сценарий приёмки фазы 2 № 2 (04-verification.md §3, ADR-0073): таблица и карта
 * рядом связаны — выделение строк подсвечивает объекты, фильтр по охвату карты
 * сужает таблицу, кисть на графике фильтрует карту. Данные — по API: восемь
 * происшествий в разных городах и месяцах, слой, карта и столбчатый график по
 * месяцам. Разделённые панели связываются сами (группа «синяя»).
 */

interface Fixture {
  datasetId: string
  mapId: string
  chartId: string
  layerName: string
  mapName: string
}

const INCIDENTS: Array<[string, string, number, number]> = [
  ['Вокзал', '2026-01-10', 68.78, 38.56],
  ['Цирк', '2026-02-12', 68.8, 38.58],
  ['Гиссар', '2026-03-15', 68.66, 38.52],
  ['Вахдат', '2026-04-05', 69.02, 38.55],
  ['Бохтар', '2026-05-20', 68.78, 37.83],
  ['Куляб', '2026-06-02', 69.78, 37.91],
  ['Худжанд', '2026-06-18', 69.62, 40.28],
  ['Исфара', '2026-01-25', 70.62, 40.13],
]

async function prepare(request: APIRequestContext, run: string): Promise<Fixture> {
  const me = await request.get('/api/v1/me')
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
  const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
    id: string
    kind: string
  }>
  const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id
  const post = async (url: string, data: unknown) => {
    const response = await request.post(url, { headers, data })
    expect(response.ok(), await response.text()).toBeTruthy()
    return (await response.json()) as { id: string }
  }
  const dataset = await post('/api/v1/datasets', {
    name: `Происшествия ${run}`,
    spaceId,
    fields: [
      { key: 'name', label: { ru: 'Название' }, type: 'text' },
      { key: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
      { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
    ],
  })
  await post(`/api/v1/datasets/${dataset.id}/rows`, {
    rows: INCIDENTS.map(([name, day, lon, lat]) => ({
      values: { name, day, place: { type: 'Point', coordinates: [lon, lat] } },
    })),
  })
  const layerName = `Происшествия ${run}`
  const layer = await post('/api/v1/gis/layers', {
    name: layerName,
    spaceId,
    datasetId: dataset.id,
  })
  const mapName = `Карта ${run}`
  const map = await post('/api/v1/gis/maps', {
    name: mapName,
    spaceId,
    spec: {
      camera: { center: [69.4, 38.8], zoom: 6 },
      layers: [{ layerId: layer.id, visible: true, opacity: 1 }],
    },
  })
  const chart = await post('/api/v1/charts', {
    name: `По месяцам ${run}`,
    spaceId,
    spec: {
      version: 1,
      type: 'bar',
      data: {
        query: {
          version: 1,
          source: { kind: 'dataset', id: dataset.id },
          steps: [
            {
              type: 'aggregate',
              groupBy: [{ field: 'day', bucket: 'month' }],
              measures: [{ agg: 'count', alias: 'n' }],
            },
            { type: 'sort', by: [{ field: 'day_month', dir: 'asc' }] },
          ],
        },
      },
      encoding: {
        x: { field: 'day_month', type: 'ordinal' },
        y: [{ field: 'n', type: 'quantitative' }],
      },
    },
  })
  return { datasetId: dataset.id, mapId: map.id, chartId: chart.id, layerName, mapName }
}

/** Вкладка по адресу — в фокусной панели; состояние панелей досылается до перехода. */
async function openInFocusedPane(page: Page, objectId: string): Promise<void> {
  await page.waitForTimeout(3000)
  await page.goto(`/o/${objectId}`)
  await expect(page.getByRole('tablist', { name: 'Вкладки' })).toHaveCount(2, { timeout: 20_000 })
}

async function openAttributes(page: Page, layerName: string): Promise<void> {
  await page.getByRole('button', { name: `Действия со слоем «${layerName}»` }).click()
  await page.getByRole('menuitem', { name: 'Атрибуты' }).click()
  await expect(page.getByRole('region', { name: `Атрибуты: ${layerName}` })).toBeVisible()
}

test.describe('GIS: связанные представления', () => {
  test('таблица и карта рядом: выделение, охват карты, кисть графика', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const fx = await prepare(request, run)
    await openWorkspace(page, request)

    // Карта, затем разделение: карта уходит в новую панель — связанную (синяя группа)
    await page.goto(`/o/${fx.mapId}`)
    await expect(page.getByRole('region', { name: fx.mapName })).toBeVisible({ timeout: 20_000 })
    // Место под две панели: навигатор и контекстная панель свёрнуты
    await page.keyboard.press('Meta+b')
    await page.keyboard.press('Meta+.')
    await page.getByRole('button', { name: 'Открыть в разделении' }).click()
    const tabBars = page.getByRole('tablist', { name: 'Вкладки' })
    await expect(tabBars).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Связь панели: группа «синяя»' })).toHaveCount(2)

    // В левой панели — таблица датасета
    await tabBars.first().click()
    await openInFocusedPane(page, fx.datasetId)
    const grid = page.getByRole('grid', { name: `Происшествия ${run}`, exact: true })
    await expect(grid.getByRole('gridcell', { name: 'Вокзал' })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('region', { name: fx.mapName })).toBeVisible({ timeout: 20_000 })
    await openAttributes(page, fx.layerName)
    const attributes = page.getByRole('region', { name: `Атрибуты: ${fx.layerName}` })
    await expect(attributes.getByText('8 объектов')).toBeVisible()

    // 1. Выделение строки в таблице датасета → объект выделен на карте (и в её таблице)
    await grid.getByRole('gridcell', { name: 'Вокзал' }).click()
    const row = attributes.getByRole('row', { name: /Вокзал/ })
    await expect(row.getByRole('checkbox')).toBeChecked()
    await expect(attributes.getByText(/выделено 1/)).toBeVisible()

    // Выделение на карте (строка её таблицы) → таблица датасета предлагает «только выделенные»
    await attributes
      .getByRole('row', { name: /Худжанд/ })
      .getByRole('checkbox')
      .check()
    await expect(page.getByText('Только выделенные в связанной панели (2)')).toBeVisible()

    // 2. Фильтр по охвату карты: карта переходит к Душанбе, таблица датасета сужается
    const searchButton = page.getByRole('button', { name: 'Поиск на карте' })
    if (await searchButton.isVisible()) await searchButton.click()
    await page.getByRole('combobox', { name: 'Поиск на карте' }).fill('38.56, 68.78')
    await expect(
      page.getByRole('option', { name: /38\.56000° с\. ш\., 68\.78000° в\. д\./ }),
    ).toBeVisible()
    await page.keyboard.press('Enter')
    const inExtent = page.getByRole('switch', { name: 'В охвате карты' }).first()
    await expect(inExtent).toBeVisible({ timeout: 10_000 })
    await inExtent.click()
    await expect(grid.getByRole('gridcell', { name: 'Худжанд' })).toHaveCount(0, {
      timeout: 10_000,
    })
    await expect(grid.getByRole('gridcell', { name: 'Вокзал' })).toBeVisible()
    await page.screenshot({ path: 'test-results/gis-linked-extent.png' })

    // 3. Кисть графика: левая панель — график по месяцам, выделение января–февраля
    await tabBars.first().click()
    await openInFocusedPane(page, fx.chartId)
    await expect(page.getByText('Выделите диапазон кистью')).toBeVisible({ timeout: 20_000 })
    const mapPane = page.getByRole('region', { name: fx.mapName })
    await expect(mapPane).toBeVisible({ timeout: 20_000 })
    await openAttributes(page, fx.layerName)
    await expect(attributes.getByText('8 объектов')).toBeVisible({ timeout: 10_000 })

    const tiles = page.waitForRequest(
      (req) => /\/gis\/layers\/[^/]+\/tiles\//.test(req.url()) && req.url().includes('f='),
    )
    // Холст ECharts — внутри области графика (role="img" с описанием)
    const chart = page
      .locator('[role="img"]')
      .filter({ has: page.locator('canvas') })
      .first()
    await expect(chart).toBeVisible()
    await page.waitForTimeout(800)
    const box = await chart.boundingBox()
    if (!box) throw new Error('нет графика')
    // Первые месяцы из шести: левая треть области построения
    const y = box.y + box.height * 0.5
    await page.mouse.move(box.x + box.width * 0.1, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.35, y, { steps: 12 })
    await page.mouse.up()

    await expect(
      page.getByText(/Фильтр из связанной панели — Дата: 01\.01\.2026/).first(),
    ).toBeVisible({ timeout: 10_000 })
    await tiles
    await expect(attributes.getByText(/^[34] объекта/)).toBeVisible({ timeout: 10_000 })
    await expect(attributes.getByRole('row', { name: /Куляб/ })).toHaveCount(0)
    await page.screenshot({ path: 'test-results/gis-linked-brush.png' })

    // Снять фильтр с карты — таблица атрибутов снова полная
    await page.getByRole('button', { name: 'Снять фильтр связанной панели' }).click()
    await expect(attributes.getByText('8 объектов')).toBeVisible({ timeout: 10_000 })
  })
})
