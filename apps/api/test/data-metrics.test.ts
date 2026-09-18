import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { call, db, redis, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Показатели (P1-E06 S02, ADR-0058): значение, сравнения, пороги, цель, история
 * и разрез — одним путём для API, плитки дашборда и графика; с политиками
 * смотрящего. Точные ожидания — на фиксированных датах (не зависят от дня
 * прогона), относительный период — на строках, расставленных по окнам «сейчас».
 */
registerLifecycle()

const { metricWindows, fromWall, toWall } = await import(
  '../src/modules/data/domain/metric-period.js'
)
const { SpaceService } = await import('../src/kernel/spaces/service.js')
const { systemCtx } = await import('../src/shared/context.js')

const TZ = 'Asia/Dushanbe'
let fx: TestContext
let datasetId: string
const run = Date.now().toString(36)

/** Фиксированный набор: март 2026, окно сравнения до него, март 2025 и строки вне окон. */
const FIXED = [
  {
    code: 'F-1',
    district: 'Хатлон',
    damage: 100,
    at: '2026-03-05T10:00:00+05:00',
    day: '2026-03-05',
  },
  { code: 'F-2', district: 'Согд', damage: 50, at: '2026-03-20T10:00:00+05:00', day: '2026-03-20' },
  {
    code: 'F-3',
    district: 'Хатлон',
    damage: 10,
    at: '2026-03-31T23:30:00+05:00',
    day: '2026-03-31',
  },
  {
    code: 'F-4',
    district: 'Хатлон',
    damage: 40,
    at: '2026-02-10T10:00:00+05:00',
    day: '2026-02-10',
  },
  { code: 'F-5', district: 'ГБАО', damage: 5, at: '2026-01-28T10:00:00+05:00', day: '2026-01-28' },
  { code: 'F-6', district: 'Согд', damage: 30, at: '2025-03-10T10:00:00+05:00', day: '2025-03-10' },
  { code: 'F-7', district: 'Согд', damage: 7, at: '2025-04-01T00:30:00+05:00', day: '2025-04-01' },
]
const MARCH = { start: '2026-03-01', end: '2026-03-31' }

const fixed = { field: 'batch', op: 'eq', value: 'fixed' }
const relative = { field: 'batch', op: 'eq', value: 'relative' }

async function createMetric(payload: Record<string, unknown>, as = fx.admin) {
  return call(fx.app, {
    method: 'POST',
    url: '/metrics',
    as,
    payload: { spaceId: fx.spaceId, datasetId, ...payload },
  })
}

async function metricId(payload: Record<string, unknown>) {
  const response = await createMetric(payload)
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

const value = (id: string, payload: Record<string, unknown> = {}, as = fx.admin) =>
  call(fx.app, { method: 'POST', url: `/metrics/${id}/value`, as, payload })

async function dashboardWith(
  tiles: Array<Record<string, unknown>>,
  filters: unknown[] = [],
  spaceId = fx.spaceId,
) {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/dashboards',
    as: fx.admin,
    payload: {
      name: `Показатели ${run}`,
      spaceId,
      spec: {
        tiles: tiles.map((tile, index) => ({
          id: `t${index + 1}`,
          kind: 'metric',
          filterBindings: {},
          x: 0,
          y: index * 2,
          w: 3,
          h: 2,
          ...tile,
        })),
        filters,
      },
    },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

beforeAll(async () => {
  fx = await setupFixture()
  const created = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Показатели ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Код' }, type: 'identifier', semantic: 'identifier' },
        { key: 'batch', label: { ru: 'Набор' }, type: 'text', semantic: 'category' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'category' },
        { key: 'damage', label: { ru: 'Ущерб' }, type: 'number', semantic: 'measure' },
        { key: 'at', label: { ru: 'Когда' }, type: 'datetime', semantic: 'time' },
        { key: 'day', label: { ru: 'День' }, type: 'date' },
      ],
      primaryKey: ['code'],
      timeField: 'at',
    },
  })
  expect(created.statusCode, created.body).toBe(200)
  datasetId = created.json().id

  // Относительный набор: два случая в этом месяце, один — в том же отрезке прошлого,
  // один — раньше окна сравнения
  const now = new Date()
  const windows = metricWindows({ unit: 'month', from: 0, to: 0 }, 'previous_period', now, TZ)
  if (!windows.current || !windows.base) throw new Error('нет окон')
  const nowWall = toWall(now, TZ)
  const middle = (from: number, to: number) => fromWall(from + (to - from) / 2, TZ).toISOString()
  const relativeRows = [
    { code: 'R-1', at: middle(windows.current.from, nowWall) },
    { code: 'R-2', at: middle(windows.current.from, nowWall) },
    { code: 'R-3', at: middle(windows.base.from, windows.base.to) },
    { code: 'R-4', at: fromWall(windows.base.from - 86_400_000, TZ).toISOString() },
  ]

  const inserted = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: {
      rows: [
        ...FIXED.map((row) => ({ values: { ...row, batch: 'fixed' } })),
        ...relativeRows.map((row) => ({
          values: { ...row, batch: 'relative', district: 'Хатлон', damage: 1 },
        })),
      ],
    },
  })
  expect(inserted.statusCode, inserted.body).toBe(200)
})

describe('значение показателя', () => {
  let incidents: string

  beforeAll(async () => {
    incidents = await metricId({
      name: `Происшествия ${run}`,
      description: 'Число происшествий за период',
      definition: {
        measure: { agg: 'count' },
        filter: fixed,
        dimensions: ['district'],
        period: MARCH,
        comparison: 'previous_period',
      },
      direction: 'down',
      thresholds: [
        { value: 0, status: 'success' },
        { value: 3, status: 'warning' },
        { value: 5, status: 'danger' },
      ],
      targets: [{ value: 4 }],
    })
  })

  it('по умолчанию: период и сравнение показателя, порог, цель, дельта «хуже»', async () => {
    const response = await value(incidents)
    expect(response.statusCode, response.body).toBe(200)
    const body = response.json()
    expect(body).toMatchObject({
      name: `Происшествия ${run}`,
      period: MARCH,
      comparison: 'previous_period',
      value: 3,
      base: 1,
      target: 4,
      status: 'warning',
      delta: { absolute: 2, relative: 2, direction: 'up', good: false },
    })
    // Март по Душанбе: окно сравнения — 31 день до него, с 29 января
    expect(body.window).toEqual({
      from: '2026-02-28T19:00:00.000Z',
      to: '2026-03-31T19:00:00.000Z',
    })
    expect(body.baseWindow.from).toBe('2026-01-28T19:00:00.000Z')
    // История по дням марта, пустые дни — ноль
    expect(body.series).toHaveLength(31)
    expect(body.series.filter((point: { value: number }) => point.value > 0)).toEqual([
      { period: '2026-03-05', value: 1 },
      { period: '2026-03-20', value: 1 },
      { period: '2026-03-31', value: 1 },
    ])
  })

  it('год назад, цель, без сравнения; разрез по допустимым полям', async () => {
    const year = await value(incidents, { comparison: 'previous_year' })
    expect(year.json()).toMatchObject({ value: 3, base: 1, comparison: 'previous_year' })

    const target = await value(incidents, { comparison: 'target' })
    expect(target.json()).toMatchObject({
      base: 4,
      baseWindow: null,
      delta: { absolute: -1, direction: 'down', good: true },
    })

    const none = await value(incidents, { comparison: 'none', series: false })
    expect(none.json()).toMatchObject({ base: null, delta: null, series: [] })

    const split = await value(incidents, { dimensions: ['district'], series: false })
    expect(split.json().breakdown).toEqual([
      { values: { district: 'Хатлон' }, value: 2, base: 1 },
      { values: { district: 'Согд' }, value: 1, base: 0 },
    ])
    const forbidden = await value(incidents, { dimensions: ['code'] })
    expect(forbidden.statusCode).toBe(400)
  })

  it('мера-сумма, выражение и поле-дата дают те же окна', async () => {
    const damage = await metricId({
      name: `Ущерб ${run}`,
      definition: { measure: { agg: 'sum', field: 'damage' }, filter: fixed, period: MARCH },
      unit: 'сомони',
      format: { precision: 0 },
    })
    expect((await value(damage)).json()).toMatchObject({ value: 160, base: 40, unit: 'сомони' })

    const average = await metricId({
      name: `Средний ущерб ${run}`,
      definition: {
        measure: { agg: 'expr', expr: 'sum(damage) / count()' },
        filter: fixed,
        period: MARCH,
        comparison: 'none',
      },
    })
    expect((await value(average)).json().value).toBeCloseTo(160 / 3, 6)

    const byDay = await metricId({
      name: `По дате ${run}`,
      definition: { measure: { agg: 'count' }, filter: fixed, timeField: 'day', period: MARCH },
    })
    expect((await value(byDay)).json()).toMatchObject({ value: 3, base: 1 })
    const lastYear = await value(byDay, { comparison: 'previous_year' })
    expect(lastYear.json().base).toBe(1)
  })

  it('проверка определения компилятором: сумма по тексту, чужое поле, период без поля времени', async () => {
    const text = await createMetric({
      name: 'Сумма текста',
      definition: { measure: { agg: 'sum', field: 'district' }, period: MARCH },
    })
    expect(text.statusCode).toBe(400)
    const unknown = await createMetric({
      name: 'Неизвестное',
      definition: { measure: { agg: 'count' }, filter: { field: 'nope', op: 'eq', value: 1 } },
    })
    expect(unknown.statusCode).toBe(400)
    const dimension = await createMetric({
      name: 'Разрез',
      definition: { measure: { agg: 'count' }, dimensions: ['nope'] },
    })
    expect(dimension.statusCode).toBe(400)

    const plain = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: `Без времени ${run}`,
        spaceId: fx.spaceId,
        fields: [{ key: 'code', label: { ru: 'Код' }, type: 'identifier' }],
      },
    })
    const timeless = await call(fx.app, {
      method: 'POST',
      url: '/metrics',
      as: fx.admin,
      payload: {
        name: 'Без времени',
        spaceId: fx.spaceId,
        datasetId: plain.json().id,
        definition: { measure: { agg: 'count' } },
      },
    })
    expect(timeless.statusCode).toBe(400)
    expect(timeless.json().detail).toContain('поля времени')
    const allTime = await call(fx.app, {
      method: 'POST',
      url: '/metrics',
      as: fx.admin,
      payload: {
        name: 'За всё время',
        spaceId: fx.spaceId,
        datasetId: plain.json().id,
        definition: { measure: { agg: 'count' }, period: null },
      },
    })
    expect(allTime.statusCode, allTime.body).toBe(200)
    expect((await value(allTime.json().id)).json()).toMatchObject({ value: 0, series: [] })
  })

  it('правка — событие metric.updated; новый порог меняет статус', async () => {
    const patched = await call(fx.app, {
      method: 'PATCH',
      url: `/metrics/${incidents}`,
      as: fx.admin,
      payload: { thresholds: [{ value: 3, status: 'danger' }] },
    })
    expect(patched.statusCode, patched.body).toBe(200)
    expect((await value(incidents, { series: false })).json().status).toBe('danger')
    const events = await db().execute<{ payload: { changed: string[] } }>(
      sql`SELECT event->'payload' AS payload FROM ops.outbox
           WHERE type = 'metric.updated' AND event->'object'->>'id' = ${incidents}`,
    )
    expect(events.map((row) => row.payload.changed)).toEqual([['thresholds']])
  })
})

describe('одно значение везде', () => {
  it('API, плитка дашборда и запрос исследования совпадают на «этом месяце»', async () => {
    const monthly = await metricId({
      name: `За месяц ${run}`,
      definition: {
        measure: { agg: 'count' },
        filter: relative,
        period: { unit: 'month', from: 0, to: 0 },
        comparison: 'previous_period',
      },
    })
    const api = (await value(monthly)).json()
    expect(api.value).toBe(2)
    // В первую минуту месяца отрезок сравнения пуст — тогда база ноль
    expect([0, 1]).toContain(api.base)

    const dashboard = await dashboardWith([{ metricId: monthly }])
    const data = await call(fx.app, {
      method: 'POST',
      url: `/dashboards/${dashboard}/data`,
      as: fx.admin,
      payload: {},
    })
    expect(data.statusCode, data.body).toBe(200)
    expect(data.json().tiles.t1.metric).toMatchObject({ value: api.value, base: api.base })

    const explore = await call(fx.app, {
      method: 'POST',
      url: '/queries/run',
      as: fx.admin,
      payload: {
        spec: {
          version: 1,
          source: { kind: 'dataset', id: datasetId },
          steps: [
            {
              type: 'filter',
              where: {
                and: [
                  relative,
                  { field: 'at', op: 'relative', value: { unit: 'month', from: 0, to: 0 } },
                ],
              },
            },
            { type: 'aggregate', measures: [{ alias: 'value', agg: 'count' }] },
          ],
        },
      },
    })
    expect(explore.statusCode, explore.body).toBe(200)
    expect(explore.json().rows[0][0]).toBe(api.value)

    // График по показателю — его история по месяцам
    const chart = await call(fx.app, {
      method: 'POST',
      url: '/charts',
      as: fx.admin,
      payload: {
        name: `История ${run}`,
        spaceId: fx.spaceId,
        spec: {
          version: 1,
          type: 'line',
          data: { metricId: monthly },
          encoding: {
            x: { field: 'period', type: 'temporal' },
            y: [{ field: 'value', type: 'quantitative' }],
          },
        },
      },
    })
    expect(chart.statusCode, chart.body).toBe(200)
    const series = await call(fx.app, {
      method: 'POST',
      url: `/charts/${chart.json().id}/data`,
      as: fx.admin,
      payload: {},
    })
    expect(series.statusCode, series.body).toBe(200)
    expect(series.json().fields.map((field: { name: string }) => field.name)).toEqual([
      'period',
      'value',
    ])
    expect(series.json().rows.at(-1)[1]).toBe(api.value)
  })

  it('фильтр-период дашборда задаёт период плитки, остальные фильтры — условия', async () => {
    const incidents = await metricId({
      name: `С фильтрами ${run}`,
      definition: {
        measure: { agg: 'count' },
        filter: fixed,
        dimensions: ['district'],
        period: MARCH,
      },
    })
    const dashboard = await dashboardWith(
      [{ metricId: incidents, filterBindings: { f1: 'at', f2: 'district' } }],
      [
        { id: 'f1', kind: 'period', label: { ru: 'Период' } },
        { id: 'f2', kind: 'select', label: { ru: 'Район' } },
      ],
    )
    const tile = async (filters: Record<string, unknown>) => {
      const response = await call(fx.app, {
        method: 'POST',
        url: `/dashboards/${dashboard}/data`,
        as: fx.admin,
        payload: { filters },
      })
      expect(response.statusCode, response.body).toBe(200)
      return response.json().tiles.t1.metric
    }
    // Пустой привязанный период — всё время
    expect((await tile({})).value).toBe(7)
    expect((await tile({ f1: ['2026-03-01', '2026-03-31'] })).value).toBe(3)
    expect((await tile({ f1: ['2026-03-01', '2026-03-31'], f2: ['Хатлон'] })).value).toBe(2)
  })
})

describe('права и политики', () => {
  it('читатель с политикой строк видит своё значение; посторонний — 404', async () => {
    const incidents = await metricId({
      name: `Для читателя ${run}`,
      definition: { measure: { agg: 'count' }, filter: fixed, period: MARCH },
    })
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

    expect((await value(incidents, {}, fx.users.viewer)).json().value).toBe(2)
    expect((await value(incidents)).json().value).toBe(3)
    const dashboard = await dashboardWith([{ metricId: incidents }])
    const data = await call(fx.app, {
      method: 'POST',
      url: `/dashboards/${dashboard}/data`,
      as: fx.users.viewer,
      payload: {},
    })
    expect(data.json().tiles.t1.metric.value).toBe(2)

    expect((await value(incidents, {}, fx.users.stranger)).statusCode).toBe(404)
    expect(
      (await call(fx.app, { url: `/metrics/${incidents}`, as: fx.users.stranger })).statusCode,
    ).toBe(404)

    await call(fx.app, {
      method: 'DELETE',
      url: `/datasets/${datasetId}/policies/rows/${policy.json().id}`,
      as: fx.admin,
    })
  })

  it('нет доступа к данным показателя — плитка «нет доступа», «где используется» с правами', async () => {
    // Датасет в пространстве, где читателя нет
    const privateSpace = await db().transaction((tx) =>
      SpaceService.create(tx, systemCtx('test'), {
        key: `metrics-private-${run}`,
        name: 'Закрытое',
        kind: 'team',
        ownerId: fx.admin.id,
      }),
    )
    await redis().del(`kchs:principals:${fx.admin.id}`)
    const hidden = await call(fx.app, {
      method: 'POST',
      url: '/datasets',
      as: fx.admin,
      payload: {
        name: `Закрытые ${run}`,
        spaceId: privateSpace,
        fields: [{ key: 'code', label: { ru: 'Код' }, type: 'identifier' }],
      },
    })
    expect(hidden.statusCode, hidden.body).toBe(200)
    const hiddenId = hidden.json().id as string
    const secret = await call(fx.app, {
      method: 'POST',
      url: '/metrics',
      as: fx.admin,
      payload: {
        name: `Закрытый ${run}`,
        spaceId: fx.spaceId,
        datasetId: hiddenId,
        definition: { measure: { agg: 'count' }, period: null },
      },
    })
    expect(secret.statusCode, secret.body).toBe(200)
    const secretId = secret.json().id as string
    // Показатель виден читателю пространства, его данные — нет
    expect(
      (await call(fx.app, { url: `/metrics/${secretId}`, as: fx.users.viewer })).statusCode,
    ).toBe(200)
    expect((await value(secretId, {}, fx.users.viewer)).statusCode).toBe(404)

    const dashboard = await dashboardWith([{ metricId: secretId }])
    const data = await call(fx.app, {
      method: 'POST',
      url: `/dashboards/${dashboard}/data`,
      as: fx.users.viewer,
      payload: {},
    })
    expect(data.json().tiles.t1).toMatchObject({ error: 'no_access', metric: null })

    // «Где используется»: дашборд с плиткой показателя; закрытый — без названия
    const closed = await dashboardWith([{ metricId: secretId }], [], privateSpace)
    const links = await call(fx.app, { url: `/objects/${secretId}/links`, as: fx.users.viewer })
    expect(links.statusCode, links.body).toBe(200)
    const usedBy = links.json().usedBy as Array<{ id: string; accessible: boolean; title: string }>
    expect(usedBy.find((item) => item.id === dashboard)?.accessible).toBe(true)
    const hiddenDashboard = usedBy.find((item) => item.id === closed)
    expect(hiddenDashboard?.accessible).toBe(false)
    expect(hiddenDashboard?.title).not.toContain(run)
  })
})
