import { DashboardTileExportInput, QUERY_EXPORT_HEADERS, QueryExportInput } from '@kchs/contracts'
import type { FastifyReply } from 'fastify'
import { z } from 'zod'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { DashboardService } from './domain/dashboard-service.js'
import { type QueryExportFile, QueryExportService } from './domain/query-export.js'

const IdParam = z.object({ id: z.uuid() })

/** Файл выгрузки в ответе: имя — в `filename*` (кириллица), счётчики — в заголовках. */
function sendFile(reply: FastifyReply, file: QueryExportFile) {
  const extension = file.fileName.split('.').pop() ?? 'csv'
  return reply
    .header('content-type', file.contentType)
    .header(
      'content-disposition',
      `attachment; filename="export.${extension}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    )
    .header(QUERY_EXPORT_HEADERS.rows, String(file.rows))
    .header(QUERY_EXPORT_HEADERS.truncated, String(file.truncated))
    .send(file.body)
}

/** Выгрузка результатов запросов (ADR-0159): «Исследование», график, плитка дашборда. */
export function registerExportRoutes(route: RouteRegistrar): void {
  route({
    method: 'POST',
    url: '/queries/export',
    auth: 'session',
    tags: ['data'],
    summary: 'Выгрузить результат запроса в CSV или XLSX — с политиками пользователя',
    schema: { body: QueryExportInput },
    rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async (request, reply) =>
      sendFile(reply, await QueryExportService.export(request.ctx, request.body)),
  })

  route({
    method: 'POST',
    url: '/dashboards/:id/export',
    auth: { action: 'view' },
    tags: ['data'],
    summary: 'Выгрузить данные плитки-графика дашборда с фильтрами дашборда',
    schema: { params: IdParam, body: DashboardTileExportInput },
    rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async (request, reply) => {
      const { query, title } = await DashboardService.tileQuery(
        request.ctx,
        request.params.id,
        request.body.tileId,
        request.body.filters,
        'Выгрузка данных доступна для графиков по датасету',
      )
      const file = await QueryExportService.export(request.ctx, {
        spec: query,
        params: {},
        format: request.body.format,
        name: title,
        labels: request.body.labels,
      })
      return sendFile(reply, file)
    },
  })
}
