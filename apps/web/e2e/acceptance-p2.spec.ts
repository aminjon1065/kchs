import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Приёмка фазы 2 (04-verification.md §3) — сценарии, которых нет в
 * спецификациях эпиков. Остальные сценарии фазы проверяют:
 * - №2 (таблица и карта рядом, охват, кисть графика) — gis-linked-views.spec.ts;
 * - №3 (правка, история, откат, модерация) — gis-editing.spec.ts;
 * - №4 (хороплет «на 1 000 жителей» мастером) — gis-choropleth.spec.ts;
 * - №5 (паспорт территории) — gis-passport.spec.ts;
 * - №7 (тайлы под политикой строк) — gis-tiles-policy.spec.ts.
 */

const FILES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'files')

/** ПВР фикстуры `pvr-utm42.zip`: Shapefile в Windows-1251, EPSG:32642, без .cpg. */
const PVR = [
  ['ПВР «Школа № 5»', 'Школа'],
  ['ПВР «Школа № 12»', 'Школа'],
  ['Спортзал «Динамо»', 'Спортзал'],
  ['Спортзал «Вахдат»', 'Спортзал'],
  ['Палаточный лагерь «Гиссар»', 'Палаточный лагерь'],
  ['Палаточный лагерь «Рудаки»', 'Палаточный лагерь'],
] as const
const KINDS = ['Школа', 'Спортзал', 'Палаточный лагерь']

test.describe('Приёмка фазы 2', () => {
  test('№1: Shapefile (cp1251, EPSG:32642) → слой → стиль по категориям, подписи, легенда → карта → плитка дашборда', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000)
    await openWorkspace(page, request)
    const run = Date.now().toString(36)
    const name = `ПВР ${run}`

    // Импорт: архив Shapefile — формат, система координат из .prj, кодировка DBF
    await page.getByRole('button', { name: 'Данные' }).first().click()
    await page.getByRole('button', { name: 'Загрузить файл' }).click()
    const wizard = page.getByRole('dialog', { name: 'Импорт данных' })
    await wizard.locator('input[type="file"]').setInputFiles(path.join(FILES, 'pvr-utm42.zip'))
    await expect(wizard.getByText('SHP', { exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(wizard.getByRole('combobox', { name: 'Система координат' })).toContainText(
      'EPSG:32642',
    )
    await expect(wizard.getByText('Система координат · из файла')).toBeVisible()
    await expect(wizard.getByRole('combobox', { name: 'Кодировка' })).toContainText('1251')
    // Надписи DBF прочитаны в Windows-1251: кириллица и кавычки-ёлочки на месте
    await expect(wizard.getByRole('cell', { name: 'ПВР «Школа № 5»' })).toBeVisible()
    await wizard.getByRole('button', { name: 'Далее' }).click()

    await wizard.getByRole('textbox', { name: 'Название датасета' }).fill(name)
    await wizard.getByRole('button', { name: 'Далее' }).click()
    await wizard.getByRole('button', { name: 'Запустить импорт' }).click()
    await expect(wizard.getByText('Импорт завершён')).toBeVisible({ timeout: 90_000 })
    await expect(wizard.getByText(/Добавлено 6/)).toBeVisible()
    await wizard.getByRole('button', { name: 'Открыть датасет' }).click()
    await expect(page.getByRole('grid', { name })).toBeVisible()

    // Слой датасета: «На карте» — новый слой со стилем по умолчанию
    await page.getByRole('button', { name: 'На карте', exact: true }).click()
    await expect(page.getByRole('tab', { name: new RegExp(name) })).toHaveCount(2)
    const layerMap = page.getByRole('region', { name, exact: true })
    await expect(layerMap).toBeVisible({ timeout: 20_000 })
    const layers = (await (await request.get('/api/v1/objects?types=layer&limit=100')).json())
      .items as Array<{ id: string; title: string }>
    const layerId = layers.find((item) => item.title === name)?.id
    expect(layerId).toBeTruthy()

    // Координаты пересчитаны из UTM 42N в градусы: охват всех 6 ПВР — Душанбе и окрестности
    const record = await (await request.get(`/api/v1/gis/layers/${layerId}`)).json()
    expect(record.featureCount).toBe(6)
    const [west, south, east, north] = record.extent as [number, number, number, number]
    expect(west).toBeGreaterThan(68.6)
    expect(east).toBeLessThan(69)
    expect(south).toBeGreaterThan(38.4)
    expect(north).toBeLessThan(38.7)

    // Стиль: по категориям поля kind, подписи по названию
    await page.getByRole('button', { name: 'Стиль', exact: true }).click()
    const panel = page.getByRole('region', { name: `Стиль слоя «${name}»` })
    await expect(panel).toBeVisible()
    await panel.getByRole('combobox', { name: 'Способ' }).click()
    await page.getByRole('option', { name: 'По категориям' }).click()
    await panel.getByRole('combobox', { name: 'Поле' }).click()
    await page.getByRole('option', { name: 'kind', exact: true }).click()
    const categories = panel.getByRole('list', { name: 'Категории' })
    await expect(categories.getByRole('listitem')).toHaveCount(3)
    await panel.getByRole('button', { name: 'Подписи', exact: true }).click()
    await panel.getByRole('switch', { name: 'Показывать подписи' }).click()
    await expect(panel.getByRole('combobox', { name: 'Поле' }).last()).toContainText('name')
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/gis/layers/${layerId}`) &&
        response.request().method() === 'PATCH',
    )
    await panel.getByRole('button', { name: 'Сохранить' }).click()
    expect((await saved).status()).toBe(200)
    await expect(page.getByText('Стиль слоя сохранён')).toBeVisible()
    const styled = await (await request.get(`/api/v1/gis/layers/${layerId}`)).json()
    expect(styled.style.renderer).toMatchObject({ kind: 'categorized', field: 'kind' })
    expect(
      styled.style.renderer.categories.map((item: { value: string }) => item.value).sort(),
    ).toEqual([...KINDS].sort())
    expect(styled.style.label).toMatchObject({ field: 'name' })
    // Объекты слоя в рамке Душанбе — с полями стиля: категория и подпись в Windows-1251 прочитаны
    const features = await (
      await request.get(`/api/v1/gis/layers/${layerId}/features?bbox=68.6,38.4,69,38.7`)
    ).json()
    const found = (
      features.features as Array<{ properties: { name?: string; kind?: string } }>
    ).map((feature) => [feature.properties.name, feature.properties.kind])
    expect(found.sort()).toEqual(PVR.map((row) => [...row]).sort())

    // Легенда слоя — по категориям поля
    const legend = page.getByRole('region', { name: 'kind', exact: true })
    for (const kind of KINDS) await expect(legend.getByText(kind, { exact: true })).toBeVisible()
    await page.screenshot({ path: 'test-results/acceptance-p2-1-layer.png' })

    // Карта: «На новую карту» из слоя, вид — по охвату, сохранение
    await page.getByRole('button', { name: 'На новую карту' }).click()
    await expect(page.getByRole('tab', { name: new RegExp(name) })).toHaveCount(3)
    await expect(page.getByRole('checkbox', { name: `Показывать слой «${name}»` })).toBeChecked({
      timeout: 20_000,
    })
    await page.getByRole('button', { name: 'Показать всё' }).click()
    await page.getByRole('button', { name: 'Сохранить карту' }).click()
    await expect(page.getByText('Карта сохранена')).toBeVisible()
    const maps = (await (await request.get('/api/v1/objects?types=map&limit=100')).json())
      .items as Array<{ id: string; title: string }>
    const mapId = maps.find((item) => item.title === name)?.id
    expect(mapId).toBeTruthy()
    const map = await (await request.get(`/api/v1/gis/maps/${mapId}`)).json()
    expect(map.spec.layers).toEqual([expect.objectContaining({ layerId, visible: true })])
    // Вид карты — у Душанбе, а не вид новой карты по умолчанию
    const [lon, lat] = map.spec.camera.center as [number, number]
    expect(lon).toBeGreaterThan(68.6)
    expect(lon).toBeLessThan(69)
    expect(lat).toBeGreaterThan(38.4)
    expect(lat).toBeLessThan(38.7)

    // Плитка дашборда: «На дашборд» — новый дашборд с этой картой и её легендой
    await page.getByRole('button', { name: 'На дашборд' }).click()
    const add = page.getByRole('dialog', { name: 'Добавить на дашборд' })
    await add.getByLabel('Название').fill(`Дашборд ${name}`)
    await add.getByRole('button', { name: 'На дашборд' }).click()
    await expect(page.getByRole('tab', { name: new RegExp(`Дашборд ${name}`) })).toBeVisible()
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Легенда' }).click()
    for (const kind of KINDS) {
      await expect(page.getByText(kind, { exact: true }).first()).toBeVisible()
    }
    await page.screenshot({ path: 'test-results/acceptance-p2-1-dashboard.png' })
    const dashboards = (
      await (await request.get('/api/v1/objects?types=dashboard&limit=100')).json()
    ).items as Array<{ id: string; title: string }>
    const dashboardId = dashboards.find((item) => item.title === `Дашборд ${name}`)?.id
    const dashboard = await (await request.get(`/api/v1/dashboards/${dashboardId}`)).json()
    expect(dashboard.spec.tiles).toEqual([expect.objectContaining({ kind: 'map', mapId })])
  })
})
