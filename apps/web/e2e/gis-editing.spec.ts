import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { EMPLOYEE_STATE, expect, openWorkspace, resetWorkspaceState, test } from './fixtures.js'

/**
 * Приёмка фазы 2, сценарий 3 (04-verification.md §3, ADR-0076): на карте добавлен
 * полигон с привязкой к вершине соседнего объекта, атрибуты — формой по схеме
 * датасета (территория — по карте), история и откат правки; слой с модерацией —
 * правка сотрудника ждёт проверки владельца и применяется после принятия.
 * Данные — по API в пространстве прогона; сотрудник — участник с правом комментировать.
 */

const BASE = process.env.KCHS_BASE_URL ?? 'http://localhost:5173'
const ZOOM = 13
const CENTER: [number, number] = [68.78, 38.56]
/** Соседняя зона: вершина (68.785, 38.555) — цель привязки. */
const NEIGHBOUR = {
  type: 'Polygon',
  coordinates: [
    [
      [68.775, 38.555],
      [68.785, 38.555],
      [68.785, 38.565],
      [68.775, 38.565],
      [68.775, 38.555],
    ],
  ],
}

/** Пиксели Web Mercator при тайлах 512 px (MapLibre). */
function mercator(lon: number, lat: number): { x: number; y: number } {
  const size = 512 * 2 ** ZOOM
  const rad = (lat * Math.PI) / 180
  return {
    x: ((lon + 180) / 360) * size,
    y: ((1 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / Math.PI) / 2) * size,
  }
}

/** Точка экрана для координаты: карта стоит в центре CENTER на масштабе ZOOM без поворота. */
async function screenOf(map: Locator, lon: number, lat: number) {
  const box = await map.boundingBox()
  if (!box) throw new Error('нет области карты')
  const center = mercator(CENTER[0], CENTER[1])
  const point = mercator(lon, lat)
  return {
    x: box.x + box.width / 2 + (point.x - center.x),
    y: box.y + box.height / 2 + (point.y - center.y),
  }
}

async function csrf(request: APIRequestContext): Promise<Record<string, string>> {
  const me = await request.get('/api/v1/me')
  return { 'x-csrf-token': (await me.json()).session.csrfToken as string }
}

/**
 * Пространство прогона: сотрудник (user001) — участник с ролью member, то есть
 * комментирует объекты и предлагает правки, но данные не правит. В нём —
 * датасет зон, соседняя зона, редактируемый слой и карта.
 */
async function prepare(request: APIRequestContext, run: string) {
  const headers = await csrf(request)
  const spaceCreated = await request.post('/api/v1/spaces', {
    headers,
    data: { key: `edit-${run}`, name: `Правка ${run}` },
  })
  expect(spaceCreated.ok(), await spaceCreated.text()).toBeTruthy()
  const space = { id: (await spaceCreated.json()).id as string }
  const users = await request.get('/api/v1/users?q=user001')
  const employee = (await users.json()).items[0] as { id: string }
  const joined = await request.post(`/api/v1/spaces/${space.id}/members`, {
    headers,
    data: { userId: employee.id, role: 'member' },
  })
  expect(joined.ok(), await joined.text()).toBeTruthy()
  const created = await request.post('/api/v1/datasets', {
    headers,
    data: {
      name: `Зоны подтопления ${run}`,
      spaceId: space.id,
      fields: [
        { key: 'name', label: { ru: 'Название' }, type: 'text', required: true },
        {
          key: 'level',
          label: { ru: 'Опасность' },
          type: 'select',
          options: [
            { value: 'low', label: { ru: 'Низкая' } },
            { value: 'high', label: { ru: 'Высокая' } },
          ],
        },
        { key: 'district', label: { ru: 'Район' }, type: 'territory', semantic: 'territory' },
        {
          key: 'area',
          label: { ru: 'Контур' },
          type: 'geometry',
          semantic: 'geometry',
          geometryType: 'polygon',
        },
      ],
      territoryField: 'district',
    },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const datasetId = (await created.json()).id as string
  const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
    headers,
    data: { rows: [{ values: { name: `Соседняя ${run}`, level: 'low', area: NEIGHBOUR } }] },
  })
  expect(inserted.ok(), await inserted.text()).toBeTruthy()
  const layer = await request.post('/api/v1/gis/layers', {
    headers,
    data: { name: `Зоны подтопления ${run}`, spaceId: space.id, datasetId, editable: true },
  })
  expect(layer.ok(), await layer.text()).toBeTruthy()
  const layerId = (await layer.json()).id as string
  const map = await request.post('/api/v1/gis/maps', {
    headers,
    data: {
      name: `Паводок ${run}`,
      spaceId: space.id,
      spec: {
        layers: [{ layerId, visible: true, opacity: 1, group: null }],
        camera: { center: CENTER, zoom: ZOOM, bearing: 0, pitch: 0 },
      },
    },
  })
  expect(map.ok(), await map.text()).toBeTruthy()
  return { datasetId, layerId, mapId: (await map.json()).id as string }
}

interface Row {
  _id: string
  name: string
  level: string | null
  district: string | null
  area: { type: string; coordinates: number[][][] }
}

/** Строки датасета зон — с политиками смотрящего, как в таблице. */
async function rows(request: APIRequestContext, datasetId: string): Promise<Row[]> {
  const response = await request.post(`/api/v1/datasets/${datasetId}/rows/query`, {
    headers: await csrf(request),
    data: { limit: 50 },
  })
  expect(response.ok(), await response.text()).toBeTruthy()
  const body = (await response.json()) as { fields: Array<{ name: string }>; rows: unknown[][] }
  return body.rows.map(
    (row) =>
      Object.fromEntries(body.fields.map((field, index) => [field.name, row[index]])) as never,
  )
}

/**
 * Карта-студия открыта по адресу объекта; навигатор и контекстная панель свёрнуты —
 * карте места больше; слои нарисованы.
 */
async function openMap(page: Page, mapId: string, name: string): Promise<Locator> {
  await page.goto(`/o/${mapId}`)
  const map = page.getByRole('region', { name })
  await expect(map).toBeVisible({ timeout: 20_000 })
  for (const label of ['Свернуть навигатор', 'Свернуть панель']) {
    const button = page.getByRole('button', { name: label })
    if (await button.isVisible()) await button.click()
  }
  await page.waitForTimeout(1500)
  return map
}

/** Режим правки слоя; объекты для привязки загружены. */
async function startEditing(page: Page, layerName: string) {
  const snap = page.waitForResponse(
    (response) => /\/features\?bbox=/.test(response.url()) && response.status() === 200,
  )
  await page.getByRole('button', { name: 'Править' }).click()
  await page.getByRole('menuitem', { name: layerName }).click()
  await expect(page.getByRole('toolbar', { name: 'Правка объектов' })).toBeVisible()
  await snap
}

/** Контур: вершины по координатам, первая — рядом с вершиной соседа; Enter замыкает. */
async function drawPolygon(
  page: Page,
  map: Locator,
  vertices: Array<[number, number, number, number]>,
) {
  await page.getByRole('button', { name: 'Полигон' }).click()
  for (const [lon, lat, dx, dy] of vertices) {
    const at = await screenOf(map, lon, lat)
    await page.mouse.move(at.x + dx, at.y + dy, { steps: 4 })
    await page.mouse.click(at.x + dx, at.y + dy)
    await page.waitForTimeout(250)
  }
  await page.keyboard.press('Enter')
}

test.describe('GIS: правка объектов и модерация', () => {
  test('полигон с привязкой, форма, история и откат; модерируемый слой — правка ждёт проверки', async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(180_000)
    const run = Date.now().toString(36)
    const layerName = `Зоны подтопления ${run}`
    const mapName = `Паводок ${run}`
    const { datasetId, layerId, mapId } = await prepare(request, run)

    await openWorkspace(page, request)
    const map = await openMap(page, mapId, mapName)
    await startEditing(page, layerName)
    const panel = page.getByRole('region', { name: 'Правка объектов' })
    await expect(panel.getByText('Выберите объект или нарисуйте новый')).toBeVisible()

    // Полигон: первая вершина в 5 px от вершины соседней зоны — привязка
    await drawPolygon(page, map, [
      [68.785, 38.555, 4, -3],
      [68.795, 38.555, 0, 0],
      [68.795, 38.548, 0, 0],
      [68.785, 38.548, 0, 0],
    ])
    await expect(panel.getByText('Новый объект')).toBeVisible()
    // Территория — по карте (обратный геокодер по точке объекта)
    await expect(panel.getByText('Определена по карте')).toBeVisible({ timeout: 10_000 })
    await panel.getByLabel('Название').fill(`Пойма ${run}`)
    await panel.getByRole('combobox', { name: 'Опасность' }).click()
    await page.getByRole('option', { name: 'Высокая' }).click()
    await page.screenshot({ path: 'test-results/gis-editing-draw.png' })
    await panel.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Объект добавлен')).toBeVisible()
    await page.waitForTimeout(1000)
    await page.screenshot({ path: 'test-results/gis-editing-saved.png' })

    const all = await rows(request, datasetId)
    expect(all).toHaveLength(2)
    const drawn = all.find((item) => item.name === `Пойма ${run}`)
    expect(drawn, JSON.stringify(all)).toBeDefined()
    expect(drawn).toMatchObject({ level: 'high', area: { type: 'Polygon' } })
    expect(drawn?.district).toBeTruthy()
    const ring = drawn?.area.coordinates[0] ?? []
    // Вершина совпала с вершиной соседа точно — привязка, а не «примерно рядом»
    expect(ring.some(([x, y]) => x === 68.785 && y === 38.555)).toBe(true)
    const rowId = drawn?._id as string

    // Правка атрибута: новая версия; история показывает правку, откат возвращает значение
    await expect(panel.getByText(`Объект № ${rowId}`)).toBeVisible()
    await panel.getByLabel('Название').fill(`Пойма ${run} (уточнена)`)
    await panel.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Изменения сохранены')).toBeVisible()
    await expect(panel.getByText('Версия 2')).toBeVisible()

    // Геометрия — координатами вручную: южная граница ниже
    await page.getByRole('button', { name: 'Координаты вручную' }).click()
    const dialog = page.getByRole('dialog', { name: 'Координаты' })
    const vertices = dialog.getByLabel('Вершины')
    const text = await vertices.inputValue()
    await vertices.fill(text.replaceAll('38.548', '38.546'))
    await dialog.getByRole('button', { name: 'Применить' }).click()
    await panel.getByRole('button', { name: 'Сохранить' }).click()
    await expect(page.getByText('Изменения сохранены')).toBeVisible()
    await expect(panel.getByText('Версия 3')).toBeVisible()

    await panel.getByRole('tab', { name: 'История' }).click()
    const history = panel.getByRole('list', { name: 'История' })
    await expect(history.getByRole('listitem')).toHaveCount(3)
    await expect(history.getByText('Контур изменён')).toBeVisible()
    await history.getByRole('button', { name: 'Показать как было' }).first().click()
    await page.screenshot({ path: 'test-results/gis-editing-history.png' })
    // Откат правки названия (вторая сверху запись — версия 2)
    await history
      .getByRole('listitem')
      .nth(1)
      .getByRole('button', { name: 'Откатить правку' })
      .click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Откатить правку' }).click()
    await expect(page.getByText('Правка откачена')).toBeVisible()
    const row = await request.get(`/api/v1/datasets/${datasetId}/rows/${rowId}`)
    expect((await row.json()).values).toMatchObject({ name: `Пойма ${run}`, level: 'high' })

    // Модерация: владелец включает проверку правок
    await panel.getByRole('switch', { name: /Правки проходят проверку/ }).click()
    await expect(panel.getByRole('switch', { name: /Правки проходят проверку/ })).toBeChecked()

    // Сотрудник (участник «Общего» — комментирует) предлагает новую зону
    const colleague = await browser.newContext({ baseURL: BASE, storageState: EMPLOYEE_STATE })
    await resetWorkspaceState(colleague.request)
    await colleague.addInitScript(() => localStorage.removeItem('kchs.workspace'))
    const other = await colleague.newPage()
    await other.goto('/')
    await expect(other.getByRole('tab', { name: /Мой день/ })).toBeVisible({ timeout: 20_000 })
    const otherMap = await openMap(other, mapId, mapName)
    await startEditing(other, layerName)
    const otherPanel = other.getByRole('region', { name: 'Правка объектов' })
    await expect(
      other.getByRole('toolbar', { name: 'Правка объектов' }).getByText('На проверку'),
    ).toBeVisible()
    await drawPolygon(other, otherMap, [
      [68.765, 38.566, 0, 0],
      [68.772, 38.566, 0, 0],
      [68.772, 38.572, 0, 0],
    ])
    await otherPanel.getByLabel('Название').fill(`Овраг ${run}`)
    await otherPanel.getByLabel('Комментарий для проверяющего').fill('Подтоплен после ливня')
    await otherPanel.getByRole('button', { name: 'Отправить на проверку' }).click()
    await expect(other.getByText('Правка отправлена на проверку')).toBeVisible()
    await expect(
      otherPanel.getByRole('list', { name: 'Правки' }).getByText('На проверке'),
    ).toBeVisible()
    await other.screenshot({ path: 'test-results/gis-editing-suggested.png' })
    expect(await rows(request, datasetId)).toHaveLength(2)

    // Владельцу слоя — дело во Входящих
    const inbox = await request.get('/api/v1/inbox?state=open')
    const items = (await inbox.json()).items as Array<{
      kind: string
      object: { id: string } | null
    }>
    expect(items.some((item) => item.kind === 'review_edit' && item.object?.id === layerId)).toBe(
      true,
    )

    // Владелец принимает правку в очереди проверки — объект появляется в слое
    await page.reload()
    await expect(page.getByRole('region', { name: mapName })).toBeVisible({ timeout: 20_000 })
    await startEditing(page, layerName)
    await page.getByRole('button', { name: /правка на проверке/ }).click()
    const review = page.getByRole('list', { name: 'Правки' })
    await expect(review.getByText(`Овраг ${run}`)).toBeVisible()
    await expect(review.getByText('Подтоплен после ливня')).toBeVisible()
    await review.getByRole('button', { name: 'Показать на карте' }).click()
    await page.screenshot({ path: 'test-results/gis-editing-review.png' })
    await review.getByRole('button', { name: 'Принять' }).click()
    await expect(page.getByText('Правка принята и применена')).toBeVisible()
    const after = await rows(request, datasetId)
    expect(after.map((item) => item.name)).toContain(`Овраг ${run}`)
    expect(after).toHaveLength(3)
    await colleague.close()
  })

  test('конфликт версии: различия и перезапись; перенос вершины; удаление', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const layerName = `Зоны подтопления ${run}`
    const mapName = `Паводок ${run}`
    const { datasetId, layerId, mapId } = await prepare(request, run)
    const [neighbour] = await rows(request, datasetId)
    const rowId = neighbour?._id as string

    await openWorkspace(page, request)
    const map = await openMap(page, mapId, mapName)
    await startEditing(page, layerName)
    const panel = page.getByRole('region', { name: 'Правка объектов' })

    // Щелчок по объекту слоя — он в правке: вершины на карте, значения в форме
    const center = await screenOf(map, 68.78, 38.56)
    await page.mouse.click(center.x, center.y)
    await expect(panel.getByText(`Объект № ${rowId}`)).toBeVisible()
    await panel.getByLabel('Название').fill(`Соседняя ${run} — моя правка`)

    // Тем временем объект изменил другой редактор
    const other = await request.patch(`/api/v1/gis/layers/${layerId}/features/${rowId}`, {
      headers: await csrf(request),
      data: { values: { level: 'high' }, ver: 1 },
    })
    expect(other.ok(), await other.text()).toBeTruthy()

    await panel.getByRole('button', { name: 'Сохранить' }).click()
    const conflict = page.getByRole('dialog', { name: 'Объект уже изменили' })
    await expect(conflict).toBeVisible()
    await expect(conflict.getByRole('row', { name: /Название/ })).toContainText('моя правка')
    await expect(conflict.getByRole('row', { name: /Опасность/ })).toContainText('Высокая')
    await page.screenshot({ path: 'test-results/gis-editing-conflict.png' })
    await conflict.getByRole('button', { name: 'Перезаписать' }).click()
    await expect(page.getByText('Изменения сохранены')).toBeVisible()
    await expect(panel.getByText('Версия 3')).toBeVisible()
    let [row] = await rows(request, datasetId)
    // Своё поле перезаписано, чужая правка другого поля сохранилась
    expect(row).toMatchObject({ name: `Соседняя ${run} — моя правка`, level: 'high' })

    // Перенос вершины: северо-восточный угол — на 0,004° к востоку
    const corner = await screenOf(map, 68.785, 38.565)
    const moved = await screenOf(map, 68.789, 38.565)
    await page.mouse.move(corner.x, corner.y, { steps: 3 })
    await page.mouse.down()
    await page.mouse.move(moved.x, moved.y, { steps: 12 })
    await page.mouse.up()
    await panel.getByRole('button', { name: 'Сохранить' }).click()
    await expect(panel.getByText('Версия 4')).toBeVisible()
    ;[row] = await rows(request, datasetId)
    const east = Math.max(...(row?.area.coordinates[0] ?? []).map(([x]) => x ?? 0))
    expect(east).toBeGreaterThan(68.787)

    // Удаление — с подтверждением; строки больше нет
    await panel.getByRole('button', { name: 'Удалить объект' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Удалить' }).click()
    await expect(page.getByText('Объект удалён')).toBeVisible()
    expect(await rows(request, datasetId)).toHaveLength(0)
  })
})
