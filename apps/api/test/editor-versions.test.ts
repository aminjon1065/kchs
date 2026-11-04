import { beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Карта и дашборд сохраняются целиком (ADR-0228): редактор передаёт версию, с которой
 * открыт, и сохранение поверх чужой правки отвечает 412, а не стирает её молча. Без
 * версии — прежнее поведение (интеграции, старые клиенты).
 */
registerLifecycle()

let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
})

const kinds = [
  { name: 'карта', base: '/gis/maps', spec: { layers: [] } },
  { name: 'дашборд', base: '/dashboards', spec: { tiles: [], filters: [] } },
] as const

describe.each(kinds)('$name: сохранение по версии', ({ base, spec }) => {
  it('устаревшая версия — 412, правка первого сохранения на месте', async () => {
    const created = await call(fx.app, {
      method: 'POST',
      url: base,
      as: fx.admin,
      payload: { name: `Версии ${Date.now()}`, spaceId: fx.spaceId },
    })
    expect(created.statusCode, created.body).toBe(200)
    const id = created.json().id as string
    const opened = await call(fx.app, { method: 'GET', url: `${base}/${id}`, as: fx.admin })
    const version = opened.json().version as number

    // Первый сотрудник сохраняет: ответ несёт новую версию
    const first = await call(fx.app, {
      method: 'PATCH',
      url: `${base}/${id}`,
      as: fx.admin,
      payload: { spec, expectedVersion: version },
    })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().version).toBeGreaterThan(version)

    // Второй открыл ту же версию раньше — его сохранение отклоняется
    const second = await call(fx.app, {
      method: 'PATCH',
      url: `${base}/${id}`,
      as: fx.admin,
      payload: { spec, expectedVersion: version },
    })
    expect(second.statusCode).toBe(412)
    expect(second.json().code).toBe('precondition_failed')

    // Со свежей версией — проходит; без версии — как раньше
    const fresh = await call(fx.app, {
      method: 'PATCH',
      url: `${base}/${id}`,
      as: fx.admin,
      payload: { spec, expectedVersion: first.json().version },
    })
    expect(fresh.statusCode, fresh.body).toBe(200)
    const legacy = await call(fx.app, {
      method: 'PATCH',
      url: `${base}/${id}`,
      as: fx.admin,
      payload: { spec },
    })
    expect(legacy.statusCode, legacy.body).toBe(200)
  })
})
