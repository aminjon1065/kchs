import type { APIRequestContext } from '@playwright/test'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Сценарий приёмки фазы 2 №4 (P2-E04 S04, ADR-0077): «точки в полигонах районов →
 * хороплет „объектов на 1 000 жителей“ через мастер; результат как датасет и
 * слой». Датасет — по API: школы в центрах районов Хатлона; мастер открывается с
 * экрана датасета и из карты-студии.
 */

interface Territory {
  id: string
  code: string
  parentId: string | null
  level: string
  name: { ru: string }
  centroid: { lon: number; lat: number } | null
}

async function session(request: APIRequestContext) {
  const me = await request.get('/api/v1/me')
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
  const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
    id: string
    kind: string
  }>
  const space = spaces.find((item) => item.kind === 'team') ?? spaces[0]
  const territories = (await (await request.get('/api/v1/territories')).json()).items as Territory[]
  return { headers, spaceId: space?.id as string, territories }
}

/** Датасет школ: по две-три точки в центре каждого района Хатлонской области. */
async function createSchools(request: APIRequestContext, name: string) {
  const { headers, spaceId, territories } = await session(request)
  const region = territories.find((item) => item.code === 'TJ-KT') as Territory
  const districts = territories.filter(
    (item) => item.parentId === region.id && item.level === 'district' && item.centroid,
  )
  const created = await request.post('/api/v1/datasets', {
    headers,
    data: {
      name,
      spaceId,
      territoryField: 'territory',
      fields: [
        { key: 'name', label: { ru: 'Название' }, type: 'text' },
        { key: 'capacity', label: { ru: 'Вместимость' }, type: 'integer', semantic: 'measure' },
        { key: 'territory', label: { ru: 'Территория' }, type: 'territory' },
        { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
      ],
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const datasetId = (await created.json()).id as string
  const rows = districts.flatMap((district, index) =>
    Array.from({ length: 1 + (index % 3) }, (_, n) => ({
      values: {
        name: `Школа ${district.code}-${n + 1}`,
        capacity: 100 * (n + 1),
        territory: district.id,
        place: {
          type: 'Point',
          coordinates: [district.centroid?.lon, district.centroid?.lat],
        },
      },
    })),
  )
  const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
    headers,
    data: { rows },
  })
  expect(inserted.ok(), await inserted.text()).toBeTruthy()
  return { datasetId, spaceId, headers, districts: districts.length }
}

test.describe('GIS: хороплет-мастер', () => {
  test('сценарий 4: школы в районах → хороплет на 1 000 жителей → датасет, слой, карта', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    await openWorkspace(page, request)
    const run = Date.now().toString(36)
    const name = `Школы ${run}`
    const { datasetId } = await createSchools(request, name)

    await page.goto(`/o/${datasetId}`)
    await expect(page.getByRole('tab', { name: new RegExp(name) })).toBeVisible({
      timeout: 20_000,
    })
    await page.getByRole('button', { name: 'Хороплет', exact: true }).click()
    const wizard = page.getByRole('dialog', { name: 'Хороплет-мастер' })
    await expect(wizard).toBeVisible()

    // 1. Источник: датасет выбран, объекты — по геометрии в границах районов
    await wizard.getByRole('radio', { name: 'Объект лежит в границе территории' }).click()
    await expect(wizard.getByText(/Точка на поверхности «Место» внутри границы/)).toBeVisible()
    await wizard.getByRole('button', { name: 'Далее' }).click()
    // 2. Территории: районы по всей стране
    await expect(wizard.getByRole('radio', { name: 'Районы' })).toBeChecked()
    await wizard.getByRole('button', { name: 'Далее' }).click()
    // 3. Мера: количество на 1 000 жителей
    await expect(wizard.getByRole('radio', { name: 'Количество' })).toBeChecked()
    await expect(wizard.getByRole('radio', { name: 'На население территории' })).toBeChecked()
    await expect(wizard.getByRole('combobox', { name: 'Нормировать' })).toHaveText(
      /на 1.000 жителей/,
    )
    await wizard.getByRole('button', { name: 'Далее' }).click()
    // 4. Классы и палитра: предпросмотр по данным с правами смотрящего
    await expect(wizard.getByRole('region', { name: 'Предпросмотр хороплета' })).toBeVisible({
      timeout: 20_000,
    })
    await expect(wizard.getByText(/68 территорий · от 0 до/)).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: 'test-results/gis-choropleth-preview.png' })
    await wizard.getByRole('button', { name: 'Далее' }).click()
    // 5. Результат: анализ, датасет, слой и новая карта
    await expect(wizard.getByLabel('Название анализа')).toHaveValue(
      new RegExp(`${name} на 1.000 жителей по районам`),
    )
    await expect(wizard.getByRole('radio', { name: 'Новая карта' })).toBeChecked()
    const tile = page.waitForResponse(
      (response) =>
        /\/gis\/layers\/[^/]+\/tiles\//.test(response.url()) && response.status() === 200,
      { timeout: 90_000 },
    )
    await wizard.getByRole('button', { name: 'Построить' }).click()
    await expect(wizard).toBeHidden({ timeout: 90_000 })

    // Карта с новым слоем: тайлы хороплета приходят с сервера
    const title = new RegExp(`${name} на 1.000 жителей по районам`)
    await expect(page.getByRole('tab', { name: title })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /Показывать слой/ })).toBeChecked()
    expect((await tile).headers()['content-type']).toContain('application/vnd.mapbox-vector-tile')
    await page.getByRole('button', { name: 'Показать всё' }).click()
    await page.waitForTimeout(2000)
    await page.screenshot({ path: 'test-results/gis-choropleth-map.png' })

    // Результат — датасет: анализ «Хороплет» с параметрами мастера
    const analyses = await request.get('/api/v1/objects', {
      params: { types: 'analysis', q: name, limit: 5 },
    })
    const analysis = (await analyses.json()).items[0] as { id: string }
    const record = await (await request.get(`/api/v1/analyses/${analysis.id}`)).json()
    expect(record).toMatchObject({
      kind: 'choropleth',
      status: 'succeeded',
      choropleth: { join: 'geometry', level: 'district', normalize: 'population', per: 1000 },
    })
    const output = await (await request.get(`/api/v1/datasets/${record.outputDatasetId}`)).json()
    expect(output.fields.map((field: { key: string }) => field.key)).toEqual([
      'territory',
      'code',
      'name',
      'value',
      'population',
      'rate',
      'geom',
    ])
  })

  test('из карты-студии: хороплет по полю территории встаёт на текущую карту', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000)
    await openWorkspace(page, request)
    const run = Date.now().toString(36)
    const name = `Школы студии ${run}`
    const { spaceId, headers } = await createSchools(request, name)
    const map = await request.post('/api/v1/gis/maps', {
      headers,
      data: { name: `Карта ${run}`, spaceId },
    })
    expect(map.ok(), await map.text()).toBeTruthy()

    await page.goto(`/o/${(await map.json()).id}`)
    await expect(page.getByText('На карте нет слоёв')).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Хороплет', exact: true }).click()
    const wizard = page.getByRole('dialog', { name: 'Хороплет-мастер' })
    await wizard.getByLabel('Найти датасет').fill(name)
    await wizard.getByRole('button', { name }).click()
    await expect(wizard.getByRole('radio', { name: 'По значению поля территории' })).toBeChecked()
    await wizard.getByRole('button', { name: 'Далее' }).click()
    await wizard.getByRole('radio', { name: 'Регионы' }).click()
    await wizard.getByRole('button', { name: 'Далее' }).click()
    await wizard.getByRole('radio', { name: 'Сумма' }).click()
    await expect(wizard.getByRole('combobox', { name: 'Поле меры' })).toHaveText('Вместимость')
    await wizard.getByRole('radio', { name: 'На площадь территории' }).click()
    await wizard.getByRole('button', { name: 'Далее' }).click()
    await expect(wizard.getByText(/5 территорий · от 0 до/)).toBeVisible({ timeout: 20_000 })
    await wizard.getByRole('button', { name: 'Далее' }).click()
    await expect(
      wizard.getByRole('radio', { name: 'Текущая карта — сохраните её после добавления слоя' }),
    ).toBeChecked()
    await wizard.getByRole('button', { name: 'Построить' }).click()
    await expect(wizard).toBeHidden({ timeout: 90_000 })
    await expect(page.getByText('Слой хороплета на карте — сохраните карту')).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /Показывать слой/ })).toBeChecked()
    await page.getByRole('button', { name: 'Сохранить карту' }).click()
    await expect(page.getByText('Карта сохранена')).toBeVisible()
  })
})
