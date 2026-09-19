import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Редактор стиля слоя (P2-E01 S03, ADR-0075): в карте-студии рендерер слоя
 * меняется на «по категориям» — легенда и тайлы (предпросмотр рабочей копии)
 * меняются сразу, без сохранения; «Сохранить» записывает стиль слоя, после
 * перезагрузки карта рисует сохранённый стиль. Датасет, слой и карта — по API.
 */
test.describe('GIS: редактор стиля слоя', () => {
  test('по категориям → легенда и тайлы → сохранение → повторное открытие', async ({
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
    const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id
    const created = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Объекты стиля ${run}`,
        spaceId,
        fields: [
          { key: 'name', label: { ru: 'Название' }, type: 'text' },
          { key: 'kind', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
          { key: 'capacity', label: { ru: 'Мест' }, type: 'integer', semantic: 'measure' },
          { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
        ],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const datasetId = (await created.json()).id as string
    const kinds = [`школа-${run}`, `больница-${run}`]
    const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: {
        rows: [
          [kinds[0], 120, 68.78, 38.56],
          [kinds[1], 300, 68.8, 38.58],
          [kinds[0], 80, 68.76, 38.55],
        ].map(([kind, capacity, lon, lat], index) => ({
          values: {
            name: `Объект ${index + 1}`,
            kind,
            capacity,
            place: { type: 'Point', coordinates: [lon, lat] },
          },
        })),
      },
    })
    expect(inserted.ok(), await inserted.text()).toBeTruthy()
    const layerName = `Слой стиля ${run}`
    const layer = await request.post('/api/v1/gis/layers', {
      headers,
      data: { name: layerName, spaceId, datasetId },
    })
    expect(layer.ok(), await layer.text()).toBeTruthy()
    const layerId = (await layer.json()).id as string
    const map = await request.post('/api/v1/gis/maps', {
      headers,
      data: {
        name: `Карта стиля ${run}`,
        spaceId,
        spec: { layers: [{ layerId }], camera: { center: [68.78, 38.56], zoom: 13 } },
      },
    })
    expect(map.ok(), await map.text()).toBeTruthy()
    const mapId = (await map.json()).id as string

    // Карта со слоем: тайлы сохранённого стиля — без предпросмотра
    const savedTile = page.waitForResponse(
      (response) =>
        response.url().includes(`/gis/layers/${layerId}/tiles/`) &&
        !response.url().includes('p=') &&
        response.status() === 200,
    )
    await page.goto(`/o/${mapId}`)
    await expect(
      page.getByRole('checkbox', { name: `Показывать слой «${layerName}»` }),
    ).toBeChecked({
      timeout: 20_000,
    })
    await savedTile
    // Легенда простого стиля — один образец с названием слоя
    const layers = page.getByRole('region', { name: 'Слои' })
    await expect(layers.getByRole('region', { name: 'Легенда' }).getByText(layerName)).toBeVisible()

    // Панель стиля из меню слоя
    await page.getByRole('button', { name: `Действия со слоем «${layerName}»` }).click()
    await page.getByRole('menuitem', { name: 'Стиль' }).click()
    const panel = page.getByRole('region', { name: `Стиль слоя «${layerName}»` })
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('combobox', { name: 'Способ' })).toContainText('Один цвет')

    // «По категориям»: поле «Вид» по смыслу, категории — значениями из данных;
    // тайлы — с предпросмотром рабочей копии (в тайле теперь поле «Вид»)
    const previewTile = page.waitForResponse(
      (response) =>
        response.url().includes(`/gis/layers/${layerId}/tiles/`) &&
        response.url().includes('p=') &&
        response.status() === 200,
    )
    await panel.getByRole('combobox', { name: 'Способ' }).click()
    await page.getByRole('option', { name: 'По категориям' }).click()
    await expect(panel.getByRole('combobox', { name: 'Поле' })).toContainText('Вид')
    const categories = panel.getByRole('list', { name: 'Категории' })
    await expect(categories.getByRole('listitem')).toHaveCount(2)
    await previewTile
    // Легенда в панели слоёв — по рабочей копии: заголовок по полю и обе категории
    const categorizedLegend = layers.getByRole('region', { name: 'Вид' })
    await expect(categorizedLegend.getByText(kinds[0] as string)).toBeVisible()
    await expect(categorizedLegend.getByText(kinds[1] as string)).toBeVisible()
    await expect(panel.getByText('Не сохранено')).toBeVisible()
    await page.screenshot({ path: 'test-results/gis-style-editor.png' })

    // Сохранение: стиль слоя на сервере — по категориям
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/gis/layers/${layerId}`) &&
        response.request().method() === 'PATCH',
    )
    await panel.getByRole('button', { name: 'Сохранить' }).click()
    expect((await saved).status()).toBe(200)
    await expect(page.getByText('Стиль слоя сохранён')).toBeVisible()
    await expect(panel.getByText('Не сохранено')).toBeHidden()
    const record = await (await request.get(`/api/v1/gis/layers/${layerId}`)).json()
    expect(record.style.renderer).toMatchObject({ kind: 'categorized', field: 'kind' })
    expect(record.style.renderer.categories.map((item: { value: string }) => item.value)).toEqual(
      expect.arrayContaining(kinds),
    )

    // Повторное открытие: сохранённый стиль — легенда по категориям, тайлы без предпросмотра
    const reopenedTile = page.waitForResponse(
      (response) =>
        response.url().includes(`/gis/layers/${layerId}/tiles/`) &&
        !response.url().includes('p=') &&
        response.status() === 200,
    )
    await page.reload()
    await expect(
      page.getByRole('checkbox', { name: `Показывать слой «${layerName}»` }),
    ).toBeChecked({
      timeout: 20_000,
    })
    await reopenedTile
    const reopenedLegend = page.getByRole('region', { name: 'Слои' }).getByRole('region', {
      name: 'Вид',
    })
    await expect(reopenedLegend.getByText(kinds[0] as string)).toBeVisible()
    await expect(reopenedLegend.getByText(kinds[1] as string)).toBeVisible()
  })
})
