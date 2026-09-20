import { beforeAll, describe, expect, it } from 'vitest'
import { FeatureService } from '../src/kernel/features/service.js'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Возможности установки (P5-E06, 15-admin-operations.md §1): выключенная
 * возможность исчезает из `/me`, её маршруты отвечают «не найдено», а данные
 * остаются на месте и возвращаются вместе с ней.
 */
registerLifecycle()

let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
})

async function setFeature(key: string, enabled: boolean): Promise<void> {
  const response = await call(fx.app, {
    method: 'PATCH',
    url: `/admin/features/${key}`,
    as: fx.admin,
    payload: { enabled },
  })
  expect(response.statusCode, response.body).toBe(200)
}

describe('возможности установки', () => {
  it('список возможностей показывает умолчание, экраны и число объектов', async () => {
    const response = await call(fx.app, { url: '/admin/features', as: fx.admin })
    expect(response.statusCode).toBe(200)
    const items = response.json().items as Array<Record<string, unknown>>
    const knowledge = items.find((item) => item.key === 'knowledge')
    expect(knowledge).toMatchObject({ enabled: true, fallback: true, screens: ['knowledge'] })
    expect(typeof knowledge?.objects).toBe('number')
  })

  it('список и изменение — только администратору системы', async () => {
    const read = await call(fx.app, { url: '/admin/features', as: fx.users.member })
    expect(read.statusCode).toBe(403)
    const write = await call(fx.app, {
      method: 'PATCH',
      url: '/admin/features/knowledge',
      as: fx.users.member,
      payload: { enabled: false },
    })
    expect(write.statusCode).toBe(403)
  })

  it('выключенная возможность: маршруты отвечают «не найдено», экран уходит из `/me`', async () => {
    const tree = `/knowledge/tree?spaceId=${fx.spaceId}`
    const before = await call(fx.app, { url: tree, as: fx.admin })
    expect(before.statusCode).toBe(200)

    try {
      await setFeature('knowledge', false)
      const after = await call(fx.app, { url: tree, as: fx.admin })
      expect(after.statusCode).toBe(404)
      expect(after.json().code).toBe('not_found')

      const me = await call(fx.app, { url: '/me', as: fx.users.member })
      expect(me.json().features).not.toContain('knowledge')
      expect(me.json().hiddenScreens).toContain('knowledge')

      // Администрирование не выключается вместе с модулем — иначе возможность не вернуть
      const admin = await call(fx.app, { url: '/admin/features', as: fx.admin })
      expect(admin.statusCode).toBe(200)
    } finally {
      await setFeature('knowledge', true)
      FeatureService.invalidate()
    }

    const restored = await call(fx.app, { url: tree, as: fx.admin })
    expect(restored.statusCode).toBe(200)
  })

  it('изменение возможности идёт в аудит с состоянием до и после', async () => {
    await setFeature('reports', false)
    await setFeature('reports', true)
    const trail = await call(fx.app, {
      url: '/admin/audit?action=settings.feature_changed',
      as: fx.admin,
    })
    const items = trail.json().items as Array<{ details: Record<string, unknown> }>
    expect(items.length).toBeGreaterThan(0)
    expect(items[0]?.details).toMatchObject({ feature: 'reports' })
  })

  it('неизвестная возможность не заводится настройкой', async () => {
    const response = await call(fx.app, {
      method: 'PATCH',
      url: '/admin/features/нет-такой',
      as: fx.admin,
      payload: { enabled: false },
    })
    expect(response.statusCode).toBe(500)
  })
})
