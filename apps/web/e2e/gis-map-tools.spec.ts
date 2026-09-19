import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Инструменты карты-студии (P2-E02 S02–S03, ADR-0073): поиск по координатам,
 * закладки, измерение, идентификация, выделение рамкой и атрибутивная таблица
 * слоя. Карта открыта над двумя близкими точками в Душанбе на 12-м масштабе —
 * без скоплений, точки — в известных местах экрана.
 */

const POINTS: Array<[string, number, number, number]> = [
  ['Вокзал', 10, 68.78, 38.56],
  ['Цирк', 20, 68.8, 38.58],
  ['Гиссар', 30, 68.66, 38.52],
  ['Худжанд', 40, 69.62, 40.28],
]

async function prepare(request: APIRequestContext, run: string) {
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
    name: `Пункты ${run}`,
    spaceId,
    fields: [
      { key: 'name', label: { ru: 'Название' }, type: 'text' },
      { key: 'seats', label: { ru: 'Мест' }, type: 'integer' },
      { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
    ],
  })
  await post(`/api/v1/datasets/${dataset.id}/rows`, {
    rows: POINTS.map(([name, seats, lon, lat]) => ({
      values: { name, seats, place: { type: 'Point', coordinates: [lon, lat] } },
    })),
  })
  const layerName = `Пункты ${run}`
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
      camera: { center: [68.79, 38.57], zoom: 12 },
      layers: [{ layerId: layer.id, visible: true, opacity: 1 }],
    },
  })
  return { mapId: map.id, layerName, mapName }
}

/** Центр карты на экране и точка со смещением от него. */
async function centerOf(map: Locator): Promise<{ x: number; y: number }> {
  const box = await map.boundingBox()
  if (!box) throw new Error('нет карты')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function waitForTiles(page: Page): Promise<void> {
  await page
    .waitForResponse((response) => /\/gis\/layers\/[^/]+\/tiles\//.test(response.url()), {
      timeout: 15_000,
    })
    .catch(() => undefined)
  await page.waitForTimeout(1200)
}

test.describe('GIS: инструменты карты', () => {
  test('поиск, закладки, измерение, идентификация, рамка и атрибуты', async ({ page, request }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const fx = await prepare(request, run)
    await openWorkspace(page, request)
    await page.keyboard.press('Meta+.')
    const tiles = waitForTiles(page)
    await page.goto(`/o/${fx.mapId}`)
    const map = page.getByRole('region', { name: fx.mapName })
    await expect(map).toBeVisible({ timeout: 20_000 })
    await tiles

    // Координаты и масштаб в углу карты
    await expect(page.getByRole('button', { name: /^Координаты: / })).toContainText('1 : ')

    // Поиск по координатам в градусах, минутах, секундах → переход к точке
    const searchButton = page.getByRole('button', { name: 'Поиск на карте' })
    if (await searchButton.isVisible()) await searchButton.click()
    const search = page.getByRole('combobox', { name: 'Поиск на карте' })
    await search.fill(`38°33'36"N 68°46'48"E`)
    await expect(
      page.getByRole('option', { name: /38\.56000° с\. ш\., 68\.78000° в\. д\./ }),
    ).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('button', { name: /^Координаты: / })).toContainText('1 : ')

    // Закладка текущего вида: добавить, уйти, вернуться
    await page.getByRole('button', { name: 'Закладки' }).click()
    await page.getByLabel('Название закладки').fill(`Вокзал ${run}`)
    await page.getByRole('button', { name: 'Добавить', exact: true }).click()
    await expect(
      page.getByRole('button', { name: `Перейти к закладке «Вокзал ${run}»` }),
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Сохранить карту' })).toBeVisible()

    // Измерение расстояния: две точки → расстояние в метрах или километрах
    await page.getByRole('button', { name: 'Измерить расстояние' }).click()
    const center = await centerOf(map)
    await page.mouse.click(center.x - 150, center.y)
    await page.mouse.click(center.x + 150, center.y)
    await expect(page.getByText(/Расстояние: [\d,]+ (м|км)/)).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.getByText('Измерение завершено')).toBeVisible()
    await page.getByRole('button', { name: 'Готово' }).click()

    // Возврат к закладке: вид над двумя точками
    await page.getByRole('button', { name: 'Закладки' }).click()
    await page.getByRole('button', { name: `Перейти к закладке «Вокзал ${run}»` }).click()
    await waitForTiles(page)

    // Идентификация: щелчок по точке «Вокзал» — список объектов и карточка
    await page.getByRole('button', { name: 'Идентификация' }).click()
    const at = await centerOf(map)
    await page.mouse.click(at.x, at.y)
    const identify = page.getByRole('region', { name: 'Объекты в точке' })
    await expect(identify).toBeVisible()
    await identify.getByRole('button', { name: 'Вокзал' }).click()
    await expect(page.getByRole('button', { name: 'Открыть датасет' })).toBeVisible()
    await page.getByRole('button', { name: 'Идентификация' }).click()

    // Рамка: на 12-м масштабе Shift+перетаскивание вокруг центра — обе близкие точки
    await page.getByRole('button', { name: 'Отдалить' }).click()
    await waitForTiles(page)
    const pad = 170
    await page.keyboard.down('Shift')
    await page.mouse.move(at.x - pad, at.y - pad)
    await page.mouse.down()
    await page.mouse.move(at.x + pad, at.y + pad, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await expect(page.getByText('Выделено: 2')).toBeVisible()

    // Атрибутивная таблица: выделенные строки отмечены, «только выделенные», карточка строки
    await page.getByRole('button', { name: `Действия со слоем «${fx.layerName}»` }).click()
    await page.getByRole('menuitem', { name: 'Атрибуты' }).click()
    const attributes = page.getByRole('region', { name: `Атрибуты: ${fx.layerName}` })
    await expect(attributes.getByText('4 объекта · выделено 2')).toBeVisible()
    await expect(attributes.getByRole('row', { name: /Цирк/ }).getByRole('checkbox')).toBeChecked()
    await expect(
      attributes.getByRole('row', { name: /Худжанд/ }).getByRole('checkbox'),
    ).not.toBeChecked()
    await attributes.getByRole('switch', { name: 'Только выделенные' }).click()
    await expect(attributes.getByText('2 объекта · выделено 2')).toBeVisible()
    await attributes.getByRole('switch', { name: 'Только выделенные' }).click()

    // Щелчок по строке — единственное выделение; поиск; двойной щелчок — карточка строки
    await attributes.getByRole('row', { name: /Худжанд/ }).click()
    await expect(page.getByText('Выделено: 1')).toBeVisible()
    await attributes.getByRole('searchbox', { name: 'Поиск по атрибутам' }).fill('худж')
    await expect(attributes.getByText(/^1 объект/)).toBeVisible()
    await attributes.getByRole('button', { name: 'Приблизить к выделенным' }).click()
    await attributes.getByRole('row', { name: /Худжанд/ }).dblclick()
    await expect(page.getByRole('dialog').getByText('Худжанд').first()).toBeVisible()
    await page.screenshot({ path: 'test-results/gis-map-tools.png' })
  })
})
