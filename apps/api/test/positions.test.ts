import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  call,
  createServiceAccount,
  db,
  registerLifecycle,
  setupFixture,
  type TestContext,
} from './helpers.js'

/**
 * Местоположение сил и средств (ADR-0203): реестр устройств слежения, приём
 * координат по токену поставщика и из сессии сотрудника, отбраковка точек,
 * идемпотентность (устройство + время), последняя точка и событие, проекция в
 * датасет слоя карты, трек, обслуживание партиций журнала точек.
 */
registerLifecycle()

const { PositionProjection } = await import('../src/modules/positions/domain/projection.js')
const { PositionPartitions } = await import('../src/modules/positions/domain/maintenance.js')
const { withMigratorConnection } = await import('../src/shared/db/migrate.js')

const run = Date.now().toString(36)
let fx: TestContext
/** Служебная запись поставщика мониторинга и её токен с областью `write:positions`. */
let provider = ''
let providerToken = ''
let datasetId = ''
const minute = 60_000

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * minute).toISOString()
}

async function createDevice(payload: Record<string, unknown>): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/positions/devices',
    as: fx.admin,
    payload: { spaceId: fx.spaceId, kind: 'vehicle', ...payload },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().id as string
}

function postAsProvider(positions: Array<Record<string, unknown>>, secret = providerToken) {
  return call(fx.app, {
    method: 'POST',
    url: '/public/positions',
    headers: { authorization: `Bearer ${secret}` },
    payload: { positions },
  })
}

async function issueToken(userId: string, scopes: string[]): Promise<string> {
  const response = await call(fx.app, {
    method: 'POST',
    url: '/me/api-tokens',
    as: fx.admin,
    payload: { name: `Мониторинг ${run} ${scopes.join(',')}`, scopes, userId },
  })
  expect(response.statusCode, response.body).toBe(200)
  return response.json().secret as string
}

const previous = { settings: null as unknown }

beforeAll(async () => {
  fx = await setupFixture()
  // Поставщику не нужно членство в пространстве: он передаёт точки своих устройств
  provider = await createServiceAccount(fx.app, fx.admin, `Поставщик GPS ${run}`)
  providerToken = await issueToken(provider, ['write:positions'])
  const dataset = await call(fx.app, {
    method: 'POST',
    url: '/datasets',
    as: fx.admin,
    payload: {
      name: `Техника на карте ${run}`,
      spaceId: fx.spaceId,
      fields: [
        { key: 'code', label: { ru: 'Номер' }, type: 'identifier', semantic: 'identifier' },
        { key: 'name', label: { ru: 'Название' }, type: 'text', semantic: 'dimension' },
        { key: 'seen_at', label: { ru: 'На связи' }, type: 'datetime', semantic: 'time' },
        { key: 'link', label: { ru: 'Связь' }, type: 'text', semantic: 'category' },
        { key: 'speed', label: { ru: 'Скорость' }, type: 'number', semantic: 'measure' },
        { key: 'geometry', label: { ru: 'Место' }, type: 'geometry', semantic: 'geometry' },
      ],
      primaryKey: ['code'],
    },
  })
  expect(dataset.statusCode, dataset.body).toBe(200)
  datasetId = dataset.json().id as string
  const settings = await call(fx.app, { url: '/admin/positions/settings', as: fx.admin })
  previous.settings = settings.json()
})

afterAll(async () => {
  if (previous.settings) {
    await call(fx.app, {
      method: 'PUT',
      url: '/admin/positions/settings',
      as: fx.admin,
      payload: previous.settings,
    })
  }
})

describe('реестр устройств слежения', () => {
  it('заводится в пространстве; внешний номер уникален; посторонний не видит', async () => {
    const id = await createDevice({ name: `АЦ-40 ${run}`, externalId: `IMEI-${run}-1` })
    const card = await call(fx.app, { url: `/positions/devices/${id}`, as: fx.admin })
    expect(card.statusCode, card.body).toBe(200)
    expect(card.json()).toMatchObject({ link: 'never', last: null, active: true })
    expect(card.json().can).toMatchObject({ edit: true, report: true })

    const again = await call(fx.app, {
      method: 'POST',
      url: '/positions/devices',
      as: fx.admin,
      payload: { spaceId: fx.spaceId, name: 'Дубль', externalId: `IMEI-${run}-1` },
    })
    expect(again.statusCode).toBe(409)

    const stranger = await call(fx.app, { url: `/positions/devices/${id}`, as: fx.users.stranger })
    expect([403, 404]).toContain(stranger.statusCode)
    const list = await call(fx.app, { url: '/positions/devices', as: fx.users.stranger })
    expect((list.json().items as Array<{ id: string }>).map((item) => item.id)).not.toContain(id)
  })
})

describe('приём координат', () => {
  it('поставщик: свои точки принимаются, повтор не пишется, чужое и незаведённое отбраковано', async () => {
    const mine = await createDevice({
      name: `Спасательный ${run}`,
      externalId: `GPS-${run}-A`,
      reporterId: provider,
    })
    await createDevice({ name: `Чужой ${run}`, externalId: `GPS-${run}-B` })
    const points = [
      { deviceId: `GPS-${run}-A`, at: ago(6), lat: 38.56, lon: 68.78, speed: 40 },
      { deviceId: `GPS-${run}-A`, at: ago(4), lat: 38.57, lon: 68.79, speed: 42, battery: 81 },
      { deviceId: `GPS-${run}-B`, at: ago(4), lat: 38.57, lon: 68.79 },
      { deviceId: `GPS-${run}-X`, at: ago(4), lat: 38.57, lon: 68.79 },
      {
        deviceId: `GPS-${run}-A`,
        at: new Date(Date.now() + 30 * minute).toISOString(),
        lat: 38.57,
        lon: 68.79,
      },
      { deviceId: `GPS-${run}-A`, at: ago(3), lat: 40.28, lon: 69.62 },
    ]
    const first = await postAsProvider(points)
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({ accepted: 2, duplicates: 0 })
    expect(first.json().rejected).toEqual([
      { index: 2, deviceId: `GPS-${run}-B`, reason: 'unknown_device' },
      { index: 3, deviceId: `GPS-${run}-X`, reason: 'unknown_device' },
      { index: 4, deviceId: `GPS-${run}-A`, reason: 'future' },
      { index: 5, deviceId: `GPS-${run}-A`, reason: 'impossible_speed' },
    ])

    // Тот же пакет ещё раз — ответ потерялся у поставщика: второй раз ничего не пишется
    const again = await postAsProvider(points.slice(0, 2))
    expect(again.json()).toMatchObject({ accepted: 0, duplicates: 2 })

    const card = await call(fx.app, { url: `/positions/devices/${mine}`, as: fx.admin })
    expect(card.json().link).toBe('online')
    expect(card.json().last).toMatchObject({ lat: 38.57, lon: 68.79, speed: 42, battery: 81 })

    // Одна новая последняя точка — одно событие за пакет
    const events = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ops.outbox
           WHERE event->>'type' = 'device.located' AND event->'object'->>'id' = ${mine}`,
    )
    expect(events[0]?.n).toBe(1)

    const track = await call(fx.app, { url: `/positions/devices/${mine}/track`, as: fx.admin })
    expect(track.statusCode, track.body).toBe(200)
    expect((track.json().points as Array<{ lat: number }>).map((point) => point.lat)).toEqual([
      38.56, 38.57,
    ])
  })

  it('токен без области write:positions — отказ; поставщик не видит ничего, кроме своих устройств', async () => {
    const reader = await issueToken(provider, ['read:objects'])
    const denied = await postAsProvider(
      [{ deviceId: `GPS-${run}-A`, at: ago(1), lat: 38.57, lon: 68.79 }],
      reader,
    )
    expect(denied.statusCode).toBe(403)
    expect(denied.json().data?.reason ?? denied.json().code).toBeTruthy()

    const list = await call(fx.app, {
      url: '/positions/devices',
      headers: { authorization: `Bearer ${providerToken}` },
    })
    expect(list.statusCode, list.body).toBe(200)
    const names = (list.json().items as Array<{ externalId: string }>).map(
      (item) => item.externalId,
    )
    expect(names).toContain(`GPS-${run}-A`)
    expect(names).not.toContain(`GPS-${run}-B`)
  })

  it('сотрудник с телефона группы — в своей сессии; без права передавать — отбраковка', async () => {
    await createDevice({
      name: `Группа ${run}`,
      externalId: `PHONE-${run}`,
      kind: 'team',
      reporterId: fx.users.stranger.id,
    })
    const own = await call(fx.app, {
      method: 'POST',
      url: '/public/positions',
      as: fx.users.stranger,
      payload: { positions: [{ deviceId: `PHONE-${run}`, at: ago(2), lat: 39.1, lon: 70.5 }] },
    })
    expect(own.statusCode, own.body).toBe(200)
    expect(own.json()).toMatchObject({ accepted: 1, rejected: [] })

    const viewer = await call(fx.app, {
      method: 'POST',
      url: '/public/positions',
      as: fx.users.viewer,
      payload: { positions: [{ deviceId: `PHONE-${run}`, at: ago(1), lat: 39.1, lon: 70.5 }] },
    })
    expect(viewer.json()).toMatchObject({
      accepted: 0,
      rejected: [{ index: 0, reason: 'unknown_device' }],
    })
  })

  it('выключенное устройство точки не принимает', async () => {
    const id = await createDevice({
      name: `Списан ${run}`,
      externalId: `GPS-${run}-OFF`,
      reporterId: provider,
    })
    const off = await call(fx.app, {
      method: 'PATCH',
      url: `/positions/devices/${id}`,
      as: fx.admin,
      payload: { active: false },
    })
    expect(off.statusCode, off.body).toBe(200)
    const result = await postAsProvider([
      { deviceId: `GPS-${run}-OFF`, at: ago(1), lat: 38.5, lon: 68.7 },
    ])
    expect(result.json().rejected).toEqual([
      { index: 0, deviceId: `GPS-${run}-OFF`, reason: 'inactive_device' },
    ])
  })
})

describe('проекция в слой карты обстановки', () => {
  it('строка на устройство по номеру; новая точка правит ту же строку; выключенное убирается', async () => {
    const saved = await call(fx.app, {
      method: 'PUT',
      url: '/admin/positions/settings',
      as: fx.admin,
      payload: { retentionMonths: 12, projectionDatasetId: datasetId, staleMinutes: 15 },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const id = await createDevice({
      name: `Проекция ${run}`,
      externalId: `GPS-${run}-P`,
      reporterId: provider,
    })
    await postAsProvider([{ deviceId: `GPS-${run}-P`, at: ago(5), lat: 37.9, lon: 69.8 }])
    await PositionProjection.run()

    const rows = async () => {
      const response = await call(fx.app, {
        method: 'POST',
        url: `/datasets/${datasetId}/rows/query`,
        as: fx.admin,
        payload: { limit: 100 },
      })
      expect(response.statusCode, response.body).toBe(200)
      const body = response.json()
      const names = (body.fields as Array<{ name: string }>).map((field) => field.name)
      return (body.rows as unknown[][])
        .map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])))
        .filter((row) => row.code === `GPS-${run}-P`)
    }
    let found = await rows()
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ name: `Проекция ${run}`, link: 'online' })

    await postAsProvider([
      { deviceId: `GPS-${run}-P`, at: ago(1), lat: 37.91, lon: 69.81, speed: 30 },
    ])
    await PositionProjection.run()
    found = await rows()
    expect(found).toHaveLength(1)
    expect(found[0]?.speed).toBe(30)

    await call(fx.app, {
      method: 'PATCH',
      url: `/positions/devices/${id}`,
      as: fx.admin,
      payload: { active: false },
    })
    const removed = await PositionProjection.run()
    expect(removed.removed).toBeGreaterThanOrEqual(1)
    expect(await rows()).toHaveLength(0)
  })
})

describe('обслуживание журнала точек', () => {
  it('партиции создаются вперёд, месяцы старше срока хранения удаляются', async () => {
    const old = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 30, 1))
    const name = `device_positions_${old.toISOString().slice(0, 7).replace('-', '_')}`
    await withMigratorConnection(async (migrator) => {
      await migrator`SELECT ops.ensure_month_partition('public.device_positions'::regclass,
                                                       ${old.toISOString().slice(0, 10)}::date)`
    })
    const report = await PositionPartitions.maintain()
    expect(report.dropped).toBeGreaterThanOrEqual(1)
    const left = await db().execute<{ name: string }>(
      sql`SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
           WHERE i.inhparent = 'public.device_positions'::regclass`,
    )
    const names = left.map((row) => row.name)
    expect(names).not.toContain(name)
    const ahead = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 3, 1))
    expect(names).toContain(`device_positions_${ahead.toISOString().slice(0, 7).replace('-', '_')}`)
  })
})
