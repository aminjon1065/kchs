import { beforeAll, describe, expect, it } from 'vitest'
import { BrandingService } from '../src/kernel/settings/branding.js'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Брендирование (P5-E06, 15-admin-operations.md §1): название, логотип, акцент
 * и приписка на экране входа. Читается без входа — экран входа показывает их
 * до сессии; меняет администратор системы, изменение идёт в аудит.
 */
registerLifecycle()

let fx: TestContext

/** Однопиксельный PNG: логотипу хватает, чтобы проверить путь целиком. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

beforeAll(async () => {
  fx = await setupFixture()
})

describe('брендирование', () => {
  it('читается без входа: до сессии экрану входа нужны название и логотип', async () => {
    const response = await call(fx.app, { url: '/branding' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ accent: 'blue', logo: null })
  })

  it('меняет только администратор системы', async () => {
    const response = await call(fx.app, {
      method: 'PATCH',
      url: '/admin/branding',
      as: fx.users.member,
      payload: { name: 'Чужая организация' },
    })
    expect(response.statusCode).toBe(403)
  })

  it('название, акцент и логотип сохраняются и видны без входа', async () => {
    try {
      const saved = await call(fx.app, {
        method: 'PATCH',
        url: '/admin/branding',
        as: fx.admin,
        payload: {
          name: 'Комитет по чрезвычайным ситуациям',
          shortName: 'КЧС',
          accent: 'green',
          logo: PNG,
          loginNote: 'Для служебного пользования',
        },
      })
      expect(saved.statusCode, saved.body).toBe(200)
      BrandingService.invalidate()

      const public_ = await call(fx.app, { url: '/branding' })
      expect(public_.json()).toMatchObject({
        name: 'Комитет по чрезвычайным ситуациям',
        shortName: 'КЧС',
        accent: 'green',
        logo: PNG,
        loginNote: 'Для служебного пользования',
      })

      // В аудит идёт размер логотипа, а не сама картинка
      const trail = await call(fx.app, {
        url: '/admin/audit?action=settings.branding_changed',
        as: fx.admin,
      })
      const entry = (trail.json().items as Array<{ details: Record<string, never> }>)[0]
      expect(entry?.details.after).toMatchObject({ shortName: 'КЧС', logoBytes: PNG.length })
      expect(JSON.stringify(entry?.details)).not.toContain('base64')
    } finally {
      await call(fx.app, {
        method: 'PATCH',
        url: '/admin/branding',
        as: fx.admin,
        payload: { name: '', shortName: '', accent: 'blue', logo: null, loginNote: '' },
      })
      BrandingService.invalidate()
    }
  })

  it('логотип — только картинка значением `data:`, и не больше 256 КБ', async () => {
    const foreign = await call(fx.app, {
      method: 'PATCH',
      url: '/admin/branding',
      as: fx.admin,
      payload: { logo: 'https://example.org/logo.png' },
    })
    expect(foreign.statusCode).toBe(400)

    const huge = await call(fx.app, {
      method: 'PATCH',
      url: '/admin/branding',
      as: fx.admin,
      payload: { logo: `data:image/png;base64,${'A'.repeat(300_000)}` },
    })
    expect(huge.statusCode).toBe(400)
  })

  it('неизвестный акцент не принимается', async () => {
    const response = await call(fx.app, {
      method: 'PATCH',
      url: '/admin/branding',
      as: fx.admin,
      payload: { accent: 'неоновый' },
    })
    expect(response.statusCode).toBe(400)
  })
})
