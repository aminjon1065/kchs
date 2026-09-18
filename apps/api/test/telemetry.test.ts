import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * Метрики Prometheus (15-admin-operations.md §4, ADR-0045): эндпоинт на своём
 * порту, длительность HTTP по шаблону маршрута, процесс и outbox. Провайдер
 * метрик поднимается до сборки приложения — как в main.ts.
 */
const { startMetrics, stopMetrics } = await import('../src/shared/telemetry/metrics.js')
const { registerKernelMetrics } = await import('../src/kernel/metrics.js')

// Порт своего слота: параллельные прогоны в разных базах не сталкиваются
const PORT = 19_400 + Number(process.env.KCHS_TEST_SLOT ?? 0)
await startMetrics({
  port: PORT,
  host: '127.0.0.1',
  onError: (error) => {
    throw error
  },
})
registerLifecycle()

let fx: TestContext

beforeAll(async () => {
  fx = await setupFixture()
  registerKernelMetrics({ queues: false, realtime: false })
})

afterAll(async () => {
  await stopMetrics()
})

async function scrape(): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${PORT}/metrics`)
  expect(res.status).toBe(200)
  return res.text()
}

describe('метрики Prometheus', () => {
  it('длительность запроса — по шаблону маршрута, без идентификаторов в метках', async () => {
    const id = '00000000-0000-4000-8000-000000000000'
    const res = await fx.app.inject({
      method: 'GET',
      url: `/api/v1/objects/${id}`,
      headers: { cookie: fx.admin.cookie },
    })
    expect(res.statusCode).toBe(404)

    const text = await scrape()
    expect(text).toMatch(
      /http_server_request_duration_count\{[^}]*http_route="\/api\/v1\/objects\/:id"[^}]*http_response_status_code="404"[^}]*\} \d+/,
    )
    // Граница гистограммы на бюджете p95 ≤ 200 мс (04-verification.md §4)
    expect(text).toMatch(/http_server_request_duration_bucket\{[^}]*le="0\.2"[^}]*\}/)
    expect(text).not.toContain(id)
  })

  it('процесс и outbox', async () => {
    const text = await scrape()
    expect(text).toMatch(/^process_memory_usage \d+/m)
    expect(text).toMatch(/^nodejs_eventloop_delay_p99 [\d.e-]+/m)
    expect(text).toMatch(/^kchs_outbox_pending \d+/m)
    expect(text).toMatch(/^kchs_outbox_oldest_age \d+/m)
  })
})
