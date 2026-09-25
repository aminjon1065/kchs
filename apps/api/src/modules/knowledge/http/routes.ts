import {
  HelpLink,
  HelpPages,
  HelpPagesPatch,
  PageAcknowledgeInput,
  PageBlocksInput,
  PageCreateInput,
  PagePublishInput,
  PageRecord,
  PageSearchQuery,
  PageSearchResult,
  PageTreeQuery,
  PageTreeResult,
  PageUpdateInput,
  PageVersionCompareQuery,
  PageVersionCompareResult,
  PageVersionDetail,
  PageVersionInput,
  PageVersionRecord,
} from '@kchs/contracts'
import { z } from 'zod'
import { authorize } from '~/kernel/access/authorize.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { HelpService } from '../domain/help-service.js'
import { PageSearch } from '../domain/page-search.js'
import { PageService } from '../domain/page-service.js'
import { PageVersions } from '../domain/page-version-service.js'

const IdParam = z.object({ id: z.uuid() })
const VersionParams = z.object({ id: z.uuid(), versionId: z.uuid() })

/**
 * База знаний (13-search-knowledge-ai.md §2, ADR-0095). Тело страницы правится
 * совместно через `/collab` (ADR-0070), здесь — заведение, состояние и срок
 * пересмотра, публикация с версией, сравнение и откат, ознакомление, дерево
 * пространства и поиск по чанкам.
 */
export function registerKnowledgeRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/knowledge/help',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Что открывает пункт «Справка» у сотрудника (N88)',
    schema: { response: { 200: HelpLink } },
    handler: async (request) => ({ page: await HelpService.forUser(request.ctx) }),
  })

  route({
    method: 'GET',
    url: '/knowledge/help/pages',
    auth: { capability: 'admin.system' },
    tags: ['knowledge'],
    summary: 'Страницы справки по языкам',
    schema: { response: { 200: HelpPages } },
    handler: async () => HelpService.pages(),
  })

  route({
    method: 'PUT',
    url: '/knowledge/help/pages',
    auth: { capability: 'admin.system' },
    tags: ['knowledge'],
    summary: 'Выбрать страницы справки по языкам',
    schema: { body: HelpPagesPatch, response: { 200: HelpPages } },
    handler: async (request) =>
      db().transaction((tx) => HelpService.update(tx, request.ctx, request.body)),
  })

  route({
    method: 'POST',
    url: '/pages',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Создать страницу базы знаний (с нуля или по шаблону)',
    description: 'Блоки шаблона попадают в документ сразу; дальше страница правится через /collab.',
    schema: { body: PageCreateInput, response: { 200: z.object({ id: z.uuid() }) } },
    handler: async (request) => {
      await authorize(request.ctx, 'create_child', request.body.parentId ?? request.body.spaceId)
      const id = await db().transaction((tx) =>
        PageService.create(tx, request.ctx, request.body, request.ctx.locale),
      )
      return { id }
    },
  })

  route({
    method: 'GET',
    url: '/pages/:id',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Страница: блоки, оглавление, состояние, права',
    description:
      'Снимок совместного документа: отстаёт от открытой страницы не больше чем на 10 с (ADR-0070).',
    schema: { params: IdParam, response: { 200: PageRecord } },
    handler: async (request) => PageService.get(request.ctx, request.params.id),
  })

  route({
    method: 'PATCH',
    url: '/pages/:id',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Владелец страницы, срок пересмотра, возврат в работу',
    schema: { params: IdParam, body: PageUpdateInput, response: { 200: PageRecord } },
    handler: async (request) => PageService.update(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'POST',
    url: '/pages/:id/blocks',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Добавить блоки на страницу',
    description: 'Блоки сразу появляются у всех, кто открыл страницу.',
    schema: { params: IdParam, body: PageBlocksInput, response: { 200: PageRecord } },
    handler: async (request) => PageService.addBlocks(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'POST',
    url: '/pages/:id/publish',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Опубликовать страницу: снимок становится версией',
    schema: { params: IdParam, body: PagePublishInput, response: { 200: PageRecord } },
    handler: async (request) =>
      PageService.publish(request.ctx, request.params.id, {
        note: request.body.note,
        ...(request.body.reviewAt !== undefined ? { reviewAt: request.body.reviewAt } : {}),
      }),
  })

  route({
    method: 'GET',
    url: '/pages/:id/versions',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Версии страницы',
    schema: { params: IdParam, response: { 200: z.object({ items: z.array(PageVersionRecord) }) } },
    handler: async (request) => ({
      items: await PageVersions.list(request.ctx, request.params.id),
    }),
  })

  route({
    method: 'POST',
    url: '/pages/:id/versions',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Сохранить версию страницы',
    schema: { params: IdParam, body: PageVersionInput, response: { 200: PageVersionRecord } },
    handler: async (request) =>
      PageVersions.create(request.ctx, request.params.id, { note: request.body.note }),
  })

  route({
    method: 'GET',
    url: '/pages/:id/versions/compare',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Сравнить версии страницы по словам',
    description: '`to` не задан — текущий текст страницы, `from` не задан — версия перед `to`.',
    schema: {
      params: IdParam,
      querystring: PageVersionCompareQuery,
      response: { 200: PageVersionCompareResult },
    },
    handler: async (request) => PageVersions.compare(request.ctx, request.params.id, request.query),
  })

  route({
    method: 'GET',
    url: '/pages/:id/versions/:versionId',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Версия страницы: её блоки',
    schema: { params: VersionParams, response: { 200: PageVersionDetail } },
    handler: async (request) =>
      PageVersions.get(request.ctx, request.params.id, request.params.versionId),
  })

  route({
    method: 'POST',
    url: '/pages/:id/versions/:versionId/restore',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Откатить страницу к версии',
    description: 'Текущий текст сохраняется версией, блоки версии возвращаются в документ.',
    schema: { params: VersionParams, response: { 200: PageVersionRecord } },
    handler: async (request) =>
      PageVersions.restore(request.ctx, request.params.id, request.params.versionId),
  })

  route({
    method: 'POST',
    url: '/pages/:id/acknowledgments',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Отправить страницу на ознакомление',
    schema: {
      params: IdParam,
      body: PageAcknowledgeInput,
      response: {
        200: z.object({ requested: z.number().int(), skipped: z.number().int() }),
      },
    },
    handler: async (request) =>
      PageService.requestAcknowledgment(request.ctx, request.params.id, request.body),
  })

  route({
    method: 'GET',
    url: '/knowledge/tree',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Дерево страниц пространства (с `q` — найденное плоским списком)',
    schema: { querystring: PageTreeQuery, response: { 200: PageTreeResult } },
    handler: async (request) => ({ items: await PageService.tree(request.ctx, request.query) }),
  })

  route({
    method: 'GET',
    url: '/knowledge/search',
    auth: 'session',
    tags: ['knowledge'],
    summary: 'Поиск по базе знаний: куски страниц словами и по смыслу',
    description:
      'Смысл ищется, если подключён источник семантики (ADR-0095); без него выдача словесная.',
    schema: { querystring: PageSearchQuery, response: { 200: PageSearchResult } },
    handler: async (request) => PageSearch.run(request.ctx, request.query),
  })
}
