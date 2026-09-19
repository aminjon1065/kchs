import { gunzipSync } from 'node:zlib'
import { classify } from '@kchs/map-style'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { LAYER_STATS_SAMPLE } from '../src/modules/gis/domain/layer-stats.js'
import { call, db, registerLifecycle, setupFixture, type TestContext } from './helpers.js'
import { decodeMvt, type MvtFeature } from './mvt.js'

/**
 * Редактор стиля слоя (P2-E01 S03, ADR-0075): статистика поля для классов и
 * диапазонов — по всем строкам слоя с политиками смотрящего; предпросмотр
 * рабочей копии стиля в тайлах; сохранение стиля — право правки слоя.
 */
registerLifecycle()

let fx: TestContext
let datasetId: string
let layerId: string
const run = Date.now().toString(36)

const point = (lon: number, lat: number) => ({ type: 'Point', coordinates: [lon, lat] })

/** Весь Таджикистан на z6 — один тайл (запад Согда вне его, здесь не нужен). */
const TJ = { z: 6, x: 44, y: 24 }

/** Строки «Объектов»: район, вид, мест, площадь, секрет, место. */
const ROWS = [
  ['A-1', 'Душанбе', 'school', 10, 2, 1, point(68.78, 38.56)],
  ['A-2', 'Хатлон', 'hospital', 20, 4, 2, point(68.78, 37.83)],
  ['A-3', 'Хатлон', 'school', 30, 0, 3, point(69.78, 37.91)],
  ['A-4', 'Хатлон', 'school', 45, 5, 4, point(69.2, 37.6)],
  ['A-5', 'ГБАО', 'school', 50, 10, 5, point(71.55, 37.49)],
  ['A-6', 'Душанбе', 'hospital', 60, 3, 6, point(68.8, 38.58)],
  ['A-7', 'ГБАО', 'hospital', 70, 7, 7, point(71.4, 37.3)],
  ['A-8', 'ГБАО', 'school', null, 1, 8, point(71.3, 37.4)],
] as const

const amounts: number[] = ROWS.flatMap((row) => (row[3] === null ? [] : [row[3] as number]))

const stats = (payload: Record<string, unknown>, as = fx.admin, layer = layerId) =>
  call(fx.app, { method: 'POST', url: `/gis/layers/${layer}/stats`, as, payload })

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

async function tile(query: string, as = fx.admin) {
  const response = await call(fx.app, {
    url: `/gis/layers/${layerId}/tiles/${TJ.z}/${TJ.x}/${TJ.y}.pbf${query ? `?${query}` : ''}`,
    as,
    headers: { 'accept-encoding': 'gzip' },
  })
  const raw = (response as unknown as { rawPayload: Buffer }).rawPayload
  const features: MvtFeature[] =
    response.statusCode === 200
      ? (decodeMvt(response.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw)[0]
          ?.features ?? [])
      : []
  return { response, features }
}

async function savedStyle(): Promise<Record<string, unknown>> {
  const record = await call(fx.app, { url: `/gis/layers/${layerId}`, as: fx.admin })
  return record.json().style
}

beforeAll(async () => {
  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Объекты стиля ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'kind', label: { ru: 'Вид' }, type: 'text', semantic: 'category' },
        { key: 'amount', label: { ru: 'Мест' }, type: 'integer', semantic: 'measure' },
        { key: 'area', label: { ru: 'Площадь' }, type: 'number', semantic: 'measure' },
        { key: 'secret', label: { ru: 'Секрет' }, type: 'number', semantic: 'measure' },
        { key: 'location', label: { ru: 'Место' }, type: 'geometry' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id
  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: {
      rows: ROWS.map(([code, district, kind, amount, area, secret, location]) => ({
        values: { code, district, kind, amount, area, secret, location },
      })),
    },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
  const layer = await call(fx.app, {
    method: 'POST',
    url: '/gis/layers',
    as: fx.admin,
    payload: { name: 'Объекты', spaceId: fx.spaceId, datasetId },
  })
  expect(layer.statusCode, layer.body).toBe(200)
  layerId = layer.json().id
})

describe('статистика поля слоя', () => {
  it('диапазон: все строки слоя, пустые — отдельно, без метода — без границ', async () => {
    const response = await stats({ field: 'amount' })
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({
      field: 'amount',
      normalizeBy: null,
      count: 8,
      nulls: 1,
      min: 10,
      max: 70,
      breaks: null,
      method: null,
      classes: null,
      sample: null,
    })
    expect(body.mean).toBeCloseTo(amounts.reduce((a, b) => a + b, 0) / amounts.length, 9)
    const mean = body.mean as number
    const variance = amounts.reduce((sum, v) => sum + (v - mean) ** 2, 0) / amounts.length
    expect(body.stddev).toBeCloseTo(Math.sqrt(variance), 6)
  })

  it('границы классов — те же, что у компилятора стилей по всем значениям', async () => {
    for (const method of ['equal', 'quantile', 'jenks', 'log', 'stddev'] as const) {
      const response = await stats({ field: 'amount', method, classes: 4 })
      expect(response.statusCode, response.body).toBe(200)
      const breaks = response.json().breaks as number[]
      const expected = classify(amounts, method, 4)
      expect(breaks.length, method).toBe(expected.length)
      for (const [index, edge] of breaks.entries()) {
        expect(edge, method).toBeCloseTo(expected[index] as number, 6)
      }
      expect(response.json()).toMatchObject({ method, classes: 4, sample: null })
    }
  })

  it('нормализация: деление на поле, нулевой делитель — пусто', async () => {
    const response = await stats({ field: 'amount', normalizeBy: 'area', method: 'equal' })
    expect(response.statusCode, response.body).toBe(200)
    // 10/2, 20/4, 30/0 → пусто, 45/5, 50/10, 60/3, 70/7, пусто/1
    expect(response.json()).toMatchObject({ count: 8, nulls: 2, min: 5, max: 20 })
    expect(response.json().breaks).toEqual([5, 8, 11, 14, 17, 20])
  })

  it('фильтр: сохранённый фильтр слоя по умолчанию, рабочая копия — явно', async () => {
    const style = await savedStyle()
    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/layers/${layerId}`,
      as: fx.admin,
      payload: { style: { ...style, filter: { field: 'amount', op: 'gte', value: 30 } } },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    const saved = await stats({ field: 'amount' })
    expect(saved.json()).toMatchObject({ count: 5, min: 30, max: 70 })
    const draft = await stats({
      field: 'amount',
      filter: { field: 'kind', op: 'eq', value: 'hospital' },
    })
    expect(draft.json()).toMatchObject({ count: 3, min: 20, max: 70 })
    const all = await stats({ field: 'amount', filter: null })
    expect(all.json()).toMatchObject({ count: 8, min: 10 })
    await call(fx.app, {
      method: 'PATCH',
      url: `/gis/layers/${layerId}`,
      as: fx.admin,
      payload: { style: { ...style, filter: null } },
    })
  })

  it('проверки поля: не число и неизвестное поле — 400', async () => {
    expect((await stats({ field: 'district' })).statusCode).toBe(400)
    expect((await stats({ field: 'nope' })).statusCode).toBe(400)
    expect((await stats({ field: 'amount', method: 'manual' })).statusCode).toBe(400)
  })

  it('политика строк: читатель получает границы по своим строкам, кэш разделён', async () => {
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
    const viewer = await stats({ field: 'amount', method: 'quantile', classes: 3 }, fx.users.viewer)
    expect(viewer.statusCode, viewer.body).toBe(200)
    // Хатлон: 20, 30, 45 — чужие 10…70 не видны ни в диапазоне, ни в границах
    expect(viewer.json()).toMatchObject({ count: 3, nulls: 0, min: 20, max: 45 })
    expect(viewer.json().breaks).toEqual(classify([20, 30, 45], 'quantile', 3))
    const admin = await stats({ field: 'amount', method: 'quantile', classes: 3 })
    expect(admin.json()).toMatchObject({ count: 8, min: 10, max: 70 })
  })

  it('политика столбцов: скрытое поле — как несуществующее', async () => {
    const hidden = await call(fx.app, {
      method: 'POST',
      url: `/datasets/${datasetId}/policies/columns`,
      as: fx.admin,
      payload: {
        principal: { type: 'user', id: fx.users.viewer.id },
        fields: ['secret'],
        mode: 'hide',
      },
    })
    expect(hidden.statusCode, hidden.body).toBe(200)
    const denied = await stats({ field: 'secret' }, fx.users.viewer)
    expect(denied.statusCode).toBe(400)
    const admin = await stats({ field: 'secret' })
    expect(admin.json()).toMatchObject({ min: 1, max: 8 })
  })

  it('права на слой не открывают данные: без доступа к датасету — 404', async () => {
    const granted = await call(fx.app, {
      method: 'POST',
      url: `/objects/${layerId}/access`,
      as: fx.admin,
      payload: {
        grants: [{ principal: { type: 'user', id: fx.users.stranger.id }, level: 'view' }],
      },
    })
    expect(granted.statusCode, granted.body).toBe(200)
    const denied = await stats({ field: 'amount' }, fx.users.stranger)
    expect(denied.statusCode).toBe(404)
  })
})

describe('сохранение стиля', () => {
  it('читатель слоя не сохраняет стиль, редактор пространства — сохраняет с событием', async () => {
    const style = await savedStyle()
    const categorized = {
      ...style,
      renderer: {
        kind: 'categorized',
        field: 'kind',
        categories: [
          { value: 'school', color: 'categorical.1' },
          { value: 'hospital', color: 'categorical.2', icon: 'hospital' },
        ],
        other: { color: 'other' },
      },
    }
    const denied = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/layers/${layerId}`,
      as: fx.users.viewer,
      payload: { style: categorized },
    })
    expect(denied.statusCode, denied.body).toBe(403)

    const saved = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/layers/${layerId}`,
      as: fx.users.member,
      payload: { style: categorized },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json().style.renderer).toMatchObject({ kind: 'categorized', field: 'kind' })

    const events = await db().execute<{ actor: string; payload: Record<string, unknown> }>(
      sql`SELECT event->'actor'->>'userId' AS actor, event->'payload' AS payload FROM ops.outbox
           WHERE type = 'layer.style_changed' AND event->'object'->>'id' = ${layerId}
           ORDER BY id DESC LIMIT 1`,
    )
    expect(events[0]?.payload).toEqual({ changed: ['style'] })
    expect(events[0]?.actor).toBe(fx.users.member.id)

    // Поле стиля должно быть полем датасета: опечатку сервер не сохраняет
    const broken = await call(fx.app, {
      method: 'PATCH',
      url: `/gis/layers/${layerId}`,
      as: fx.users.member,
      payload: { style: { ...categorized, renderer: { ...categorized.renderer, field: 'knd' } } },
    })
    expect(broken.statusCode).toBe(400)
  })
})

describe('предпросмотр рабочей копии стиля в тайлах', () => {
  it('поля и кластеры рабочей копии вместо сохранённых; сохранённый стиль не меняется', async () => {
    const style = await savedStyle()
    await call(fx.app, {
      method: 'PATCH',
      url: `/gis/layers/${layerId}`,
      as: fx.admin,
      payload: {
        style: { ...style, renderer: { kind: 'simple', color: 'categorical.1' } },
      },
    })
    const plain = await tile('')
    expect(plain.response.statusCode, plain.response.body).toBe(200)
    // Сохранённый стиль — простой с кластерами: на z6 только скопления без полей
    expect(plain.features.some((feature) => 'point_count' in feature.properties)).toBe(true)
    expect(plain.features.every((feature) => !('district' in feature.properties))).toBe(true)

    const preview = encode({
      fields: ['district'],
      filter: null,
      cluster: null,
      minZoom: 0,
      maxZoom: 22,
      time: null,
    })
    const draft = await tile(`p=${preview}`)
    expect(draft.response.statusCode, draft.response.body).toBe(200)
    expect(draft.features).toHaveLength(8)
    expect(draft.features.every((feature) => typeof feature.properties.district === 'string')).toBe(
      true,
    )
    expect(draft.features.every((feature) => !('point_count' in feature.properties))).toBe(true)
    expect(draft.response.headers.etag).not.toBe(plain.response.headers.etag)
    expect((await savedStyle()).renderer).toEqual({
      kind: 'simple',
      color: 'categorical.1',
      icon: null,
    })
  })

  it('фильтр рабочей копии заменяет фильтр слоя; политики смотрящего остаются', async () => {
    const style = await savedStyle()
    await call(fx.app, {
      method: 'PATCH',
      url: `/gis/layers/${layerId}`,
      as: fx.admin,
      payload: { style: { ...style, filter: { field: 'kind', op: 'eq', value: 'hospital' } } },
    })
    const base = { fields: ['code'], cluster: null, minZoom: 0, maxZoom: 22, time: null }
    const saved = await tile(
      `p=${encode({ ...base, filter: { field: 'kind', op: 'eq', value: 'hospital' } })}`,
    )
    expect(saved.features.map((feature) => feature.properties.code).sort()).toEqual([
      'A-2',
      'A-6',
      'A-7',
    ])
    const widened = await tile(`p=${encode({ ...base, filter: null })}`)
    expect(widened.features).toHaveLength(8)
    // Читатель с политикой «Хатлон» и скрытым секретом: свои строки, без скрытого поля
    const viewer = await tile(
      `p=${encode({ ...base, fields: ['code', 'secret'], filter: null })}`,
      fx.users.viewer,
    )
    expect(viewer.features.map((feature) => feature.properties.code).sort()).toEqual([
      'A-2',
      'A-3',
      'A-4',
    ])
    expect(viewer.features.every((feature) => !('secret' in feature.properties))).toBe(true)
    await call(fx.app, {
      method: 'PATCH',
      url: `/gis/layers/${layerId}`,
      as: fx.admin,
      payload: { style: { ...style, filter: null } },
    })
  })

  it('объекты GeoJSON — с полями предпросмотра; испорченный предпросмотр — 400', async () => {
    const preview = encode({
      fields: ['area'],
      filter: null,
      cluster: null,
      minZoom: 0,
      maxZoom: 22,
      time: null,
    })
    const features = await call(fx.app, {
      url: `/gis/layers/${layerId}/features?p=${preview}`,
      as: fx.admin,
    })
    expect(features.statusCode, features.body).toBe(200)
    expect(features.json().features[0].properties).toHaveProperty('area')
    const broken = await tile('p=not-a-preview')
    expect(broken.response.statusCode).toBe(400)
    const unknown = await tile(`p=${encode({ fields: ['Bad Field'] })}`)
    expect(unknown.response.statusCode).toBe(400)
  })
})

describe('крупный слой', () => {
  it('квантили и естественные границы — по выборке строк, края — точные', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: `Крупный слой ${run}`,
        spaceId: fx.spaceId,
        fields: [
          { key: 'value', label: { ru: 'Значение' }, type: 'integer', semantic: 'measure' },
          { key: 'place', label: { ru: 'Место' }, type: 'geometry' },
        ],
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const bigId = created.json().id
    const total = LAYER_STATS_SAMPLE + 500
    for (let start = 1; start <= total; start += 1000) {
      const rows = Array.from({ length: Math.min(1000, total - start + 1) }, (_, i) => ({
        values: { value: start + i, place: point(69 + ((start + i) % 100) / 100, 38.5) },
      }))
      const inserted = await call(fx.app, {
        method: 'POST',
        url: `/datasets/${bigId}/rows`,
        as: fx.admin,
        payload: { rows },
      })
      expect(inserted.statusCode, inserted.body).toBe(200)
    }
    const layer = await call(fx.app, {
      method: 'POST',
      url: '/gis/layers',
      as: fx.admin,
      payload: { name: 'Крупный', spaceId: fx.spaceId, datasetId: bigId },
    })
    const response = await stats(
      { field: 'value', method: 'quantile', classes: 4 },
      fx.admin,
      layer.json().id,
    )
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({ count: total, min: 1, max: total, sample: LAYER_STATS_SAMPLE })
    const [, q1, q2, q3] = body.breaks as number[]
    // Квантили выборки 10 000 из 10 500 — в пределах 3 % ранга от точных
    expect(Math.abs((q1 as number) - total / 4)).toBeLessThan(total * 0.03)
    expect(Math.abs((q2 as number) - total / 2)).toBeLessThan(total * 0.03)
    expect(Math.abs((q3 as number) - (total * 3) / 4)).toBeLessThan(total * 0.03)
    // Повтор — из кэша: та же выборка, те же границы
    const again = await stats(
      { field: 'value', method: 'quantile', classes: 4 },
      fx.admin,
      layer.json().id,
    )
    expect(again.json().breaks).toEqual(body.breaks)
  }, 120_000)
})
