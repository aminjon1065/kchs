import { gunzipSync } from 'node:zlib'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'
import { decodeMvt, type MvtFeature } from './mvt.js'

/**
 * Слои, карты и векторные тайлы (07-gis-engine.md §1–4, ADR-0064): слой —
 * объект реестра над датасетом; тайлы и объекты читаются через компилятор с
 * политиками строк и столбцов смотрящего; кэш — по версии данных и слоя.
 */
registerLifecycle()

let fx: TestContext
let datasetId: string
let zonesId: string
let layerId: string
const run = Date.now().toString(36)

const point = (lon: number, lat: number) => ({ type: 'Point', coordinates: [lon, lat] })

/** Тайл XYZ, содержащий точку. */
function tileOf(lon: number, lat: number, z: number): { z: number; x: number; y: number } {
  const n = 2 ** z
  const rad = (lat * Math.PI) / 180
  return {
    z,
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  }
}

async function tile(
  layer: string,
  at: { z: number; x: number; y: number },
  options: { as?: TestContext['admin']; query?: string; headers?: Record<string, string> } = {},
) {
  const response = await call(fx.app, {
    url: `/gis/layers/${layer}/tiles/${at.z}/${at.x}/${at.y}.pbf${options.query ? `?${options.query}` : ''}`,
    as: options.as ?? fx.admin,
    headers: { 'accept-encoding': 'gzip', ...options.headers },
  })
  const raw = (response as unknown as { rawPayload: Buffer }).rawPayload
  const features: MvtFeature[] =
    response.statusCode === 200
      ? (decodeMvt(response.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw)[0]
          ?.features ?? [])
      : []
  return { response, features }
}

const codes = (features: MvtFeature[]) =>
  features.map((feature) => feature.properties.name as string).sort()

const patchLayer = (payload: Record<string, unknown>, as = fx.admin) =>
  call(fx.app, { method: 'PATCH', url: `/gis/layers/${layerId}`, as, payload })

/** Весь Таджикистан на z6 умещается в один тайл, кроме запада Согда. */
const TJ = tileOf(69.5, 38.5, 6)

beforeAll(async () => {
  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Объекты защиты ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'name', label: { ru: 'Название' }, type: 'text' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'kind', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
        { key: 'amount', label: { ru: 'Мест' }, type: 'number', semantic: 'measure' },
        { key: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
        { key: 'phone', label: { ru: 'Телефон' }, type: 'text' },
        { key: 'location', label: { ru: 'Место' }, type: 'geometry' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id
  const rows = [
    ['A-1', 'Душанбе', 'Душанбе', 'school', 10, '2026-03-01', point(68.78, 38.56)],
    ['A-2', 'Бохтар', 'Хатлон', 'hospital', 20, '2026-03-05', point(68.78, 37.83)],
    ['A-3', 'Куляб', 'Хатлон', 'school', 30, '2026-04-01', point(69.78, 37.91)],
    ['A-4', 'Худжанд', 'Согд', 'hospital', 40, '2026-04-10', point(69.62, 40.28)],
    ['A-5', 'Хорог', 'ГБАО', 'school', 50, '2026-05-01', point(71.55, 37.49)],
    ['A-6', 'Без места', 'Согд', 'school', 60, '2026-05-02', null],
  ] as const
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: {
      rows: rows.map(([code, name, district, kind, amount, day, location]) => ({
        values: { code, name, district, kind, amount, day, phone: '+992900000000', location },
      })),
    },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)

  const zones = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Зоны риска ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'title', label: { ru: 'Зона' }, type: 'text' },
        { key: 'level', label: { ru: 'Уровень' }, type: 'integer' },
        { key: 'area', label: { ru: 'Контур' }, type: 'geometry' },
      ],
    },
  })
  expect(zones.statusCode, zones.body).toBe(200)
  zonesId = zones.json().id
  const square = (lon: number, lat: number, size: number) => ({
    type: 'Polygon',
    coordinates: [
      [
        [lon, lat],
        [lon + size, lat],
        [lon + size, lat + size],
        [lon, lat + size],
        [lon, lat],
      ],
    ],
  })
  const zoneRows = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${zonesId}/rows`,
    as: fx.admin,
    payload: {
      rows: [
        { values: { title: 'Сель', level: 3, area: square(69, 38.5, 0.5) } },
        { values: { title: 'Оползень', level: 2, area: square(70.5, 39, 0.3) } },
      ],
    },
  })
  expect(zoneRows.statusCode, zoneRows.body).toBe(200)
})

describe('слой', () => {
  it('создание: объект реестра, стиль по умолчанию, зависимость и событие', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/layers',
      as: fx.admin,
      payload: { name: 'Объекты защиты', spaceId: fx.spaceId, datasetId },
    })
    expect(created.statusCode, created.body).toBe(200)
    layerId = created.json().id

    const record = await call(fx.app, { url: `/gis/layers/${layerId}`, as: fx.admin })
    expect(record.statusCode, record.body).toBe(200)
    expect(record.json()).toMatchObject({
      name: 'Объекты защиты',
      datasetId,
      geometryField: 'location',
      geometryType: 'point',
      dataAccess: true,
      featureCount: 6,
      style: { geometry: 'point', renderer: { kind: 'simple' }, cluster: { enabled: true } },
      tileFields: [],
    })
    const [west, south, east, north] = record.json().extent as number[]
    expect(west).toBeCloseTo(68.78, 2)
    expect(south).toBeCloseTo(37.49, 2)
    expect(east).toBeCloseTo(71.55, 2)
    expect(north).toBeCloseTo(40.28, 2)

    const summary = await call(fx.app, { url: `/objects/${layerId}`, as: fx.admin })
    expect(summary.statusCode, summary.body).toBe(200)
    expect(summary.json()).toMatchObject({ type: 'layer', title: 'Объекты защиты' })

    const events = await db().execute<{ payload: Record<string, unknown> }>(
      sql`SELECT event->'payload' AS payload FROM ops.outbox
           WHERE type = 'layer.published' AND event->'object'->>'id' = ${layerId}`,
    )
    expect(events.map((row) => row.payload)).toEqual([{ datasetId, geometryType: 'point' }])

    const listed = await call(fx.app, {
      url: `/gis/layers?datasetId=${datasetId}`,
      as: fx.users.viewer,
    })
    expect(listed.statusCode, listed.body).toBe(200)
    expect(listed.json().items).toEqual([{ id: layerId, name: 'Объекты защиты' }])
  })

  it('проверки: поле стиля из датасета, датасет с геометрией, права на пространство', async () => {
    const missing = await call(fx.app, {
      method: 'POST',
      url: '/gis/layers',
      as: fx.admin,
      payload: {
        name: 'Ошибка',
        spaceId: fx.spaceId,
        datasetId,
        style: {
          version: 1,
          geometry: 'point',
          renderer: { kind: 'categorized', field: 'nope', categories: [] },
        },
      },
    })
    expect(missing.statusCode, missing.body).toBe(400)
    expect(missing.json().detail).toContain('nope')

    const noGeometry = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: `Без геометрии ${run}`,
        spaceId: fx.spaceId,
        fields: [{ key: 'title', label: { ru: 'Название' }, type: 'text' }],
      },
    })
    const plain = await call(fx.app, {
      method: 'POST',
      url: '/gis/layers',
      as: fx.admin,
      payload: { name: 'Нет места', spaceId: fx.spaceId, datasetId: noGeometry.json().id },
    })
    expect(plain.statusCode, plain.body).toBe(400)

    // Читатель пространства не создаёт объекты в нём
    const denied = await call(fx.app, {
      method: 'POST',
      url: '/gis/layers',
      as: fx.users.viewer,
      payload: { name: 'Чужой', spaceId: fx.spaceId, datasetId },
    })
    expect(denied.statusCode, denied.body).toBe(403)
  })

  it('полигоны: тип по данным, тайл с упрощением', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/layers',
      as: fx.admin,
      payload: { name: 'Зоны риска', spaceId: fx.spaceId, datasetId: zonesId },
    })
    expect(created.statusCode, created.body).toBe(200)
    const zonesLayer = created.json().id
    const record = await call(fx.app, { url: `/gis/layers/${zonesLayer}`, as: fx.admin })
    expect(record.json()).toMatchObject({
      geometryType: 'polygon',
      style: { geometry: 'polygon', cluster: null },
    })
    const { response, features } = await tile(zonesLayer, TJ)
    expect(response.statusCode, response.body).toBe(200)
    expect(features).toHaveLength(2)
    // Тип геометрии MVT: 3 — полигон
    expect(features.every((feature) => feature.type === 3)).toBe(true)
  })
})

describe('тайлы', () => {
  it('кластеры на мелком масштабе: point_count, сумма — все строки с геометрией', async () => {
    const { response, features } = await tile(layerId, TJ)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-type']).toBe('application/vnd.mapbox-vector-tile')
    expect(response.headers['cache-control']).toBe('private, max-age=300')
    expect(features.length).toBeGreaterThan(0)
    const total = features.reduce((sum, feature) => sum + Number(feature.properties.point_count), 0)
    expect(total).toBe(5)
  })

  it('без кластеров: строки с полями стиля, лишних полей в тайле нет', async () => {
    const patched = await patchLayer({
      style: {
        version: 1,
        geometry: 'point',
        renderer: {
          kind: 'categorized',
          field: 'kind',
          categories: [
            { value: 'school', color: 'categorical.1' },
            { value: 'hospital', color: 'categorical.2' },
          ],
        },
        label: { field: 'name' },
        popup: { title: '{{name}}', fields: ['district', 'phone'], actions: ['open'] },
        time: { field: 'day' },
      },
      tileFields: ['amount'],
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(patched.json().version).toBeGreaterThan(1)

    const { response, features } = await tile(layerId, TJ)
    expect(response.statusCode, response.body).toBe(200)
    expect(codes(features)).toEqual(['Бохтар', 'Душанбе', 'Куляб', 'Хорог', 'Худжанд'])
    const dushanbe = features.find((feature) => feature.properties.name === 'Душанбе')
    // Поля стиля, подписи, времени и тайла; карточка (district, phone) — по щелчку
    expect(Object.keys(dushanbe?.properties ?? {}).sort()).toEqual([
      'amount',
      'day',
      'kind',
      'name',
    ])
    expect(dushanbe?.properties.amount).toBe(10)
    expect(dushanbe?.properties.day).toBe(Date.parse('2026-03-01T00:00:00Z'))
    expect(typeof dushanbe?.id).toBe('number')

    const events = await db().execute<{ payload: Record<string, unknown> }>(
      sql`SELECT event->'payload' AS payload FROM ops.outbox
           WHERE type = 'layer.style_changed' AND event->'object'->>'id' = ${layerId}`,
    )
    expect(events.map((row) => row.payload)).toEqual([{ changed: ['style', 'tileFields'] }])
  })

  it('кэш: повтор — из Redis, ETag — 304, новая версия данных — новый тайл', async () => {
    const first = await tile(layerId, TJ)
    const second = await tile(layerId, TJ)
    expect(second.response.headers['server-timing']).toBe('cache;desc=hit')
    expect(second.response.headers.etag).toBe(first.response.headers.etag)
    const notModified = await tile(layerId, TJ, {
      headers: { 'if-none-match': String(first.response.headers.etag) },
    })
    expect(notModified.response.statusCode).toBe(304)

    const added = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/rows`,
      as: fx.admin,
      payload: {
        rows: [
          {
            values: {
              code: 'A-7',
              name: 'Исфара',
              district: 'Согд',
              kind: 'school',
              amount: 70,
              day: '2026-05-03',
              location: point(70.63, 39.84),
            },
          },
        ],
      },
    })
    expect(added.statusCode, added.body).toBe(200)
    const fresh = await tile(layerId, TJ)
    expect(fresh.response.headers.etag).not.toBe(first.response.headers.etag)
    expect(codes(fresh.features)).toContain('Исфара')
  })

  it('фильтр карты и время: условия поверх фильтра слоя', async () => {
    const filter = Buffer.from(
      JSON.stringify({ field: 'kind', op: 'eq', value: 'hospital' }),
    ).toString('base64url')
    const hospitals = await tile(layerId, TJ, { query: `f=${filter}` })
    expect(hospitals.response.statusCode, hospitals.response.body).toBe(200)
    expect(codes(hospitals.features)).toEqual(['Бохтар', 'Худжанд'])

    const spring = await tile(layerId, TJ, { query: 't=2026-03-01/2026-03-31' })
    expect(codes(spring.features)).toEqual(['Бохтар', 'Душанбе'])

    const broken = await tile(layerId, TJ, { query: 'f=not-a-filter' })
    expect(broken.response.statusCode).toBe(400)

    // Фильтр слоя сужает всё, что видит карта
    await patchLayer({
      style: {
        ...(await call(fx.app, { url: `/gis/layers/${layerId}`, as: fx.admin })).json().style,
        filter: { field: 'amount', op: 'gte', value: 30 },
      },
    })
    const filtered = await tile(layerId, TJ)
    expect(codes(filtered.features)).toEqual(['Исфара', 'Куляб', 'Хорог', 'Худжанд'])
    await patchLayer({
      style: {
        ...(await call(fx.app, { url: `/gis/layers/${layerId}`, as: fx.admin })).json().style,
        filter: null,
      },
    })
  })

  it('вне масштабов слоя и вне сетки: пусто и 400', async () => {
    const outside = await tile(layerId, { z: 6, x: 0, y: 0 })
    expect(outside.response.statusCode).toBe(204)
    const invalid = await tile(layerId, { z: 2, x: 7, y: 1 })
    expect(invalid.response.statusCode).toBe(400)
  })
})

describe('права в тайлах (сценарий 7 фазы 2)', () => {
  it('политика строк: читатель получает только свои строки, чужих геометрий нет', async () => {
    const policy = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/rows`,
      as: fx.admin,
      payload: {
        principal: { type: 'user', id: fx.users.viewer.id },
        filter: { field: 'district', op: 'eq', value: 'Хатлон' },
      },
    })
    expect(policy.statusCode, policy.body).toBe(200)

    const viewer = await tile(layerId, TJ, { as: fx.users.viewer })
    expect(viewer.response.statusCode, viewer.response.body).toBe(200)
    expect(codes(viewer.features)).toEqual(['Бохтар', 'Куляб'])
    // Тайл Худжанда для читателя пуст: строка не видна и геометрия не отдаётся
    const north = await tile(layerId, tileOf(69.62, 40.28, 10), { as: fx.users.viewer })
    expect(north.response.statusCode).toBe(204)
    // Администратор видит тот же тайл целиком — кэш разделён по политикам
    const admin = await tile(layerId, tileOf(69.62, 40.28, 10))
    expect(codes(admin.features)).toEqual(['Худжанд'])

    // Объекты GeoJSON и карточка — те же политики
    const features = await call(fx.app, {
      url: `/gis/layers/${layerId}/features`,
      as: fx.users.viewer,
    })
    expect(features.statusCode, features.body).toBe(200)
    expect(
      features
        .json()
        .features.map((feature: { properties: { name: string } }) => feature.properties.name)
        .sort(),
    ).toEqual(['Бохтар', 'Куляб'])
    const khujandId = admin.features[0]?.id
    const card = await call(fx.app, {
      url: `/gis/layers/${layerId}/features/${khujandId}`,
      as: fx.users.viewer,
    })
    expect(card.statusCode).toBe(404)
  })

  it('политика столбцов: скрытое поле не попадает в тайл, скрытая геометрия — 403', async () => {
    const hidden = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/columns`,
      as: fx.admin,
      payload: {
        principal: { type: 'user', id: fx.users.viewer.id },
        fields: ['amount'],
        mode: 'hide',
      },
    })
    expect(hidden.statusCode, hidden.body).toBe(200)
    const viewer = await tile(layerId, TJ, { as: fx.users.viewer })
    expect(viewer.features.length).toBeGreaterThan(0)
    expect(viewer.features.every((feature) => !('amount' in feature.properties))).toBe(true)

    const geometry = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/columns`,
      as: fx.admin,
      payload: {
        principal: { type: 'user', id: fx.users.viewer.id },
        fields: ['location'],
        mode: 'hide',
      },
    })
    expect(geometry.statusCode, geometry.body).toBe(200)
    const denied = await tile(layerId, TJ, { as: fx.users.viewer })
    expect(denied.response.statusCode).toBe(403)
    await call(fx.app, {
      method: 'DELETE',
      url: `/datasets/${datasetId}/policies/columns/${geometry.json().id}`,
      as: fx.admin,
    })
  })

  it('права на слой не открывают данные: без доступа к датасету — «нет доступа»', async () => {
    const granted = await call(fx.app, {
      method: 'POST',
      url: `/objects/${layerId}/access`,
      as: fx.admin,
      payload: {
        grants: [{ principal: { type: 'user', id: fx.users.stranger.id }, level: 'view' }],
      },
    })
    expect(granted.statusCode, granted.body).toBe(200)
    const record = await call(fx.app, { url: `/gis/layers/${layerId}`, as: fx.users.stranger })
    expect(record.statusCode, record.body).toBe(200)
    expect(record.json()).toMatchObject({ dataAccess: false, extent: null, featureCount: 0 })
    const denied = await tile(layerId, TJ, { as: fx.users.stranger })
    expect(denied.response.statusCode).toBe(404)
    expect(denied.features).toEqual([])
  })

  it('чужой слой: 404, как для любого невидимого объекта', async () => {
    const outsider = await call(fx.app, { url: `/gis/layers/${zonesId}`, as: fx.users.stranger })
    expect(outsider.statusCode).toBe(404)
  })
})

describe('объекты GeoJSON', () => {
  it('охват, лимит и карточка объекта', async () => {
    const inBox = await call(fx.app, {
      url: `/gis/layers/${layerId}/features?bbox=68,37,70,38.7`,
      as: fx.admin,
    })
    expect(inBox.statusCode, inBox.body).toBe(200)
    const body = inBox.json()
    expect(body.truncated).toBe(false)
    expect(
      body.features
        .map((feature: { properties: { name: string } }) => feature.properties.name)
        .sort(),
    ).toEqual(['Бохтар', 'Душанбе', 'Куляб'])
    const first = body.features[0]
    expect(first.geometry).toMatchObject({ type: 'Point' })
    // Поля стиля и карточки: подпись, вид, район, телефон; геометрия — отдельно
    expect(Object.keys(first.properties)).toEqual(
      expect.arrayContaining(['_ver', 'name', 'kind', 'district', 'phone']),
    )
    expect(first.properties.location).toBeUndefined()

    const limited = await call(fx.app, {
      url: `/gis/layers/${layerId}/features?limit=2`,
      as: fx.admin,
    })
    expect(limited.json().features).toHaveLength(2)
    expect(limited.json().truncated).toBe(true)

    const card = await call(fx.app, {
      url: `/gis/layers/${layerId}/features/${first.id}`,
      as: fx.admin,
    })
    expect(card.statusCode, card.body).toBe(200)
    expect(card.json()).toMatchObject({
      id: first.id,
      geometry: { type: 'Point' },
      values: { phone: '+992900000000' },
    })

    const badBox = await call(fx.app, {
      url: `/gis/layers/${layerId}/features?bbox=70,37,68,38`,
      as: fx.admin,
    })
    expect(badBox.statusCode).toBe(400)
  })
})

describe('карта', () => {
  it('создание, чтение с экстентом слоёв, изменение и событие', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/gis/maps',
      as: fx.admin,
      payload: {
        name: 'Оперативная обстановка',
        spaceId: fx.spaceId,
        spec: { layers: [{ layerId }] },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const mapId = created.json().id

    const record = await call(fx.app, { url: `/gis/maps/${mapId}`, as: fx.users.viewer })
    expect(record.statusCode, record.body).toBe(200)
    expect(record.json()).toMatchObject({
      name: 'Оперативная обстановка',
      spec: {
        basemapId: null,
        camera: { center: [69, 38.6], zoom: 6 },
        layers: [{ layerId, visible: true, opacity: 1, group: null }],
      },
    })
    expect(record.json().extent).toHaveLength(4)

    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/maps/${mapId}`,
      as: fx.admin,
      payload: {
        spec: {
          ...record.json().spec,
          bookmarks: [
            { id: 'dushanbe', name: 'Душанбе', camera: { center: [68.78, 38.56], zoom: 11 } },
          ],
        },
      },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect(patched.json().spec.bookmarks).toHaveLength(1)

    const events = await db().execute<{ payload: Record<string, unknown> }>(
      sql`SELECT event->'payload' AS payload FROM ops.outbox
           WHERE type = 'map.updated' AND event->'object'->>'id' = ${mapId}`,
    )
    expect(events.map((row) => row.payload)).toEqual([{ changed: ['spec'] }])

    // Недоступный автору слой в карту не добавить
    const foreign = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/maps/${mapId}`,
      as: fx.admin,
      payload: {
        spec: { layers: [{ layerId: '00000000-0000-4000-8000-000000000000' }] },
      },
    })
    expect(foreign.statusCode).toBe(404)
  })
})
