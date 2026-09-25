import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { call, registerLifecycle, setupFixture, type TestContext } from './helpers.js'

/**
 * «Здоровье системы» из метрик (ADR-0167): мгновенные запросы к Prometheus и действующие
 * оповещения Alertmanager. Вместо них — локальный сервер с ответами их HTTP API.
 */
registerLifecycle()

const { resetConfigCache } = await import('../src/shared/config/env.js')
const { resetObservabilityCache } = await import('../src/modules/admin/domain/observability.js')

let fx: TestContext
let server: Server
let base = ''
const queries: string[] = []
const saved = {
  PROMETHEUS_URL: process.env.PROMETHEUS_URL,
  ALERTMANAGER_URL: process.env.ALERTMANAGER_URL,
  KCHS_VERSION: process.env.KCHS_VERSION,
}

/** Значение ряда по запросу: 5xx за окно — 0/0 (нет данных), остальное — по метрике. */
function sample(query: string): string {
  if (query.includes('5..')) return 'NaN'
  if (query.includes('histogram_quantile')) return '87.5'
  if (query.includes('redis_memory_max_bytes')) return '0'
  if (query.includes('pg_database_size_bytes')) return '52428800'
  return '12'
}

function useEnv(env: Partial<Record<keyof typeof saved, string | undefined>>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetConfigCache()
  resetObservabilityCache()
}

async function health() {
  const response = await call(fx.app, { url: '/admin/health', as: fx.admin })
  expect(response.statusCode, response.body).toBe(200)
  return response.json()
}

beforeAll(async () => {
  fx = await setupFixture()
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local')
    response.setHeader('content-type', 'application/json')
    if (url.pathname === '/api/v1/query') {
      const query = url.searchParams.get('query') ?? ''
      queries.push(query)
      response.end(
        JSON.stringify({
          status: 'success',
          data: { resultType: 'vector', result: [{ metric: {}, value: [0, sample(query)] }] },
        }),
      )
      return
    }
    if (url.pathname === '/api/v2/alerts') {
      expect(url.searchParams.get('silenced')).toBe('false')
      response.end(
        JSON.stringify([
          {
            labels: { alertname: 'KchsQueueGrowing', severity: 'warning' },
            annotations: { summary: 'Очередь import растёт дольше 15 минут' },
            startsAt: '2026-09-25T08:00:00Z',
          },
          {
            labels: { alertname: 'KchsOutboxStuck', severity: 'critical' },
            annotations: { summary: 'Outbox: неопубликованное событие старше минуты' },
            startsAt: '2026-09-25T09:00:00Z',
          },
        ]),
      )
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  useEnv(saved)
  await new Promise((resolve) => server.close(resolve))
})

describe('здоровье системы из метрик', () => {
  it('метрики Prometheus, оповещения по важности, версия установки', async () => {
    useEnv({ PROMETHEUS_URL: base, ALERTMANAGER_URL: base, KCHS_VERSION: '0.7.0' })
    const report = await health()

    expect(report.version).toBe('0.7.0')
    expect(report.metrics).toEqual({
      status: 'ok',
      requestsPerSecond: 12,
      errorRate: null,
      latencyP95Ms: 87.5,
      memoryBytes: 12,
      postgresSizeBytes: 52428800,
      postgresConnections: 12,
      redisUsedBytes: 12,
      redisMaxBytes: 0,
    })
    // Размер — базы приложения, а не всех баз сервера (тестовая — kchs_test*)
    expect(queries.find((query) => query.includes('pg_database_size_bytes'))).toMatch(
      /datname="kchs_test/,
    )
    expect(report.alerts.status).toBe('ok')
    expect(report.alerts.items.map((alert: { name: string }) => alert.name)).toEqual([
      'KchsOutboxStuck',
      'KchsQueueGrowing',
    ])
    expect(report.alerts.items[0]).toMatchObject({
      severity: 'critical',
      summary: 'Outbox: неопубликованное событие старше минуты',
    })

    // Ответ кэшируется: второй запрос экрана Prometheus не трогает
    const asked = queries.length
    await health()
    expect(queries.length).toBe(asked)
  })

  it('не ответил — «недоступно», не задан — «выключено»; экран не падает', async () => {
    useEnv({ PROMETHEUS_URL: 'http://127.0.0.1:1', ALERTMANAGER_URL: 'http://127.0.0.1:1' })
    const unavailable = await health()
    expect(unavailable.metrics).toMatchObject({ status: 'unavailable', requestsPerSecond: null })
    expect(unavailable.alerts).toEqual({ status: 'unavailable', items: [] })
    expect(unavailable.components.map((c: { name: string }) => c.name)).toContain('postgres')

    useEnv({ PROMETHEUS_URL: undefined, ALERTMANAGER_URL: undefined, KCHS_VERSION: undefined })
    const off = await health()
    expect(off.metrics.status).toBe('off')
    expect(off.alerts).toEqual({ status: 'off', items: [] })
    expect(off.version).toBe('dev')
  })
})
