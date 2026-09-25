import { readFile } from 'node:fs/promises'
import type { APIRequestContext } from '@playwright/test'
import { expect, openWorkspace, test } from './fixtures.js'

/**
 * Доработка данных и карт перед пилотом (ADR-0159, ADR-0160): фильтр по столбцу
 * в таблице датасета, выгрузка результата «Исследования», лист печати дашборда
 * и группы слоёв карты.
 */

const run = Date.now().toString(36)

async function csrf(request: APIRequestContext): Promise<Record<string, string>> {
  const me = await (await request.get('/api/v1/me')).json()
  return { 'x-csrf-token': me.session.csrfToken as string }
}

/** Датасет с районами, ущербом и точками — через API, в первом доступном пространстве. */
async function seedDataset(request: APIRequestContext) {
  const headers = await csrf(request)
  const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
    id: string
  }>
  const spaceId = spaces[0]?.id as string
  const created = await request.post('/api/v1/datasets', {
    headers,
    data: {
      name: `Паводок ${run}`,
      spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'damage', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
        { key: 'place', label: { ru: 'Место' }, type: 'geometry', semantic: 'geometry' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const datasetId = (await created.json()).id as string
  const rows = [
    ['P-1', 'Хатлон', 10, [68.78, 37.83]],
    ['P-2', 'Хатлон', 20, [68.9, 37.9]],
    ['P-3', 'Согд', 30, [69.6, 40.28]],
  ].map(([code, district, damage, point]) => ({
    values: { code, district, damage, place: { type: 'Point', coordinates: point } },
  }))
  const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
    headers,
    data: { rows },
  })
  expect(inserted.ok(), await inserted.text()).toBeTruthy()
  return { datasetId, spaceId, headers }
}

test.describe('Данные и карты: доработка до пилота', () => {
  test('фильтр по столбцу, выгрузка «Исследования», лист печати дашборда', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const { datasetId, spaceId, headers } = await seedDataset(request)
    await openWorkspace(page, request)
    await page.goto(`/o/${datasetId}`)

    // Фильтр по столбцу: меню столбца → условие сразу по полю «Район»
    const grid = page.getByRole('grid', { name: `Паводок ${run}` })
    await expect(grid.getByRole('row')).toHaveCount(4)
    await page.getByRole('columnheader', { name: 'Район' }).hover()
    await page.getByRole('button', { name: 'Меню столбца «Район»' }).click()
    await page.getByRole('menuitem', { name: 'Фильтр по столбцу' }).click()
    await page.getByRole('combobox', { name: 'Условие' }).click()
    await page.getByRole('option', { name: 'равно', exact: true }).click()
    await page.getByRole('textbox', { name: 'Значение' }).fill('Согд')
    await page.getByRole('button', { name: 'Применить' }).click()
    await expect(page.getByRole('button', { name: 'Район равно Согд — изменить' })).toBeVisible()
    await expect(grid.getByRole('row')).toHaveCount(2)
    await expect(page.getByRole('columnheader', { name: /Район.*есть фильтр/ })).toBeVisible()

    // Выгрузка результата «Исследования» в CSV
    await page.getByRole('button', { name: 'Исследовать' }).click()
    await expect(page.getByText(/· [0-9 ]+ мс/)).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Экспорт' }).last().click()
    const downloading = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Данные — CSV' }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toMatch(/^Паводок .+ \d{4}-\d{2}-\d{2}\.csv$/)
    const text = await readFile((await download.path()) as string, 'utf8')
    expect(text.split(/\r?\n/)[0]).toContain('Количество')

    // Лист печати дашборда: сетка плиток, график дорисован, сигнал готовности
    const dashboard = await request.post('/api/v1/dashboards', {
      headers,
      data: {
        name: `Обстановка ${run}`,
        spaceId,
        spec: {
          tiles: [
            {
              id: 'damage',
              kind: 'chart',
              title: 'Ущерб по районам',
              spec: {
                version: 1,
                type: 'bar',
                data: {
                  query: {
                    version: 1,
                    source: { kind: 'dataset', id: datasetId },
                    steps: [
                      {
                        type: 'aggregate',
                        groupBy: [{ field: 'district' }],
                        measures: [{ alias: 'total', agg: 'sum', field: 'damage' }],
                      },
                    ],
                  },
                },
                encoding: {
                  x: { field: 'district', type: 'nominal' },
                  y: [{ field: 'total', type: 'quantitative' }],
                },
              },
              x: 0,
              y: 0,
              w: 8,
              h: 4,
            },
            { id: 'note', kind: 'text', text: `Сводка ${run}`, x: 8, y: 0, w: 4, h: 2 },
          ],
        },
      },
    })
    expect(dashboard.ok(), await dashboard.text()).toBeTruthy()
    const dashboardId = (await dashboard.json()).id as string
    await page.goto(`/print/dashboard/${dashboardId}`)
    await expect(page.locator('html[data-print-state="ready"]')).toBeAttached({ timeout: 30_000 })
    await expect(page.getByRole('heading', { name: `Обстановка ${run}` })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Ущерб по районам' })).toBeVisible()
    await expect(page.locator('[data-chart-state="ready"]')).toHaveCount(1)
    await expect(page.getByText(`Сводка ${run}`)).toBeVisible()

    // Плитка-график на дашборде: картинка PNG и данные с фильтрами дашборда
    await page.goto(`/o/${dashboardId}`)
    await expect(page.getByRole('heading', { name: 'Ущерб по районам' })).toBeVisible()
    await expect(page.locator('[data-chart-state="ready"]').first()).toBeVisible({
      timeout: 20_000,
    })
    const tileExport = page.getByRole('button', { name: 'Экспорт', exact: true })
    await tileExport.click()
    const picture = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Картинка — PNG' }).click()
    expect((await picture).suggestedFilename()).toBe('Ущерб по районам.png')
    await tileExport.click()
    const data = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Данные — Excel (XLSX)' }).click()
    expect((await data).suggestedFilename()).toMatch(/^Ущерб по районам .+\.xlsx$/)
  })

  test('группа слоёв карты: узел дерева и общий флажок видимости', async ({ page, request }) => {
    test.setTimeout(90_000)
    const { datasetId, spaceId, headers } = await seedDataset(request)
    const layer = await request.post('/api/v1/gis/layers', {
      headers,
      data: { name: `Пункты ${run}`, spaceId, datasetId },
    })
    expect(layer.ok(), await layer.text()).toBeTruthy()
    const layerId = (await layer.json()).id as string
    const map = await request.post('/api/v1/gis/maps', {
      headers,
      data: {
        name: `Карта паводка ${run}`,
        spaceId,
        spec: { layers: [{ layerId, visible: true, opacity: 1, group: null }] },
      },
    })
    expect(map.ok(), await map.text()).toBeTruthy()
    await openWorkspace(page, request)
    await page.goto(`/o/${(await map.json()).id}`)

    const panel = page.getByRole('region', { name: 'Слои' })
    await panel.getByRole('button', { name: `Действия со слоем «Пункты ${run}»` }).click()
    await page.getByRole('menuitem', { name: 'Группа…' }).click()
    const dialog = page.getByRole('dialog', { name: `Группа слоя «Пункты ${run}»` })
    await dialog.getByRole('textbox', { name: 'Название группы' }).fill('Паводок')
    await dialog.getByRole('button', { name: 'Сохранить' }).click()

    const toggle = panel.getByRole('checkbox', { name: 'Показать группу «Паводок»' })
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(
      panel.getByRole('checkbox', { name: `Показывать слой «Пункты ${run}»` }),
    ).not.toBeChecked()
    // Выгрузка видимых слоёв: слой снова виден — файл GeoJSON по слою
    await toggle.click()
    await panel.getByRole('button', { name: 'Выгрузить слои в геоформаты' }).click()
    const exportDialog = page.getByRole('dialog', { name: 'Выгрузка видимых слоёв' })
    await exportDialog.getByRole('button', { name: 'Выгрузить' }).click()
    const geojson = page.waitForEvent('download')
    await exportDialog
      .getByRole('button', { name: `Скачать «Пункты ${run}»` })
      .click({ timeout: 60_000 })
    expect((await geojson).suggestedFilename()).toMatch(/\.geojson$/)
    await exportDialog.getByRole('button', { name: 'Закрыть' }).first().click()

    await panel.getByRole('button', { name: 'Свернуть группу «Паводок»' }).click()
    await expect(
      panel.getByRole('button', { name: `Действия со слоем «Пункты ${run}»` }),
    ).toBeHidden()
  })
})
