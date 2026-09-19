import {
  DocumentRenderDownload,
  DocumentRenderList,
  DocumentRenderRecord,
  DocumentRenderResult,
  DocumentRenderStart,
  PrintFormList,
  PrintRequestInput,
  VersionCompareQuery,
  VersionCompareResult,
  WatermarkRequestInput,
} from '@kchs/contracts'
import { z } from 'zod'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { validServiceToken } from '~/shared/http/service-token.js'
import { compareVersions } from '../domain/compare/compare-service.js'
import { DocumentRenders } from '../domain/render-service.js'

const IdParam = z.object({ id: z.uuid() })
const SubjectQuery = z.object({ subjectId: z.uuid() })

/**
 * Печатные формы, штампы, копии с водяным знаком и сравнение версий
 * (08-documents.md §5, §8, §13; ADR-0085). Рендер строит движок: он берёт план
 * и сообщает результат внутренними маршрутами с сервисным токеном.
 */
export function registerRenderRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/documents/print-forms',
    auth: 'session',
    tags: ['documents'],
    summary: 'Печатные формы документа или журнала — с причиной недоступности',
    schema: { querystring: SubjectQuery, response: { 200: PrintFormList } },
    handler: async (request) => ({
      items: await DocumentRenders.forms(request.ctx, request.query.subjectId),
    }),
  })

  route({
    method: 'POST',
    url: '/documents/prints',
    auth: 'session',
    tags: ['documents'],
    summary: 'Заказать печатную форму: PDF строит движок и прикрепляет к объекту',
    schema: { body: PrintRequestInput, response: { 200: DocumentRenderRecord } },
    handler: async (request) => {
      const id = await DocumentRenders.requestPrint(request.ctx, request.body)
      return DocumentRenders.get(request.ctx, id)
    },
  })

  route({
    method: 'POST',
    url: '/documents/watermarked',
    auth: 'session',
    tags: ['documents'],
    summary: 'Копия файла с грифом под водяным знаком смотрящего',
    schema: { body: WatermarkRequestInput, response: { 200: DocumentRenderRecord } },
    handler: async (request) => {
      const id = await DocumentRenders.requestWatermark(request.ctx, request.body.fileId)
      return DocumentRenders.get(request.ctx, id)
    },
  })

  route({
    method: 'GET',
    url: '/documents/renders',
    auth: 'session',
    tags: ['documents'],
    summary: 'Печатные формы и заполнения шаблонов объекта',
    schema: { querystring: SubjectQuery, response: { 200: DocumentRenderList } },
    handler: async (request) => ({
      items: await DocumentRenders.list(request.ctx, request.query.subjectId),
    }),
  })

  route({
    method: 'GET',
    url: '/documents/renders/:id',
    auth: 'session',
    tags: ['documents'],
    summary: 'Состояние рендера: в очереди, строится, готов, не удался',
    schema: { params: IdParam, response: { 200: DocumentRenderRecord } },
    handler: async (request) => DocumentRenders.get(request.ctx, request.params.id),
  })

  route({
    method: 'GET',
    url: '/documents/renders/:id/download',
    auth: 'session',
    tags: ['documents'],
    summary: 'Ссылка на готовую копию с водяным знаком',
    schema: { params: IdParam, response: { 200: DocumentRenderDownload } },
    handler: async (request) => DocumentRenders.download(request.ctx, request.params.id),
  })

  route({
    method: 'GET',
    url: '/documents/:id/versions/compare',
    auth: 'session',
    tags: ['documents'],
    summary: 'Сравнение двух версий документа по словам',
    schema: {
      params: IdParam,
      querystring: VersionCompareQuery,
      response: { 200: VersionCompareResult },
    },
    handler: async (request) => compareVersions(request.ctx, request.params.id, request.query),
  })

  // ─── Движок (сервисный токен, внутренняя сеть) ─────────────────────────────

  route({
    method: 'POST',
    url: '/internal/documents/renders/:id/start',
    auth: 'public',
    tags: ['internal'],
    summary: 'Движок начинает рендер: план с правами заказчика на этот момент',
    schema: { params: IdParam, response: { 200: DocumentRenderStart } },
    handler: async (request) => {
      if (!validServiceToken(request.headers['x-kchs-service-token'])) {
        throw errors.unauthorized('Недействительный сервисный токен')
      }
      return DocumentRenders.engineStart(request.params.id)
    },
  })

  route({
    method: 'POST',
    url: '/internal/documents/renders/:id/done',
    auth: 'public',
    tags: ['internal'],
    summary: 'Движок положил результат рендера под выданный ключ',
    schema: {
      params: IdParam,
      body: DocumentRenderResult,
      response: { 200: z.object({ ok: z.boolean(), stale: z.boolean() }) },
    },
    handler: async (request) => {
      if (!validServiceToken(request.headers['x-kchs-service-token'])) {
        throw errors.unauthorized('Недействительный сервисный токен')
      }
      const { stale } = await DocumentRenders.engineDone(request.params.id, request.body)
      return { ok: true, stale }
    },
  })
}
