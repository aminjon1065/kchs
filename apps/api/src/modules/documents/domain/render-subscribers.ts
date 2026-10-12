import { DocumentPdfResult, type EventEnvelope } from '@kchs/contracts'
import type { Subscriber } from '~/kernel/events/types.js'
import { jobClosedSubscriber } from '~/kernel/jobs/outcomes.js'
import { logger } from '~/shared/logger/index.js'
import { DocumentRenders, RENDER_JOB } from './render-service.js'
import { DocumentVersionService, PDF_JOB } from './version-service.js'

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

/**
 * Подписанный экземпляр (ADR-0198): после подписи, регистрации, готовности PDF,
 * окончания маршрута и правки места факсимиле — решает `scheduleSignedCopy`.
 */
async function signedCopy(event: EventEnvelope): Promise<void> {
  if (event.object?.type !== 'document') return
  if (event.type === 'document.version_pdf_ready' && event.payload.status !== 'ready') return
  const id = await DocumentRenders.scheduleSignedCopy(event.object.id)
  if (id) {
    logger().info({ documentId: event.object.id, renderId: id }, 'подписанный экземпляр заказан')
  }
}

export const renderSubscribers: Subscriber[] = [
  {
    name: 'documents-stamp',
    types: ['document.registered', 'document.version_pdf_ready'],
    handle: stamp,
  },
  {
    name: 'documents-signed-copy',
    types: [
      'document.signed',
      'document.registered',
      'document.version_pdf_ready',
      'document.signature_placed',
      'process.finished',
    ],
    handle: signedCopy,
  },
  // Окончательный сбой или отмена задания движка: рендер не остаётся «в работе»
  // навсегда (ADR-0187)
  jobClosedSubscriber({
    name: 'documents-render-failed',
    jobs: [RENDER_JOB],
    fallbackReason: 'Сбой движка',
    onClosed: async ({ payload, reason }) => {
      const renderId = typeof payload?.renderId === 'string' ? payload.renderId : null
      if (renderId) await DocumentRenders.failById(renderId, reason)
    },
  }),
  // PDF-представление версии — так же: иначе версия навсегда «PDF готовится»
  jobClosedSubscriber({
    name: 'documents-pdf-failed',
    jobs: [PDF_JOB],
    fallbackReason: 'Сбой движка',
    onClosed: async ({ payload, reason }) => {
      const versionId = typeof payload?.versionId === 'string' ? payload.versionId : null
      if (!versionId) return
      await DocumentVersionService.applyPdfResult(
        versionId,
        DocumentPdfResult.parse({ status: 'failed', error: reason.slice(0, 4000) }),
      )
    },
  }),
]
