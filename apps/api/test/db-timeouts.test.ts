import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { registerLifecycle } from './helpers.js'

/**
 * Пределы основного пула (ADR-0220): процесс api режет долгий запрос, worker и `ROLE=all`
 * получают большие пределы для тяжёлых заданий; отменённый запрос — код 57014, который
 * обработчик ошибок отдаёт как 504 «запрос выполнялся слишком долго».
 */
registerLifecycle()

const { poolSessionSettings } = await import('../src/shared/db/client.js')
const { config } = await import('../src/shared/config/index.js')

const env = {
  DATABASE_STATEMENT_TIMEOUT_MS: 300,
  DATABASE_IDLE_IN_TX_TIMEOUT_MS: 1000,
  DATABASE_WORKER_STATEMENT_TIMEOUT_MS: 1_800_000,
  DATABASE_WORKER_IDLE_IN_TX_TIMEOUT_MS: 600_000,
  DATABASE_CONNECT_TIMEOUT_S: 10,
}

describe('пределы основного пула', () => {
  it('api — короткие пределы, worker и all — пределы заданий', () => {
    expect(poolSessionSettings({ ...env, ROLE: 'api' }).connection).toEqual({
      statement_timeout: 300,
      idle_in_transaction_session_timeout: 1000,
    })
    for (const role of ['worker', 'all'] as const) {
      expect(poolSessionSettings({ ...env, ROLE: role }).connection.statement_timeout).toBe(
        1_800_000,
      )
    }
    expect(poolSessionSettings({ ...env, ROLE: 'api' }).connect_timeout).toBe(10)
  })

  it('запрос дольше предела api отменяется базой с кодом 57014', async () => {
    const sql = postgres(config().DATABASE_URL, {
      max: 1,
      ...poolSessionSettings({ ...env, ROLE: 'api' }),
    })
    try {
      const failure = await sql`SELECT pg_sleep(2)`.catch((error: unknown) => error)
      expect((failure as { code?: string }).code).toBe('57014')
      // Соединение живо: следующий короткий запрос проходит
      const [row] = await sql<Array<{ ok: number }>>`SELECT 1 AS ok`
      expect(row?.ok).toBe(1)
    } finally {
      await sql.end({ timeout: 5 })
    }
  })
})
