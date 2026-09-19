import {
  DocumentRouteOptions,
  DocumentRouteStartInput,
  DocumentRouteStepVersions,
  DocumentSignatureList,
} from '@kchs/contracts'
import { ProcessPreview } from '@kchs/process'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { stepVersions } from '../domain/routes/provider.js'
import { DocumentRoutes } from '../domain/routes/route-service.js'
import { DocumentSignatures } from '../domain/routes/signatures.js'

const IdParam = z.object({ id: z.uuid() })

/**
 * Маршруты документа из карточки (08-documents.md §4, §9, ADR-0083): какие
 * маршруты доступны, «кто будет назначен», запуск, версии шагов и подписи.
 * Линия шагов, решения, передача и отмена — общее API движка `/processes`.
 */
export function registerDocumentProcessRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/documents/:id/routes',
    auth: 'session',
    tags: ['documents'],
    summary: 'Маршруты, по которым можно отправить документ, и можно ли сейчас',
    schema: { params: IdParam, response: { 200: DocumentRouteOptions } },
    handler: async (request) => DocumentRoutes.options(request.ctx, request.params.id),
  })

  route({
    method: 'POST',
    url: '/documents/:id/routes/preview',
    auth: 'session',
    tags: ['documents'],
    summary: 'Предпросмотр маршрута на документе: кто будет назначен, сроки',
    readOnly: true,
    schema: { params: IdParam, body: DocumentRouteStartInput, response: { 200: ProcessPreview } },
    handler: async (request) =>
      DocumentRoutes.preview(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'POST',
    url: '/documents/:id/routes',
    auth: 'session',
    tags: ['documents'],
    summary: 'Отправить документ по маршруту: согласование, подпись, регистрация',
    schema: {
      params: IdParam,
      body: DocumentRouteStartInput,
      response: { 200: z.object({ id: z.uuid() }) },
    },
    handler: async (request) => {
      const { instanceId } = await db().transaction((tx) =>
        DocumentRoutes.start(tx, request.ctx, request.params.id, request.body),
      )
      return { id: instanceId }
    },
  })

  route({
    method: 'GET',
    url: '/documents/:id/route-versions',
    auth: 'session',
    tags: ['documents'],
    summary: 'Какую версию видел каждый шаг согласования и подписи',
    schema: { params: IdParam, response: { 200: DocumentRouteStepVersions } },
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
    method: 'GET',
    url: '/documents/:id/signatures',
    auth: 'session',
    tags: ['documents'],
    summary: 'Подписи документа и их проверка по хэшу версии',
    schema: { params: IdParam, response: { 200: DocumentSignatureList } },
    handler: async (request) => ({
      items: await DocumentSignatures.list(request.ctx, request.params.id),
    }),
  })
}
