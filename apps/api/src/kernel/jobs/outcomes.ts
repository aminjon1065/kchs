import type { EventEnvelope, JobRecord, QueueName } from '@kchs/contracts'
import type { Subscriber } from '../events/types.js'
import { JobService } from './service.js'

/** Вид задания: очередь и имя, как при постановке. */
export interface JobKind {
  queue: QueueName
  name: string
}

/** Задание закрыто не успехом: окончательный сбой или отмена. */
export interface JobClosed {
  job: JobRecord
  /** Данные, с которыми задание поставлено (`JobService.payload`). */
  payload: Record<string, unknown> | null
  outcome: 'failed' | 'cancelled'
  /** Причина для записи модуля: текст сбоя или {@link JOB_CANCELLED_REASON}. */
  reason: string
}

export const JOB_CANCELLED_REASON = 'Задание отменено'

/**
 * Подписчик модуля на окончательный сбой и отмену своих заданий (ADR-0187): запись
 * модуля — импорт, рендер, запуск отчёта, пайплайна, источника, анализа — не
 * остаётся «в работе», когда задание закрыто не успехом. Отдельного статуса отмены
 * у этих записей нет: отмена закрывает их, как сбой, с причиной «Задание отменено».
 *
 * Имя подписчика — его группа потребителей событий (ADR-0171): у существующего
 * подписчика его не меняют, иначе после обновления группа начнёт с новых событий.
 */
export function jobClosedSubscriber(input: {
  name: string
  jobs: readonly JobKind[]
  /** Причина сбоя, если задание не сообщило свою. */
  fallbackReason?: string
  onClosed: (closed: JobClosed) => Promise<void>
}): Subscriber {
  return {
    name: input.name,
    types: ['job.failed', 'job.cancelled'],
    handle: async (event) => {
      const jobId = jobIdOf(event)
      if (!jobId) return
      const job = await JobService.get(jobId)
      if (!job || !input.jobs.some((kind) => kind.queue === job.queue && kind.name === job.name)) {
        return
      }
      const outcome = event.type === 'job.cancelled' ? 'cancelled' : 'failed'
      await input.onClosed({
        job,
        payload: await JobService.payload(job.id),
        outcome,
        reason: closedReason(event, input.fallbackReason),
      })
    },
  }
}

/** Причина закрытия по событию; экспортирована для тестов. */
export function closedReason(
  event: Pick<EventEnvelope, 'type' | 'payload'>,
  fallback = 'Сбой задания',
): string {
  if (event.type === 'job.cancelled') return JOB_CANCELLED_REASON
  const error = event.payload?.error
  return typeof error === 'string' && error ? error : fallback
}

function jobIdOf(event: EventEnvelope): string | null {
  const jobId = event.payload?.jobId
  return typeof jobId === 'string' && jobId ? jobId : null
}
