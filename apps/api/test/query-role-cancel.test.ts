import { describe, expect, it } from 'vitest'
import { db, registerLifecycle } from './helpers.js'

/**
 * Отмена задания прерывает запрос в самой базе (ADR-0220): обёртка исполнителя заданий
 * освобождает слот сразу, а тяжёлое чтение под kchs_query раньше дорабатывало в фоне.
 */
registerLifecycle()

const { readAsQueryRole } = await import('../src/shared/db/query-role.js')
const { sql } = await import('drizzle-orm')

describe('чтение под kchs_query по сигналу задания', () => {
  it('отмена прерывает идущий запрос в базе и отдаёт причину сигнала', async () => {
    const controller = new AbortController()
    const reason = new Error('задание отменено')
    const started = Date.now()
    const reading = readAsQueryRole({ timeoutMs: 60_000, signal: controller.signal }, (read) =>
      read.rows({ sql: 'SELECT pg_sleep(10) AS slept', params: [] }),
    )
    setTimeout(() => controller.abort(reason), 300)
    await expect(reading).rejects.toBe(reason)
    expect(Date.now() - started).toBeLessThan(5_000)
    // В базе запрос не дорабатывает
    const running = await db().execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE query LIKE 'SELECT pg_sleep(10)%' AND state = 'active'`,
    )
    expect(running[0]?.n).toBe(0)
  })

  it('уже прерванный сигнал — запрос не начинается', async () => {
    const controller = new AbortController()
    controller.abort(new Error('поздно'))
    await expect(
      readAsQueryRole({ timeoutMs: 1000, signal: controller.signal }, (read) =>
        read.rows({ sql: 'SELECT 1', params: [] }),
      ),
    ).rejects.toThrow('поздно')
  })
})
