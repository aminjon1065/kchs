import {
  ReportImage,
  ReportRecord,
  ReportTemplateFlagInput,
  ReportTemplateList,
  ReportVersionInput,
  ReportVersionList,
} from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import {
  ReportTemplates,
  ReportVersions,
  reportFiles,
  reportImage,
} from './domain/report-library.js'
import { ReportService } from './domain/report-service.js'

const IdParam = z.object({ id: z.uuid() })

/**
 * Библиотека отчётов (ADR-0164): шаблоны, версии с откатом, картинки и файлы блоков для
 * редактора и страницы печати (GET — доступен и браузеру движка с токеном печати).
 */
export function registerReportLibraryRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/reports/templates',
    auth: 'session',
    tags: ['reports'],
    summary: 'Шаблоны отчётов: встроенные и отчёты, отмеченные шаблоном',
    schema: { response: { 200: ReportTemplateList } },
    handler: async (request) => ({ items: await ReportTemplates.list(request.ctx) }),
  })

  route({
    method: 'POST',
    url: '/reports/:id/template',
    auth: { action: 'manage' },
    tags: ['reports'],
    summary: 'Отметить отчёт шаблоном библиотеки или снять отметку',
    schema: {
      params: IdParam,
      body: ReportTemplateFlagInput,
      response: { 200: ReportRecord },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        ReportTemplates.flag(tx, request.ctx, request.params.id, request.body.template),
      )
      return ReportService.get(request.params.id)
    },
  })

  route({
    method: 'GET',
    url: '/reports/:id/versions',
    auth: { action: 'view' },
    tags: ['reports'],
    summary: 'Версии шаблона отчёта',
    schema: { params: IdParam, response: { 200: ReportVersionList } },
    handler: async (request) => ({ items: await ReportVersions.list(request.params.id) }),
  })

  route({
    method: 'POST',
    url: '/reports/:id/versions',
    auth: { action: 'edit' },
    tags: ['reports'],
    summary: 'Сохранить версию шаблона отчёта с подписью',
    schema: {
      params: IdParam,
      body: ReportVersionInput,
      response: { 200: z.object({ number: z.number().int() }) },
    },
    handler: async (request) => ({
      number: await ReportVersions.save(request.ctx, request.params.id, request.body.label),
    }),
  })

  route({
    method: 'POST',
    url: '/reports/:id/versions/:versionId/restore',
    auth: { action: 'edit' },
    tags: ['reports'],
    summary: 'Вернуть версию: снимок пишется в документ отчёта, текущий шаблон — версией',
    schema: {
      params: z.object({ id: z.uuid(), versionId: z.uuid() }),
      response: { 200: ReportRecord },
    },
    handler: async (request) => {
      await ReportVersions.restore(request.ctx, request.params.id, request.params.versionId)
      return ReportService.get(request.params.id)
    },
  })

  route({
    method: 'GET',
    url: '/reports/:id/images/:fileId',
    auth: { action: 'view' },
    tags: ['reports'],
    summary: 'Картинка блока «Изображение» — data URL для печати и редактора',
    schema: {
      params: z.object({ id: z.uuid(), fileId: z.uuid() }),
      response: { 200: ReportImage },
    },
    handler: async (request) => reportImage(request.ctx, request.params.fileId),
  })

  route({
    method: 'GET',
    url: '/reports/:id/files',
    auth: { action: 'view' },
    tags: ['reports'],
    summary: 'Файлы блока «Файл», которые видит смотрящий',
    schema: {
      params: IdParam,
      querystring: z.object({ ids: z.string().max(2000) }),
      response: {
        200: z.object({
          items: z.array(
            z.object({ id: z.uuid(), name: z.string(), size: z.number(), mime: z.string() }),
          ),
        }),
      },
    },
    handler: async (request) => {
      const ids = request.query.ids
        .split(',')
        .map((id) => id.trim())
        .filter((id) => z.uuid().safeParse(id).success)
        .slice(0, 20)
      return { items: await reportFiles(request.ctx, ids) }
    },
  })
}
