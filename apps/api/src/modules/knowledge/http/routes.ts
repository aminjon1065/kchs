import { authorize } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { HelpService } from '../domain/help-service.js'
import { PageSearch } from '../domain/page-search.js'
import { PageService } from '../domain/page-service.js'
import { PageVersions } from '../domain/page-version-service.js'

/**
 * База знаний (13-search-knowledge-ai.md §2, ADR-0095). Тело страницы правится
 * совместно через `/collab` (ADR-0070), здесь — заведение, состояние и срок
 * пересмотра, публикация с версией, сравнение и откат, ознакомление, дерево
 * пространства и поиск по чанкам.
 */
export function registerKnowledgeRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /knowledge/help',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Что открывает пункт «Справка» у сотрудника (N88)',
    handler: async (request) => ({ page: await HelpService.forUser(request.ctx) }),
  })

  route({
    route: 'GET /knowledge/help/pages',
    auth: { capability: 'admin.system' },
    tags: ['knowledge'],
    summary: 'Страницы справки по языкам',
    handler: async () => HelpService.pages(),
  })

  route({
    route: 'PUT /knowledge/help/pages',
    auth: { capability: 'admin.system' },
    tags: ['knowledge'],
    summary: 'Выбрать страницы справки по языкам',
    handler: async (request) =>
      db().transaction((tx) => HelpService.update(tx, request.ctx, request.body)),
  })

  route({
    route: 'POST /pages',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Создать страницу базы знаний (с нуля или по шаблону)',
    description: 'Блоки шаблона попадают в документ сразу; дальше страница правится через /collab.',
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) =>
        PageService.create(tx, request.ctx, request.body, request.ctx.locale),
      )
      return { id }
    },
  })

  route({
    route: 'GET /pages/:id',
    auth: { delegated: 'PageService.get', objectType: 'page' },
    tags: ['knowledge'],
    summary: 'Страница: блоки, оглавление, состояние, права',
    description:
      'Снимок совместного документа: отстаёт от открытой страницы не больше чем на 10 с (ADR-0070).',
    handler: async (request) => PageService.get(request.ctx, request.params.id),
  })

  route({
    route: 'PATCH /pages/:id',
    auth: { delegated: 'PageService.update', objectType: 'page' },
    tags: ['knowledge'],
    summary: 'Владелец страницы, срок пересмотра, возврат в работу',
    handler: async (request) => PageService.update(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'POST /pages/:id/blocks',
    auth: { delegated: 'PageService.addBlocks', objectType: 'page' },
    tags: ['knowledge'],
    summary: 'Добавить блоки на страницу',
    description: 'Блоки сразу появляются у всех, кто открыл страницу.',
    handler: async (request) => PageService.addBlocks(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'POST /pages/:id/publish',
    auth: { delegated: 'PageService.publish', objectType: 'page' },
    tags: ['knowledge'],
    summary: 'Опубликовать страницу: снимок становится версией',
    handler: async (request) =>
      PageService.publish(request.ctx, request.params.id, {
        note: request.body.note,
        ...(request.body.reviewAt !== undefined ? { reviewAt: request.body.reviewAt } : {}),
      }),
  })

  route({
    route: 'GET /pages/:id/versions',
    auth: { delegated: 'PageVersions.list', objectType: 'page' },
    tags: ['knowledge'],
    summary: 'Версии страницы',
    handler: async (request) => ({
      items: await PageVersions.list(request.ctx, request.params.id),
    }),
  })

  route({
    route: 'POST /pages/:id/versions',
    auth: { delegated: 'PageVersions.create', objectType: 'page' },
    tags: ['knowledge'],
    summary: 'Сохранить версию страницы',
    handler: async (request) =>
      PageVersions.create(request.ctx, request.params.id, { note: request.body.note }),
  })

  route({
    route: 'GET /pages/:id/versions/compare',
    auth: { delegated: 'PageVersions.compare', objectType: 'page' },
    tags: ['knowledge'],
    summary: 'Сравнить версии страницы по словам',
    description: '`to` не задан — текущий текст страницы, `from` не задан — версия перед `to`.',
    handler: async (request) => PageVersions.compare(request.ctx, request.params.id, request.query),
  })

  route({
    route: 'GET /pages/:id/versions/:versionId',
    auth: { delegated: 'PageVersions.get', objectType: 'page' },
    tags: ['knowledge'],
    summary: 'Версия страницы: её блоки',
    handler: async (request) =>
      PageVersions.get(request.ctx, request.params.id, request.params.versionId),
  })

  route({
    route: 'POST /pages/:id/versions/:versionId/restore',
    auth: { delegated: 'PageVersions.restore', objectType: 'page' },
    tags: ['knowledge'],
    summary: 'Откатить страницу к версии',
    description: 'Текущий текст сохраняется версией, блоки версии возвращаются в документ.',
    handler: async (request) =>
      PageVersions.restore(request.ctx, request.params.id, request.params.versionId),
  })

  route({
    route: 'POST /pages/:id/acknowledgments',
    auth: { delegated: 'PageService.requestAcknowledgment', objectType: 'page' },
    tags: ['knowledge'],
    summary: 'Отправить страницу на ознакомление',
    handler: async (request) =>
      PageService.requestAcknowledgment(request.ctx, request.params.id, request.body),
  })

  route({
    route: 'GET /knowledge/tree',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Дерево страниц пространства (с `q` — найденное плоским списком)',
    handler: async (request) => ({ items: await PageService.tree(request.ctx, request.query) }),
  })

  route({
    route: 'GET /knowledge/search',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Поиск по базе знаний: куски страниц словами и по смыслу',
    description:
      'Смысл ищется, если подключён источник семантики (ADR-0095); без него выдача словесная.',
    handler: async (request) => PageSearch.run(request.ctx, request.query),
  })
}
