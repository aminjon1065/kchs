import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Карта-студия (P2-E02 S01, ADR-0072): карта создаётся на экране «Карты», слой
 * добавляется из датасета с геометрией, тайлы приходят с сервера (MVT), щелчок
 * по объекту открывает карточку, сохранённая карта открывается с тем же слоем.
 * Датасет — по API: одна точка, чтобы «Показать всё» поставило её в центр карты.
 */
test.describe('GIS: карта-студия', () => {
  test('новая карта → слой из датасета → тайлы → карточка объекта → сохранение', async ({
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
    const datasetName = `Школы ${run}`
    const created = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: datasetName,
        spaceId: space?.id,
        fields: [
          { key: 'name', label: { ru: 'Название' }, type: 'text' },
          { key: 'kind', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
          { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
        ],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const datasetId = (await created.json()).id as string
    const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: {
        rows: [
          {
            values: {
              name: `Школа № 1 ${run}`,
              kind: 'school',
              place: { type: 'Point', coordinates: [68.78, 38.56] },
            },
          },
        ],
      },
    })
    expect(inserted.ok(), await inserted.text()).toBeTruthy()

    // Экран «Карты» → новая карта
    await page.getByRole('button', { name: 'Карты', exact: true }).click()
    await page.getByRole('button', { name: 'Создать карту' }).click()
    const dialog = page.getByRole('dialog', { name: 'Новая карта' })
    await dialog.getByLabel('Название карты').fill(`Карта ${run}`)
    await dialog.getByRole('button', { name: 'Создать' }).click()
    await expect(page.getByRole('tab', { name: new RegExp(`Карта ${run}`) })).toBeVisible()
    await expect(page.getByText('На карте нет слоёв')).toBeVisible()

    // Слой из датасета — со стилем по умолчанию
    await page.getByRole('button', { name: 'Добавить слой' }).first().click()
    const add = page.getByRole('dialog', { name: 'Добавить слой на карту' })
    await add.getByLabel('Найти датасет').fill(datasetName)
    await add.getByRole('button', { name: datasetName }).click()
    await expect(add.getByText(`Новый слой «${datasetName}» со стилем по умолчанию`)).toBeVisible()
    const tile = page.waitForResponse(
      (response) =>
        /\/gis\/layers\/[^/]+\/tiles\//.test(response.url()) && response.status() === 200,
    )
    await add.getByRole('button', { name: 'Добавить слой' }).click()
    await expect(add).toBeHidden()
    await expect(
      page.getByRole('checkbox', { name: `Показывать слой «${datasetName}»` }),
    ).toBeChecked()
    // Тайл MVT со строкой пришёл с сервера (пустые — 204)
    const response = await tile
    expect(response.headers()['content-type']).toContain('application/vnd.mapbox-vector-tile')

    // «Показать всё» ставит единственную точку в центр; щелчок — карточка объекта
    await page.getByRole('button', { name: 'Показать всё' }).click()
    const map = page.getByRole('region', { name: `Карта ${run}` })
    await expect(map).toBeVisible()
    await page.waitForTimeout(1500)
    const box = await map.boundingBox()
    if (!box) throw new Error('нет области карты')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(page.getByText(`Школа № 1 ${run}`)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Открыть датасет' })).toBeVisible()
    await page.screenshot({ path: 'test-results/gis-map-studio.png' })

    // Сохранение и повторное открытие: слой на месте
    await page.getByRole('button', { name: 'Сохранить карту' }).click()
    await expect(page.getByText('Карта сохранена')).toBeVisible()
    await page.reload()
    await expect(
      page.getByRole('checkbox', { name: `Показывать слой «${datasetName}»` }),
    ).toBeVisible({
      timeout: 20_000,
    })
  })
})
