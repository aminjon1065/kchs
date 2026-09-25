import type { HealthAlerts, HealthMetrics } from '@kchs/contracts'
import { config } from '~/shared/config/env.js'
import { logger } from '~/shared/logger/index.js'

/**
 * Метрики и оповещения для экрана «Здоровье системы» (ADR-0167): мгновенные запросы к
 * Prometheus и список действующих оповещений Alertmanager профиля observability. Сбор
 * не настроен — `off`, не ответил — `unavailable`; экран от этого не ломается.
 * Ответ кэшируется на 15 с: экран открывают несколько администраторов, а Prometheus
 * пересчитывает `rate()` на каждый запрос.
 */
const TIMEOUT_MS = 2_000
const CACHE_MS = 15_000

// api — задание kchs-api в установке и kchs-dev при разработке (prometheus.yml)
const API = 'job=~"kchs-api|kchs-dev"'
const APP = 'job=~"kchs-api|kchs-worker|kchs-dev"'
const REQUESTS = `http_server_request_duration_count{${API},http_route!="/health"}`

function queries(database: string): Record<Exclude<keyof HealthMetrics, 'status'>, string> {
  return {
    requestsPerSecond: `sum(rate(${REQUESTS}[5m]))`,
    errorRate:
      `sum(rate(http_server_request_duration_count{${API},http_response_status_code=~"5.."}[5m]))` +
      ` / sum(rate(${REQUESTS}[5m]))`,
    latencyP95Ms:
      'histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_bucket' +
      `{${API},http_route!="/health"}[5m]))) * 1000`,
    memoryBytes: `max(process_memory_usage{${APP}})`,
    postgresSizeBytes: `sum(pg_database_size_bytes{datname=${JSON.stringify(database)}})`,
    postgresConnections: 'sum(pg_stat_activity_count)',
    redisUsedBytes: 'max(redis_memory_used_bytes)',
    redisMaxBytes: 'max(redis_memory_max_bytes)',
  }
}

/** Имя базы приложения — из строки подключения: у Prometheus размеры всех баз сервера. */
function databaseName(): string {
  try {
    return decodeURIComponent(new URL(config().DATABASE_URL).pathname.slice(1)) || 'kchs'
  } catch {
    return 'kchs'
  }
}

interface PromVector {
  status: string
  data?: { resultType: string; result: Array<{ value: [number, string] }> }
}

async function instant(base: string, query: string): Promise<number | null> {
  const url = new URL('/api/v1/query', base)
  url.searchParams.set('query', query)
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Prometheus: ${response.status}`)
  const body = (await response.json()) as PromVector
  const raw = body.data?.result[0]?.value[1]
  if (raw === undefined) return null
  const value = Number(raw)
  // 0/0 (нет запросов за окно) и пустой ряд — «нет данных», а не ноль
  return Number.isFinite(value) ? value : null
}

async function readMetrics(): Promise<HealthMetrics> {
  const base = config().PROMETHEUS_URL
  const empty = {
    requestsPerSecond: null,
    errorRate: null,
    latencyP95Ms: null,
    memoryBytes: null,
    postgresSizeBytes: null,
    postgresConnections: null,
    redisUsedBytes: null,
    redisMaxBytes: null,
  }
  if (!base) return { status: 'off', ...empty }
  const entries = Object.entries(queries(databaseName()))
  try {
    const values = await Promise.all(entries.map(([, query]) => instant(base, query)))
    return {
      status: 'ok',
      ...empty,
      ...Object.fromEntries(entries.map(([key], index) => [key, values[index] ?? null])),
    }
  } catch (error) {
    logger().warn({ err: error }, 'health: Prometheus не ответил')
    return { status: 'unavailable', ...empty }
  }
}

interface AlertmanagerAlert {
  labels?: Record<string, string>
  annotations?: Record<string, string>
  startsAt?: string
}

async function readAlerts(): Promise<HealthAlerts> {
  const base = config().ALERTMANAGER_URL
  if (!base) return { status: 'off', items: [] }
  try {
    const url = new URL('/api/v2/alerts', base)
    url.searchParams.set('active', 'true')
    url.searchParams.set('silenced', 'false')
    url.searchParams.set('inhibited', 'false')
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) throw new Error(`Alertmanager: ${response.status}`)
    const alerts = (await response.json()) as AlertmanagerAlert[]
    const items = alerts
      .map((alert) => ({
        name: alert.labels?.alertname ?? '',
        severity: alert.labels?.severity ?? null,
        summary: alert.annotations?.summary ?? null,
        startsAt: alert.startsAt ?? new Date(0).toISOString(),
      }))
      // Сначала критичные, внутри — давние
      .sort(
        (a, b) =>
          Number(b.severity === 'critical') - Number(a.severity === 'critical') ||
          a.startsAt.localeCompare(b.startsAt),
      )
      .slice(0, 50)
    return { status: 'ok', items }
  } catch (error) {
    logger().warn({ err: error }, 'health: Alertmanager не ответил')
    return { status: 'unavailable', items: [] }
  }
}

let cached: {
  at: number
  value: Promise<{ metrics: HealthMetrics; alerts: HealthAlerts }>
} | null = null

export function observabilitySnapshot(): Promise<{
  metrics: HealthMetrics
  alerts: HealthAlerts
}> {
  const now = Date.now()
  if (!cached || now - cached.at > CACHE_MS) {
    const value = Promise.all([readMetrics(), readAlerts()]).then(([metrics, alerts]) => ({
      metrics,
      alerts,
    }))
    cached = { at: now, value }
  }
  return cached.value
}

/** Сброс кэша — для тестов. */
export function resetObservabilityCache(): void {
  cached = null
}
