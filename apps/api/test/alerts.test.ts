import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Алерты на показатели (P5-E03, ADR-0104): условие проверяется значением
 * показателя под правами владельца, срабатывание пишется в историю и
 * публикует `alert.fired`; тестовый прогон ничего не пишет, период тишины
 * подавляет повтор.
 */
registerLifecycle()

const run = Date.now().toString(36)
let fx: TestContext
let datasetId = ''
let metricId = ''

const definition = (patch: Record<string, unknown> = {}) => ({
  metricId,
  description: null,
  condition: { kind: 'threshold', op: 'gt', value: 100 },
  dimensions: [],
  period: null,
  schedule: { cron: '0 9 * * *', timezone: 'Asia/Dushanbe' },
  recipients: [`user:${fx.admin.id}`],
  channels: { notify: true, inbox: false, email: false },
  cooldownMinutes: 60,
  ...patch,
})

const createAlert = (payload: Record<string, unknown> = {}) =>
  call(fx.app, {
    method: 'POST',
    url: '/alerts',
    as: fx.admin,
    payload: {
      name: `Алерт ${run}-${Math.random().toString(36).slice(2, 7)}`,
      spaceId: fx.spaceId,
      definition: definition(payload),
    },
  })

const check = (id: string, dryRun: boolean, as = fx.admin) =>
  call(fx.app, { method: 'POST', url: `/alerts/${id}/check`, as, payload: { dryRun } })

beforeAll(async () => {
  fx = await setupFixture()
  const dataset = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Происшествия ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'day', label: { ru: 'Дата' }, type: 'date', semantic: 'time' },
        { key: 'district', label: { ru: 'Район' }, type: 'text', semantic: 'dimension' },
        { key: 'damage', label: { ru: 'Ущерб' }, type: 'integer', semantic: 'measure' },
      ],
      timeField: 'day',
    },
  })
  expect(dataset.statusCode, dataset.body).toBe(200)
  datasetId = dataset.json().id as string

  const rows = await call(fx.app, {
    method: 'POST',
    url: `/datasets/${datasetId}/rows`,
    as: fx.admin,
    payload: {
      rows: [
        { values: { day: '2026-03-01', district: 'Хатлон', damage: 90 } },
        { values: { day: '2026-03-02', district: 'Согд', damage: 60 } },
        { values: { day: '2026-03-03', district: 'Хатлон', damage: 5 } },
      ],
    },
  })
  expect(rows.statusCode, rows.body).toBe(200)

  const metric = await call(fx.app, {
    method: 'POST',
    url: '/metrics',
    as: fx.admin,
    payload: {
      name: `Ущерб ${run}`,
      spaceId: fx.spaceId,
      datasetId,
      definition: {
        measure: { agg: 'sum', field: 'damage' },
        filter: null,
        timeField: 'day',
        dimensions: ['district'],
        period: null,
        comparison: 'none',
      },
    },
  })
  expect(metric.statusCode, metric.body).toBe(200)
  metricId = metric.json().id as string
})

describe('алерты на показатели', () => {
  it('тестовый прогон считает, но ничего не пишет и не рассылает', async () => {
    const created = await createAlert()
    expect(created.statusCode, created.body).toBe(200)
    const alertId = created.json().id as string

    const dry = await check(alertId, true)
    expect(dry.statusCode, dry.body).toBe(200)
    expect(dry.json().dryRun).toBe(true)
    // Сумма ущерба 155 больше порога 100
    expect(dry.json().fired).toBe(1)
    expect(dry.json().outcomes[0].value).toBe(155)

    const history = await call(fx.app, {
      method: 'GET',
      url: `/alerts/events?alertId=${alertId}`,
      as: fx.admin,
    })
    expect(history.statusCode, history.body).toBe(200)
    expect(history.json().items).toHaveLength(0)
  })

  it('«Проверить сейчас» пишет срабатывание, период тишины гасит повтор', async () => {
    const created = await createAlert()
    const alertId = created.json().id as string

    const first = await check(alertId, false)
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().fired).toBe(1)

    const history = await call(fx.app, {
      method: 'GET',
      url: `/alerts/events?alertId=${alertId}`,
      as: fx.admin,
    })
    expect(history.json().items).toHaveLength(1)
    expect(history.json().items[0].message).toContain('155')

    const second = await check(alertId, false)
    expect(second.json().fired).toBe(0)
    expect(second.json().outcomes[0].suppressed).toBe(true)
  })

  it('условие не выполнено — срабатывания нет', async () => {
    const created = await createAlert({ condition: { kind: 'threshold', op: 'gt', value: 1000 } })
    const alertId = created.json().id as string
    const result = await check(alertId, true)
    expect(result.json().fired).toBe(0)
    expect(result.json().outcomes[0].fired).toBe(false)
  })

  it('разрез проверяется по каждому значению отдельно', async () => {
    const created = await createAlert({
      dimensions: ['district'],
      condition: { kind: 'threshold', op: 'gt', value: 80 },
    })
    const alertId = created.json().id as string
    const result = await check(alertId, true)
    expect(result.statusCode, result.body).toBe(200)
    const outcomes = result.json().outcomes as Array<{ group: { label: string }; fired: boolean }>
    expect(outcomes.length).toBeGreaterThanOrEqual(2)
    // Хатлон — 95, Согд — 60: сработал только один разрез
    expect(outcomes.filter((item) => item.fired)).toHaveLength(1)
    expect(outcomes.find((item) => item.fired)?.group.label).toBe('Хатлон')
  })

  it('алерт со сломанным расписанием не создаётся', async () => {
    const response = await call(fx.app, {
      method: 'POST',
      url: '/alerts',
      as: fx.admin,
      payload: {
        name: `Плохое расписание ${run}`,
        spaceId: fx.spaceId,
        definition: definition({ schedule: { cron: 'каждый час', timezone: 'Asia/Dushanbe' } }),
      },
    })
    expect(response.statusCode).toBe(400)
  })

  it('включение ставит ближайшую проверку, выключение снимает', async () => {
    const created = await createAlert()
    const alertId = created.json().id as string

    const on = await call(fx.app, {
      method: 'POST',
      url: `/alerts/${alertId}/enabled`,
      as: fx.admin,
      payload: { enabled: true },
    })
    expect(on.statusCode, on.body).toBe(200)
    expect(on.json().nextRunAt).toBeTruthy()

    const off = await call(fx.app, {
      method: 'POST',
      url: `/alerts/${alertId}/enabled`,
      as: fx.admin,
      payload: { enabled: false },
    })
    expect(off.json().nextRunAt).toBeNull()
  })

  it('чужой алерт не виден и не проверяется', async () => {
    const created = await createAlert()
    const alertId = created.json().id as string
    const read = await call(fx.app, {
      method: 'GET',
      url: `/alerts/${alertId}`,
      as: fx.users.stranger,
    })
    expect([403, 404]).toContain(read.statusCode)
    const forced = await check(alertId, false, fx.users.stranger)
    expect([403, 404]).toContain(forced.statusCode)
  })
})
