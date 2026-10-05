import { describe, expect, it } from 'vitest'
import { CACHE_OPTIONS, cacheRedisUrl, LONG_LIVED_OPTIONS, REQUEST_OPTIONS } from './index.js'

describe('соединения с Redis (ADR-0175)', () => {
  it('кэш без своего адреса живёт в основном Redis', () => {
    expect(cacheRedisUrl({ REDIS_URL: 'redis://main:6379' })).toBe('redis://main:6379')
    expect(cacheRedisUrl({ REDIS_URL: 'redis://main:6379', REDIS_CACHE_URL: '' })).toBe(
      'redis://main:6379',
    )
    expect(
      cacheRedisUrl({ REDIS_URL: 'redis://main:6379', REDIS_CACHE_URL: 'redis://cache:6379' }),
    ).toBe('redis://cache:6379')
  })

  it('путь запроса падает быстро, кэш — сразу, долгоживущие соединения ждут', () => {
    // Конечное число попыток и тайм-аут: сбой Redis — 503, а не зависший запрос
    expect(REQUEST_OPTIONS.maxRetriesPerRequest).toBeGreaterThan(0)
    expect(REQUEST_OPTIONS.commandTimeout).toBeGreaterThan(0)
    // Кэш без соединения команд не копит: промах вместо ожидания
    expect(CACHE_OPTIONS.enableOfflineQueue).toBe(false)
    expect(CACHE_OPTIONS.commandTimeout).toBeLessThanOrEqual(REQUEST_OPTIONS.commandTimeout)
    // BullMQ требует null; блокирующим чтениям тайм-аут не нужен
    expect(LONG_LIVED_OPTIONS.maxRetriesPerRequest).toBeNull()
    expect('commandTimeout' in LONG_LIVED_OPTIONS).toBe(false)
  })
})
