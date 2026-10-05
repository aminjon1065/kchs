import { describe, expect, it } from 'vitest'
import { registerLifecycle } from './helpers.js'

/**
 * Кэш (ADR-0175) команд без соединения не копит. Первая операция нового процесса
 * (старт api, `kchs seed`) должна дождаться первого соединения, а не промахнуться:
 * прежде так промахивались первые операции каждого процесса.
 */
registerLifecycle()

const { cache, closeRedis } = await import('../src/shared/redis/index.js')

describe('кэш: первое соединение процесса', () => {
  it('первая операция нового клиента дожидается соединения', async () => {
    // Клиенты процесса создаются заново — как в только что запущенном процессе
    await closeRedis()
    const key = `kchs:test:ready:${Date.now().toString(36)}`
    await cache.set(key, 'да', 30)
    expect(await cache.get(key)).toBe('да')
    expect(await cache.del(key)).toBe(true)
  })
})
