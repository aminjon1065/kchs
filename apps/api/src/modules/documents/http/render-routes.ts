import type { RouteRegistrar } from '~/shared/http/route.js'
import { compareVersions } from '../domain/compare/compare-service.js'
import { DocumentRenders } from '../domain/render-service.js'

/**
 * Печатные формы, штампы, копии с водяным знаком и сравнение версий
 * (08-documents.md §5, §8, §13; ADR-0085). Рендер строит движок: он берёт план
 * и сообщает результат внутренними маршрутами с сервисным токеном.
 */
export function registerRenderRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /documents/print-forms',
    auth: 'session',
    tags: ['documents'],
    summary: 'Печатные формы документа или журнала — с причиной недоступности',
    handler: async (request) => ({
      items: await DocumentRenders.forms(request.ctx, request.query.subjectId),
    }),
  })

  route({
    route: 'POST /documents/prints',
    auth: 'session',
    tags: ['documents'],
    summary: 'Заказать печатную форму: PDF строит движок и прикрепляет к объекту',
    handler: async (request) => {
      const id = await DocumentRenders.requestPrint(request.ctx, request.body)
      return DocumentRenders.get(request.ctx, id)
    },
  })

  route({
    route: 'POST /documents/watermarked',
    auth: 'session',
    tags: ['documents'],
    summary: 'Копия файла с грифом под водяным знаком смотрящего',
    handler: async (request) => {
      const id = await DocumentRenders.requestWatermark(request.ctx, request.body.fileId)
      return DocumentRenders.get(request.ctx, id)
    },
  })

  route({
    route: 'GET /documents/renders',
    auth: 'session',
    tags: ['documents'],
    summary: 'Печатные формы и заполнения шаблонов объекта',
    handler: async (request) => ({
      items: await DocumentRenders.list(request.ctx, request.query.subjectId),
    }),
  })

  route({
    route: 'GET /documents/renders/:id',
    auth: { delegated: 'DocumentRenders.get', resource: 'render' },
    tags: ['documents'],
    summary: 'Состояние рендера: в очереди, строится, готов, не удался',
    handler: async (request) => DocumentRenders.get(request.ctx, request.params.id),
  })

  route({
    route: 'GET /documents/renders/:id/download',
    auth: { delegated: 'DocumentRenders.download', resource: 'render' },
    tags: ['documents'],
    summary: 'Ссылка на готовую копию с водяным знаком',
    handler: async (request) => DocumentRenders.download(request.ctx, request.params.id),
  })

  route({
    route: 'GET /documents/:id/versions/compare',
    auth: { delegated: 'compareVersions → authorize(view)', objectType: 'document' },
    tags: ['documents'],
    summary: 'Сравнение двух версий документа по словам',
    handler: async (request) => compareVersions(request.ctx, request.params.id, request.query),
  })

  // ─── Движок (токен задания, внутренняя сеть, ADR-0176) ─────────────────────

  route({
    route: 'POST /internal/documents/renders/:id/start',
    auth: { engineJob: { scope: (params) => `document-render:${params.id}` } },
    tags: ['internal'],
    summary: 'Движок начинает рендер: план с правами заказчика на этот момент',
    handler: async (request) => DocumentRenders.engineStart(request.params.id),
  })

  route({
    route: 'POST /internal/documents/renders/:id/done',
    auth: { engineJob: { scope: (params) => `document-render:${params.id}` } },
    tags: ['internal'],
    summary: 'Движок положил результат рендера под выданный ключ',
    handler: async (request) => {
      const { stale } = await DocumentRenders.engineDone(request.params.id, request.body)
      return { ok: true, stale }
    },
  })
}
