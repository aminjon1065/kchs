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

/**
 * Библиотека отчётов (ADR-0164): шаблоны, версии с откатом, картинки и файлы блоков для
 * редактора и страницы печати (GET — доступен и браузеру движка с токеном печати).
 */
export function registerReportLibraryRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /reports/templates',
    auth: 'session',
    tags: ['reports'],
    summary: 'Шаблоны отчётов: встроенные и отчёты, отмеченные шаблоном',
    handler: async (request) => ({ items: await ReportTemplates.list(request.ctx) }),
  })

  route({
    route: 'POST /reports/:id/template',
    auth: { action: 'manage' },
    tags: ['reports'],
    summary: 'Отметить отчёт шаблоном библиотеки или снять отметку',
    handler: async (request) => {
      await db().transaction((tx) =>
        ReportTemplates.flag(tx, request.ctx, request.params.id, request.body.template),
      )
      return ReportService.get(request.params.id)
    },
  })

  route({
    route: 'GET /reports/:id/versions',
    auth: { action: 'view' },
    tags: ['reports'],
    summary: 'Версии шаблона отчёта',
    handler: async (request) => ({ items: await ReportVersions.list(request.params.id) }),
  })

  route({
    route: 'POST /reports/:id/versions',
    auth: { action: 'edit' },
    tags: ['reports'],
    summary: 'Сохранить версию шаблона отчёта с подписью',
    handler: async (request) => ({
      number: await ReportVersions.save(request.ctx, request.params.id, request.body.label),
    }),
  })

  route({
    route: 'POST /reports/:id/versions/:versionId/restore',
    auth: { action: 'edit' },
    tags: ['reports'],
    summary: 'Вернуть версию: снимок пишется в документ отчёта, текущий шаблон — версией',
    handler: async (request) => {
      await ReportVersions.restore(request.ctx, request.params.id, request.params.versionId)
      return ReportService.get(request.params.id)
    },
  })

  route({
    route: 'GET /reports/:id/images/:fileId',
    auth: { action: 'view' },
    tags: ['reports'],
    summary: 'Картинка блока «Изображение» — data URL для печати и редактора',
    handler: async (request) => reportImage(request.ctx, request.params.fileId),
  })

  route({
    route: 'GET /reports/:id/files',
    auth: { action: 'view' },
    tags: ['reports'],
    summary: 'Файлы блока «Файл», которые видит смотрящий',
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
