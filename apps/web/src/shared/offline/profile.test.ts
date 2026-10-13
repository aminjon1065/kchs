import type { MeResponse } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { forgetProfile, rememberProfile, savedProfile } from './profile.js'
import { loadedAssets } from './warmup.js'

/**
 * Запуск без сети (ADR-0207): профиль вошедшего на устройстве — без токена CSRF, не
 * старше недели и стирается при выходе; служебному потоку называются только свои
 * файлы сборки.
 */
const me = {
  user: { id: 'u1' },
  session: { csrfToken: 'секрет-сессии' },
} as unknown as MeResponse

describe('профиль на устройстве', () => {
  it('без токена CSRF; неделя без связи — профиля нет; выход стирает', async () => {
    await rememberProfile(me)
    const saved = await savedProfile()
    expect(saved?.user.id).toBe('u1')
    expect(saved?.session.csrfToken).toBe('')
    expect(await savedProfile(Date.now() + 8 * 86_400_000)).toBeNull()
    await forgetProfile()
    expect(await savedProfile()).toBeNull()
  })
})

describe('файлы сборки для кэша служебного потока', () => {
  it('только свои `/assets/*`, без повторов', () => {
    const origin = 'https://portal.example'
    expect(
      loadedAssets(
        [
          { name: `${origin}/assets/index-abc.js` },
          { name: `${origin}/assets/index-abc.js` },
          { name: `${origin}/assets/forms-screen-x1.js?v=1` },
          { name: `${origin}/api/v1/me` },
          { name: 'https://tiles.example/assets/tile.png' },
          { name: 'не адрес' },
        ],
        origin,
      ),
    ).toEqual(['/assets/index-abc.js', '/assets/forms-screen-x1.js'])
  })
})
