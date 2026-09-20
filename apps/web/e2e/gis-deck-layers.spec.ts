import { expect, openScreen, openWorkspace, test } from './fixtures.js'

/**
 * Ускоренная отрисовка больших слоёв (P5-E03, ADR-0110): порог настраивается в
 * администрировании; слой крупнее порога рисует deck.gl по тем же тайлам MVT,
 * щелчок по объекту так же открывает карточку. Порог выше числа объектов или
 * выключенная настройка — слой снова рисует MapLibre: это запасной путь.
 *
 * Сколько слоёв рисует deck.gl — атрибут `data-deck-layers` области карты.
 */
test.describe('GIS: deck.gl для больших слоёв', () => {
  test('порог в администрировании → слой рисует deck.gl → карточка объекта → возврат к MapLibre', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    await openWorkspace(page, request)
    const run = Date.now().toString(36)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const space = spaces.find((item) => item.kind === 'team') ?? spaces[0]

    // Датасет точек: больше порога (1000) — минимального в настройке
    const datasetName = `Датчики ${run}`
    const created = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: datasetName,
        spaceId: space?.id,
        fields: [
          { key: 'name', label: { ru: 'Название' }, type: 'text' },
          { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
        ],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const datasetId = (await created.json()).id as string

    // Все точки в одном месте: «Показать всё» ставит их в центр, и щелчок
    // в середину карты попадает по объекту и у deck.gl, и у MapLibre
    const point = (index: number) => ({
      values: {
        name: `Датчик ${index} ${run}`,
        place: { type: 'Point', coordinates: [68.78, 38.56] },
      },
    })
    for (const chunk of [0, 1]) {
      const rows = Array.from({ length: 600 }, (_, i) => point(chunk * 600 + i))
      const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
        headers,
        data: { rows },
      })
      expect(inserted.ok(), await inserted.text()).toBeTruthy()
    }

    // Порог отрисовки — в администрировании, рядом с базовыми картами
    await openScreen(page, 'Администрирование')
    await page.getByRole('tab', { name: 'Базовые карты' }).click()
    const renderCard = page.getByRole('group', { name: 'Отрисовка больших слоёв' })
    await expect(renderCard).toBeVisible()
    await renderCard.getByLabel('Порог объектов').fill('1000')
    await renderCard.getByRole('button', { name: 'Сохранить', exact: true }).click()
    await expect(page.getByText('Настройки отрисовки сохранены')).toBeVisible()
    const saved = await request.get('/api/v1/gis/render-settings')
    expect((await saved.json()).deckThreshold).toBe(1000)

    // Карта со слоем из датасета
    await page.getByRole('button', { name: 'Карты', exact: true }).click()
    await page.getByRole('button', { name: 'Создать карту' }).click()
    const dialog = page.getByRole('dialog', { name: 'Новая карта' })
    await dialog.getByLabel('Название карты').fill(`Карта ${run}`)
    await dialog.getByRole('button', { name: 'Создать' }).click()
    await expect(page.getByRole('tab', { name: new RegExp(`Карта ${run}`) })).toBeVisible()

    await page.getByRole('button', { name: 'Добавить слой' }).first().click()
    const add = page.getByRole('dialog', { name: 'Добавить слой на карту' })
    await add.getByLabel('Найти датасет').fill(datasetName)
    await add.getByRole('button', { name: datasetName }).click()
    await expect(add.getByText(`Новый слой «${datasetName}»`)).toBeVisible()
    await add.getByRole('button', { name: 'Добавить слой' }).click()
    await expect(add).toBeHidden()
    await expect(
      page.getByRole('checkbox', { name: `Показывать слой «${datasetName}»` }),
    ).toBeChecked()

    // 1200 объектов больше порога — слой рисует deck.gl
    await expect(page.locator('[data-deck-layers]')).toHaveAttribute('data-deck-layers', '1', {
      timeout: 30_000,
    })

    // Щелчок по объекту открывает карточку — выбор объектов работает и в deck.gl
    await page.getByRole('button', { name: 'Показать всё' }).click()
    const map = page.getByRole('region', { name: `Карта ${run}` })
    await expect(map).toBeVisible()
    await page.waitForTimeout(2000)
    const box = await map.boundingBox()
    if (!box) throw new Error('нет области карты')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(page.getByRole('button', { name: 'Открыть датасет' })).toBeVisible({
      timeout: 20_000,
    })
    await page.screenshot({ path: 'test-results/gis-deck-layers.png' })

    // Карта сохраняется: после перезагрузки слой на месте
    await page.getByRole('button', { name: 'Сохранить карту' }).click()
    await expect(page.getByText('Карта сохранена')).toBeVisible()

    // Выключенная ускоренная отрисовка возвращает слой в MapLibre
    const off = await request.put('/api/v1/admin/gis/render-settings', {
      headers,
      data: { deckEnabled: false },
    })
    expect(off.ok(), await off.text()).toBeTruthy()
    await page.reload()
    await expect(
      page.getByRole('checkbox', { name: `Показывать слой «${datasetName}»` }),
    ).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-deck-layers]')).toHaveAttribute('data-deck-layers', '0')
    // Карта работает как раньше: щелчок по той же точке открывает карточку
    await page.getByRole('button', { name: 'Показать всё' }).click()
    await page.waitForTimeout(2000)
    const again = await page.getByRole('region', { name: `Карта ${run}` }).boundingBox()
    if (!again) throw new Error('нет области карты')
    await page.mouse.click(again.x + again.width / 2, again.y + again.height / 2)
    await expect(page.getByRole('button', { name: 'Открыть датасет' })).toBeVisible({
      timeout: 20_000,
    })

    // Убираем за собой: настройка по умолчанию, карта и датасет со слоем
    await request.put('/api/v1/admin/gis/render-settings', {
      headers,
      data: { deckEnabled: true, deckThreshold: 50_000 },
    })
    await request.delete(`/api/v1/objects/${datasetId}`, { headers })
  })
})
