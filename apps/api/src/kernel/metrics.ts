import { QUEUES } from '@kchs/contracts'
import { meter, metricsEnabled } from '~/shared/telemetry/metrics.js'
import { outboxLag } from './events/dispatcher.js'
import { queue } from './jobs/service.js'
import { realtimeConnections } from './realtime/gateway.js'

const JOB_STATES = ['waiting', 'prioritized', 'active', 'delayed', 'failed'] as const

/**
 * Метрики ядра для Prometheus (15-admin-operations.md §4). Снимаются при каждом
 * опросе: outbox — «нет неопубликованных старше 1 мин» (04-verification.md §5),
 * глубина очередей — «очередь растёт > 15 мин», подключения realtime.
 * Outbox общий для всех процессов: алерт берёт максимум по экземплярам.
 */
export function registerKernelMetrics(options: { queues: boolean; realtime: boolean }): void {
  if (!metricsEnabled()) return
  const m = meter()

  const pending = m.createObservableGauge('kchs.outbox.pending', {
    unit: '{event}',
    description: 'Неопубликованные события outbox',
  })
  const oldest = m.createObservableGauge('kchs.outbox.oldest_age', {
    unit: 's',
    description: 'Возраст самого старого неопубликованного события',
  })
  m.addBatchObservableCallback(
    async (result) => {
      const lag = await outboxLag()
      result.observe(pending, lag.pending)
      result.observe(oldest, lag.oldestSeconds ?? 0)
    },
    [pending, oldest],
  )

  if (options.queues) {
    m.createObservableGauge('kchs.queue.jobs', {
      unit: '{job}',
      description: 'Задания в очередях BullMQ по состояниям',
    }).addCallback(async (result) => {
      await Promise.all(
        QUEUES.map(async (name) => {
          const counts = await queue(name).getJobCounts(...JOB_STATES)
          for (const state of JOB_STATES) result.observe(counts[state] ?? 0, { queue: name, state })
        }),
      )
    })
  }

  if (options.realtime) {
    m.createObservableGauge('kchs.realtime.connections', {
      unit: '{connection}',
      description: 'Открытые WebSocket-подключения',
    }).addCallback((result) => result.observe(realtimeConnections()))
  }
}
