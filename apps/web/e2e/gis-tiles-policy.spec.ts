import { gunzipSync } from 'node:zlib'
import { expect, test } from './fixtures.js'
import { decodeMvt } from './mvt.js'

const MANAGER_LOGIN = 'user058'
const MANAGER_PASSWORD = process.env.SEED_USER_PASSWORD || 'Kchs!Work-2026-3v'

/** Тайл XYZ, содержащий точку. */
function tileOf(lon: number, lat: number, z: number): string {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  const x = Math.floor(((lon + 180) / 360) * n)
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)
  return `${z}/${x}/${y}`
}

/** Названия объектов из ответа тайла (pbf, возможно сжатый gzip). */
function tileNames(body: Buffer, encoding: string | undefined): string[] {
  const raw = encoding === 'gzip' ? gunzipSync(body) : body
  return (decodeMvt(raw)[0]?.features ?? [])
    .map((feature) => feature.properties.name)
    .filter((name): name is string => typeof name === 'string')
}

/**
 * Сценарий приёмки фазы 2 №7 (04-verification.md): пользователь с политикой строк
 * видит в тайлах только свои объекты — проверка pbf, пришедших в браузер
 * руководителя, против тех же тайлов администратора. Данные, политика, слой и
 * карта — по API администратора; сценарий проверяет то, что видит руководитель.
 */
test.describe('GIS: политика строк в тайлах', () => {
  test('руководитель «только Хатлон» получает в тайлах только объекты Хатлона', async ({
    request,
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000)
    const run = Date.now().toString(36)
    const me = await request.get('/api/v1/me')
    const headers = { 'x-csrf-token': (await me.json()).session.csrfToken as string }

    const found = await request.get(`/api/v1/users?q=${MANAGER_LOGIN}`)
    expect(found.ok(), await found.text()).toBeTruthy()
    const manager = ((await found.json()).items as Array<{ id: string; login: string }>).find(
      (user) => user.login === MANAGER_LOGIN,
    )
    const managerId = manager?.id as string
    expect(managerId).toBeTruthy()
    const spaces = (await (await request.get('/api/v1/spaces')).json()).items as Array<{
      id: string
      kind: string
    }>
    const space = spaces.find((item) => item.kind === 'team') ?? spaces[0]
    const member = await request.post(`/api/v1/spaces/${space?.id}/members`, {
      headers,
      data: { userId: managerId, role: 'viewer' },
    })
    expect(member.ok(), await member.text()).toBeTruthy()

    // Объекты в трёх областях; политика «только Хатлон» для руководителя
    const created = await request.post('/api/v1/datasets', {
      headers,
      data: {
        name: `Объекты по областям ${run}`,
        spaceId: space?.id,
        fields: [
          { key: 'name', label: { ru: 'Название' }, type: 'text' },
          { key: 'region', label: { ru: 'Область' }, type: 'text', semantic: 'category' },
          { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
        ],
      },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const datasetId = (await created.json()).id as string
    const points: Array<[string, string, number, number]> = [
      [`Бохтар ${run}`, 'Хатлон', 68.78, 37.83],
      [`Куляб ${run}`, 'Хатлон', 69.78, 37.91],
      [`Худжанд ${run}`, 'Согд', 69.62, 40.28],
      [`Хорог ${run}`, 'ГБАО', 71.55, 37.49],
    ]
    const inserted = await request.post(`/api/v1/datasets/${datasetId}/rows`, {
      headers,
      data: {
        rows: points.map(([name, region, lon, lat]) => ({
          values: { name, region, place: { type: 'Point', coordinates: [lon, lat] } },
        })),
      },
    })
    expect(inserted.ok(), await inserted.text()).toBeTruthy()
    const policy = await request.post(`/api/v1/datasets/${datasetId}/policies/rows`, {
      headers,
      data: {
        principal: { type: 'user', id: managerId },
        filter: { field: 'region', op: 'eq', value: 'Хатлон' },
        note: 'Только своя область',
      },
    })
    expect(policy.ok(), await policy.text()).toBeTruthy()

    // Слой без кластеров с подписью по названию — названия едут в тайле
    const layer = await request.post('/api/v1/gis/layers', {
      headers,
      data: {
        name: `Объекты ${run}`,
        spaceId: space?.id,
        datasetId,
        style: {
          version: 1,
          geometry: 'point',
          renderer: { kind: 'simple' },
          label: { field: 'name' },
          cluster: null,
        },
      },
    })
    expect(layer.ok(), await layer.text()).toBeTruthy()
    const layerId = (await layer.json()).id as string
    const map = await request.post('/api/v1/gis/maps', {
      headers,
      data: {
        name: `Обстановка ${run}`,
        spaceId: space?.id,
        spec: { layers: [{ layerId }], camera: { center: [70, 38.7], zoom: 6 } },
      },
    })
    expect(map.ok(), await map.text()).toBeTruthy()
    const mapId = (await map.json()).id as string

    // Администратор: все четыре объекта в тайлах z6 страны
    const adminNames = new Set<string>()
    for (const [x, y] of [
      [43, 24],
      [44, 24],
      [44, 25],
      [43, 25],
    ]) {
      const tile = await request.get(`/api/v1/gis/layers/${layerId}/tiles/6/${x}/${y}.pbf`, {
        headers: { 'accept-encoding': 'identity' },
      })
      if (tile.status() !== 200) continue
      for (const name of tileNames(await tile.body(), tile.headers()['content-encoding'])) {
        adminNames.add(name)
      }
    }
    expect([...adminNames].sort()).toEqual(points.map(([name]) => name).sort())

    // Руководитель открывает карту в своём браузере: собираем пришедшие тайлы слоя
    const context = await browser.newContext({ baseURL })
    const login = await context.request.post('/api/v1/auth/login', {
      data: { login: MANAGER_LOGIN, password: MANAGER_PASSWORD, rememberDevice: false },
    })
    expect(login.ok(), await login.text()).toBeTruthy()
    const page = await context.newPage()
    const seen = new Set<string>()
    let tiles = 0
    page.on('response', async (response) => {
      if (!response.url().includes(`/gis/layers/${layerId}/tiles/`) || response.status() !== 200) {
        return
      }
      tiles++
      const body = await response.body().catch(() => null)
      // Браузер отдаёт тело уже распакованным
      if (body) for (const name of tileNames(body, undefined)) seen.add(name)
    })
    await page.goto(`/o/${mapId}`)
    await expect(
      page.getByRole('checkbox', { name: `Показывать слой «Объекты ${run}»` }),
    ).toBeChecked({
      timeout: 20_000,
    })
    await expect.poll(() => tiles, { timeout: 20_000 }).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Показать всё' }).click()
    await page.waitForTimeout(2000)
    expect([...seen].sort()).toEqual([`Бохтар ${run}`, `Куляб ${run}`])

    // Прямой запрос тайла Худжанда — пусто: чужих геометрий нет даже по адресу
    const north = await context.request.get(
      `/api/v1/gis/layers/${layerId}/tiles/${tileOf(69.62, 40.28, 10)}.pbf`,
    )
    expect(north.status()).toBe(204)
    await context.close()
  })
})
