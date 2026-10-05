import { authorize } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { stepVersions } from '../domain/routes/provider.js'
import { DocumentRoutes } from '../domain/routes/route-service.js'
import { DocumentSignatures } from '../domain/routes/signatures.js'

/**
 * Маршруты документа из карточки (08-documents.md §4, §9, ADR-0083): какие
 * маршруты доступны, «кто будет назначен», запуск, версии шагов и подписи.
 * Линия шагов, решения, передача и отмена — общее API движка `/processes`.
 */
export function registerDocumentProcessRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /documents/:id/routes',
    auth: { delegated: 'DocumentRoutes.options', objectType: 'document' },
    tags: ['documents'],
    summary: 'Маршруты, по которым можно отправить документ, и можно ли сейчас',
    handler: async (request) => DocumentRoutes.options(request.ctx, request.params.id),
  })

  route({
    route: 'POST /documents/:id/routes/preview',
    auth: { delegated: 'DocumentRoutes.preview', objectType: 'document' },
    tags: ['documents'],
    summary: 'Предпросмотр маршрута на документе: кто будет назначен, сроки',
    readOnly: true,
    handler: async (request) =>
      DocumentRoutes.preview(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'POST /documents/:id/routes',
    auth: { delegated: 'DocumentRoutes.start', objectType: 'document' },
    tags: ['documents'],
    summary: 'Отправить документ по маршруту: согласование, подпись, регистрация',
    handler: async (request) => {
      const { instanceId } = await db().transaction((tx) =>
        DocumentRoutes.start(tx, request.ctx, request.params.id, request.body),
      )
      return { id: instanceId }
    },
  })

  route({
    route: 'GET /documents/:id/route-versions',
    auth: { delegated: 'authorize(view)', objectType: 'document' },
    tags: ['documents'],
    summary: 'Какую версию видел каждый шаг согласования и подписи',
    handler: async (request) => {
      await authorize(request.ctx, 'view', request.params.id)
      const versions = await stepVersions(db(), request.params.id)
      return {
        items: [...versions.entries()].map(([stepId, version]) => ({
          stepId,
          versionId: version.versionId,
          versionNumber: version.number,
        })),
      }
    },
  })

  route({
    route: 'GET /documents/:id/signatures',
    auth: { delegated: 'DocumentSignatures.list', objectType: 'document' },
    tags: ['documents'],
    summary: 'Подписи документа и их проверка по хэшу версии',
    handler: async (request) => ({
      items: await DocumentSignatures.list(request.ctx, request.params.id),
    }),
  })
}
