import { QUEUES } from '@kchs/contracts'
import { meter, metricsEnabled } from '~/shared/telemetry/metrics.js'
import { collabStats } from './collab/server.js'
import { outboxLag } from './events/dispatcher.js'
import { eventBusStats } from './events/streams.js'
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
    // Шина событий (ADR-0171): отставание групп подписчиков, неподтверждённые
    // записи, длина потоков до жёсткого предела и очередь сбоев — у worker,
    // где работают подписчики (как и глубина очередей — без задвоения рядов)
    const lag = m.createObservableGauge('kchs.events.lag', {
      unit: '{event}',
      description: 'Не полученные подписчиком события по всем потокам',
    })
    const pendingEvents = m.createObservableGauge('kchs.events.pending', {
      unit: '{event}',
      description: 'Полученные подписчиком, но не подтверждённые события',
    })
    const pendingAge = m.createObservableGauge('kchs.events.pending_oldest_age', {
      unit: 's',
      description: 'Возраст самого старого неподтверждённого события подписчика',
    })
    const streamLength = m.createObservableGauge('kchs.events.stream_length', {
      unit: '{event}',
      description: 'Записи потока событий (жёсткий предел — 1 000 000)',
    })
    const dlq = m.createObservableGauge('kchs.events.dlq', {
      unit: '{event}',
      description: 'События в очереди сбоев (DLQ)',
    })
    m.addBatchObservableCallback(
      async (result) => {
        const stats = await eventBusStats()
        for (const entry of stats.subscribers) {
          const labels = { subscriber: entry.subscriber }
          if (entry.lag !== null) result.observe(lag, entry.lag, labels)
          result.observe(pendingEvents, entry.pending, labels)
          result.observe(pendingAge, entry.oldestPendingSeconds ?? 0, labels)
        }
        for (const stream of stats.streams) {
          result.observe(streamLength, stream.length, { stream: stream.stream })
        }
        result.observe(dlq, stats.dlq)
      },
      [lag, pendingEvents, pendingAge, streamLength, dlq],
    )

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
    m.createObservableGauge('kchs.collab.documents', {
      unit: '{document}',
      description: 'Открытые документы совместного редактирования',
    }).addCallback((result) => result.observe(collabStats().documents))
    m.createObservableGauge('kchs.collab.connections', {
      unit: '{connection}',
      description: 'Подключения к документам совместного редактирования',
    }).addCallback((result) => result.observe(collabStats().connections))
  }
}
