import { readFileSync } from 'node:fs'
import type { APIRequestContext, Page, Request } from '@playwright/test'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Время, печать и карта на дашборде (P2-E02 S04–S06, ADR-0074): слой со
 * временем — шкала и воспроизведение меняют интервал `t` в запросах тайлов;
 * печать выгружает PNG и PDF листа; «На дашборд» ставит карту плиткой, фильтр
 * дашборда, привязанный к полю датасета слоя, уходит тайлам параметром `f`.
 * Датасет, слой и карта — по API: сценарий проверяет студию и дашборд.
 */

interface Fixture {
  datasetName: string
  mapId: string
  mapName: string
}

async function createMap(request: APIRequestContext, run: string): Promise<Fixture> {
  const me = await request.get('/api/v1/me')
  const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }
  const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
    id: string
    kind: string
  }>
  const spaceId = (spaces.find((item) => item.kind === 'team') ?? spaces[0])?.id
  const datasetName = `Происшествия ${run}`
  const created = await request.post('/api/v1/datasets', {
    headers,
    data: {
      name: datasetName,
      spaceId,
      fields: [
        { key: 'name', label: { ru: 'Название' }, type: 'text' },
        { key: 'district', label: { ru: 'Регион' }, type: 'text', semantic: 'category' },
        { key: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
        { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
      ],
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const datasetId = (await created.json()).id as string
  const rows = [
    ['Душанбе', 'Душанбе', '2026-01-10', [68.78, 38.56]],
    ['Бохтар', 'Хатлон', '2026-02-12', [68.78, 37.83]],
    ['Куляб', 'Хатлон', '2026-03-05', [69.78, 37.91]],
    ['Худжанд', 'Согд', '2026-04-20', [69.62, 40.28]],
  ] as const
  const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
    headers,
    data: {
      rows: rows.map(([name, district, day, coordinates]) => ({
        values: { name, district, day, place: { type: 'Point', coordinates } },
      })),
    },
  })
  expect(inserted.ok(), await inserted.text()).toBeTruthy()
  const layer = await request.post('/api/v1/gis/layers', {
    headers,
    data: {
      name: datasetName,
      spaceId,
      datasetId,
      style: {
        version: 1,
        geometry: 'point',
        renderer: { kind: 'simple', color: 'danger' },
        cluster: null,
        label: { field: 'name' },
        time: { field: 'day', mode: 'instant', step: 'month' },
      },
    },
  })
  expect(layer.ok(), await layer.text()).toBeTruthy()
  const mapName = `Обстановка ${run}`
  const map = await request.post('/api/v1/gis/maps', {
    headers,
    data: {
      name: mapName,
      spaceId,
      spec: {
        layers: [{ layerId: (await layer.json()).id }],
        camera: { center: [69.2, 39], zoom: 6 },
      },
    },
  })
  expect(map.ok(), await map.text()).toBeTruthy()
  return { datasetName, mapId: (await map.json()).id as string, mapName }
}

/** Параметр запросов тайлов слоя: `t` (интервал) или `f` (фильтр). */
function watchTiles(page: Page, param: 't' | 'f'): string[] {
  const seen: string[] = []
  page.on('request', (request: Request) => {
    const url = request.url()
    if (!/\/gis\/layers\/[^/]+\/tiles\//.test(url)) return
    const value = new URL(url).searchParams.get(param)
    if (value && !seen.includes(value)) seen.push(value)
  })
  return seen
}

async function openMap(page: Page, fixture: Fixture) {
  await page.goto(`/o/${fixture.mapId}`)
  await expect(page.getByRole('tab', { name: new RegExp(fixture.mapName) })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByRole('region', { name: fixture.mapName })).toBeVisible()
}

test.describe('GIS: время, печать, карта на дашборде', () => {
  test('шкала времени: интервал и воспроизведение меняют `t` тайлов', async ({ page, request }) => {
    test.setTimeout(120_000)
    await openWorkspace(page, request)
    const fixture = await createMap(request, `${Date.now().toString(36)}t`)
    const intervals = watchTiles(page, 't')
    await openMap(page, fixture)

    // Время по стилю слоя: «момент», шаг — месяц; первый кадр — январь
    await page.getByRole('button', { name: 'Показать шкалу времени' }).click()
    const bar = page.getByRole('region', { name: 'Шкала времени' })
    await expect(bar).toBeVisible()
    await expect(bar.getByRole('status')).toHaveText(/январь 2026/)
    await expect.poll(() => intervals).toContain('2026-01-01/2026-01-31')
    await expect(bar.getByRole('combobox', { name: 'Режим шкалы' })).toHaveText('Момент')
    await expect(bar.getByRole('combobox', { name: 'Шаг шкалы' })).toHaveText('Месяц')

    // Воспроизведение: кадры месяцев по порядку, до конца данных — и остановка
    await bar.getByRole('combobox', { name: 'Скорость воспроизведения' }).click()
    await page.getByRole('option', { name: '4×' }).click()
    await bar.getByRole('button', { name: 'Воспроизвести' }).click()
    await expect
      .poll(() => intervals, { timeout: 30_000 })
      .toEqual(
        expect.arrayContaining([
          '2026-02-01/2026-02-28',
          '2026-03-01/2026-03-31',
          '2026-04-01/2026-04-30',
        ]),
      )
    await expect(bar.getByRole('button', { name: 'Воспроизвести' })).toBeVisible({
      timeout: 15_000,
    })
    await expect(bar.getByRole('status')).toHaveText(/апрель 2026/)

    // Накопление: от начала данных до конца кадра
    await bar.getByRole('combobox', { name: 'Режим шкалы' }).click()
    await page.getByRole('option', { name: 'Накопление' }).click()
    await expect.poll(() => intervals).toContain('2026-01-01/2026-04-30')
    await expect(page.locator('[data-map-state]').first()).toHaveAttribute(
      'data-map-state',
      'idle',
      {
        timeout: 15_000,
      },
    )
    await page.screenshot({ path: 'test-results/gis-map-time.png' })

    // Интервал — часть карты: сохраняется вместе с ней
    await page.getByRole('button', { name: 'Сохранить карту' }).click()
    await expect(page.getByText('Карта сохранена')).toBeVisible()
    const saved = await (await request.get(`/api/v1/gis/maps/${fixture.mapId}`)).json()
    expect(saved.spec.time).toEqual({
      from: '2026-01-01',
      to: '2026-04-30',
      mode: 'cumulative',
      step: 'month',
    })
  })

  test('печать: лист с легендой, масштабом и атрибуцией — PNG и PDF', async ({ page, request }) => {
    test.setTimeout(120_000)
    await openWorkspace(page, request)
    const fixture = await createMap(request, `${Date.now().toString(36)}p`)
    await openMap(page, fixture)

    await page.getByRole('button', { name: 'Печать и выгрузка' }).click()
    const dialog = page.getByRole('dialog', { name: 'Печать карты' })
    await expect(dialog.getByRole('img', { name: 'Предпросмотр листа' })).toBeVisible({
      timeout: 30_000,
    })
    await expect(dialog.getByLabel('Заголовок')).toHaveValue(fixture.mapName)

    const png = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Скачать PNG' }).click()
    const pngFile = await png
    expect(pngFile.suggestedFilename()).toBe(`${fixture.mapName}.png`)
    const pngBytes = readFileSync(await pngFile.path())
    expect([...pngBytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    // Лист A4, альбомная ориентация — PDF
    await dialog.getByRole('radio', { name: 'A4' }).click()
    await expect(dialog.getByRole('radio', { name: 'Альбомная' })).toBeVisible()
    await expect(dialog.getByRole('img', { name: 'Предпросмотр листа' })).toBeVisible({
      timeout: 30_000,
    })
    await dialog.screenshot({ path: 'test-results/gis-map-print.png' })
    const pdf = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Скачать PDF' }).click()
    const pdfFile = await pdf
    expect(pdfFile.suggestedFilename()).toBe(`${fixture.mapName}.pdf`)
    const pdfBytes = readFileSync(await pdfFile.path())
    expect(pdfBytes.subarray(0, 9).toString('latin1')).toBe('%PDF-1.4\n')
    expect(pdfBytes.toString('latin1')).toContain('/MediaBox [0 0 841.89 595.28]')
  })

  test('карта на дашборде: «На дашборд» из студии, фильтр дашборда → `f` тайлов', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000)
    await openWorkspace(page, request)
    const run = `${Date.now().toString(36)}d`
    const fixture = await createMap(request, run)
    const filters = watchTiles(page, 'f')
    await openMap(page, fixture)

    // «На дашборд»: новый дашборд с плиткой-картой открывается во вкладке
    await page.getByRole('button', { name: 'На дашборд' }).click()
    const add = page.getByRole('dialog', { name: 'Добавить на дашборд' })
    await add.getByLabel('Название').fill(`Дашборд ${run}`)
    await add.getByRole('button', { name: 'На дашборд' }).click()
    await expect(page.getByRole('tab', { name: new RegExp(`Дашборд ${run}`) })).toBeVisible()
    const tileMap = page.getByRole('region', { name: fixture.mapName })
    await expect(tileMap).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Легенда' })).toBeVisible()

    // Фильтр «Регион» и его привязка к полю датасета слоя карты
    await page.getByRole('button', { name: 'Изменить', exact: true }).click()
    await page.getByRole('button', { name: 'Фильтр', exact: true }).click()
    const newFilter = page.getByRole('dialog', { name: 'Новый фильтр' })
    await newFilter.getByLabel('Подпись').fill('Регион')
    await newFilter.getByRole('button', { name: 'Создать' }).click()
    await page.getByRole('button', { name: 'Фильтры плитки' }).click()
    const bindings = page.getByRole('dialog', { name: fixture.mapName })
    await bindings
      .getByRole('combobox', {
        name: `Поле для фильтра «Регион» в датасете «${fixture.datasetName}»`,
      })
      .click()
    await page.getByRole('option', { name: 'Регион' }).click()
    await bindings.getByRole('button', { name: 'Сохранить' }).click()
    await expect(bindings).toBeHidden()
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
    await expect(page.getByText('Дашборд сохранён')).toBeVisible()

    // Значение фильтра — условие тайлов слоя этого датасета
    const value = page.getByRole('textbox', { name: 'Регион' })
    await value.fill('Хатлон')
    await value.press('Enter')
    await expect
      .poll(() =>
        filters.map((encoded) => JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))),
      )
      .toContainEqual({ field: 'district', op: 'in', value: ['Хатлон'] })
    await page.screenshot({ path: 'test-results/gis-map-dashboard.png' })

    const dashboards = (
      await (await request.get('/api/v1/objects?types=dashboard&limit=100')).json()
    ).items as Array<{ id: string; title: string }>
    const dashboard = dashboards.find((item) => item.title === `Дашборд ${run}`)
    const record = await (await request.get(`/api/v1/dashboards/${dashboard?.id}`)).json()
    expect(record.spec.tiles[0]).toMatchObject({
      kind: 'map',
      mapId: fixture.mapId,
      map: { bindings: { f1: expect.any(Object) } },
    })
  })
})
