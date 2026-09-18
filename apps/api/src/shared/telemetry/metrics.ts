import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { type Meter, metrics } from '@opentelemetry/api'
import { serviceAttributes } from './tracing.js'

/**
 * Метрики OpenTelemetry → Prometheus (15-admin-operations.md §4, ADR-0045).
 * Эндпоинт `/metrics` — на отдельном порту `METRICS_PORT`: прокси (Caddy) его не
 * публикует, в compose порт не пробрасывается — его читает только Prometheus во
 * внутренней сети. Без `METRICS_PORT` провайдер не создаётся: `meter()` отдаёт
 * пустые инструменты, а обработчики запросов метрик не пишут.
 */

let shutdownProvider: (() => Promise<void>) | null = null

export function metricsEnabled(): boolean {
  return shutdownProvider !== null
}

/**
 * Инструменты создаются после `startMetrics`: созданные раньше остаются
 * пустыми навсегда (у API метрик нет отложенного провайдера).
 */
export function meter(): Meter {
  return metrics.getMeter('kchs')
}

export interface MetricsOptions {
  port: number
  host: string
  onError: (error: Error) => void
}

export async function startMetrics(options: MetricsOptions): Promise<void> {
  if (shutdownProvider) return
  const [{ MeterProvider }, { PrometheusExporter }, { resourceFromAttributes }] = await Promise.all(
    [
      import('@opentelemetry/sdk-metrics'),
      import('@opentelemetry/exporter-prometheus'),
      import('@opentelemetry/resources'),
    ],
  )

  const exporter = new PrometheusExporter(
    { port: options.port, host: options.host, withoutScopeInfo: true },
    (error) => {
      if (error) options.onError(error)
    },
  )
  const provider = new MeterProvider({
    resource: resourceFromAttributes(serviceAttributes()),
    readers: [exporter],
  })
  metrics.setGlobalMeterProvider(provider)
  shutdownProvider = () => provider.shutdown()
  registerProcessMetrics(meter())
}

/** Закрывает эндпоинт и снимает глобальный провайдер (тесты в одном процессе). */
export async function stopMetrics(): Promise<void> {
  await shutdownProvider?.().catch(() => undefined)
  shutdownProvider = null
  metrics.disable()
}

/**
 * Метрики процесса: память (бюджет RSS ≤ 1 ГБ, 04-verification.md §4), CPU,
 * задержка и загрузка цикла событий. Имена — по семантическим соглашениям
 * OpenTelemetry; в Prometheus точки становятся подчёркиваниями, единица к имени
 * не добавляется, у счётчиков — суффикс `_total` (`process_cpu_time_total`).
 */
function registerProcessMetrics(m: Meter): void {
  m.createObservableGauge('process.memory.usage', {
    unit: 'By',
    description: 'Резидентная память процесса (RSS)',
  }).addCallback((result) => result.observe(process.memoryUsage.rss()))

  m.createObservableGauge('v8js.memory.heap.used', {
    unit: 'By',
    description: 'Занятая куча V8',
  }).addCallback((result) => result.observe(process.memoryUsage().heapUsed))

  m.createObservableCounter('process.cpu.time', {
    unit: 's',
    description: 'Процессорное время процесса',
  }).addCallback((result) => {
    const usage = process.cpuUsage()
    result.observe(usage.user / 1e6, { 'cpu.mode': 'user' })
    result.observe(usage.system / 1e6, { 'cpu.mode': 'system' })
  })

  const loopDelay = monitorEventLoopDelay({ resolution: 20 })
  loopDelay.enable()
  const delayP99 = m.createObservableGauge('nodejs.eventloop.delay.p99', {
    unit: 's',
    description: 'Задержка цикла событий, 99-й перцентиль с прошлого снятия',
  })
  const delayMax = m.createObservableGauge('nodejs.eventloop.delay.max', {
    unit: 's',
    description: 'Наибольшая задержка цикла событий с прошлого снятия',
  })
  m.addBatchObservableCallback(
    (result) => {
      result.observe(delayP99, loopDelay.percentile(99) / 1e9)
      result.observe(delayMax, loopDelay.max / 1e9)
      loopDelay.reset()
    },
    [delayP99, delayMax],
  )

  let lastUtilization = performance.eventLoopUtilization()
  m.createObservableGauge('nodejs.eventloop.utilization', {
    unit: '1',
    description: 'Доля времени, когда цикл событий занят, с прошлого снятия',
  }).addCallback((result) => {
    const now = performance.eventLoopUtilization()
    result.observe(performance.eventLoopUtilization(now, lastUtilization).utilization)
    lastUtilization = now
  })
}
