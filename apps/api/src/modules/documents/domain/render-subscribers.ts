import type { EventEnvelope } from '@kchs/contracts'
import type { Subscriber } from '~/kernel/events/types.js'
import { JobService } from '~/kernel/jobs/service.js'
import { logger } from '~/shared/logger/index.js'
import { DocumentRenders, RENDER_JOB } from './render-service.js'

/**
 * Штамп регистрации ставится сам (ADR-0085): при регистрации, а если PDF
 * текущей версии тогда ещё строился — когда он будет готов.
 */
async function stamp(event: EventEnvelope): Promise<void> {
  if (event.object?.type !== 'document') return
  if (event.type === 'document.version_pdf_ready' && event.payload.status !== 'ready') return
  const id = await DocumentRenders.scheduleStamp(event.object.id, event.actor.userId)
  if (id) logger().info({ documentId: event.object.id, renderId: id }, 'штамп регистрации заказан')
}

/** Окончательный сбой задания движка: рендер не остаётся «в работе» навсегда. */
async function jobFailed(event: EventEnvelope): Promise<void> {
  const job = await JobService.get(String(event.payload.jobId))
  if (job?.queue !== RENDER_JOB.queue || job.name !== RENDER_JOB.name) return
  const payload = await JobService.payload(job.id)
  const renderId = typeof payload?.renderId === 'string' ? payload.renderId : null
  if (!renderId) return
  await DocumentRenders.failById(renderId, String(event.payload.error ?? 'Сбой движка'))
}

export const renderSubscribers: Subscriber[] = [
  {
    name: 'documents-stamp',
    types: ['document.registered', 'document.version_pdf_ready'],
    handle: stamp,
  },
  { name: 'documents-render-failed', types: ['job.failed'], handle: jobFailed },
]
