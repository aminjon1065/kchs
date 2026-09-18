import { UsersImportParsed, UsersImportStartInput, UsersImportStatus } from '@kchs/contracts'
import { z } from 'zod'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { validServiceToken } from '~/shared/http/service-token.js'
import { UsersImport } from '../domain/users-import.js'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ImportParam = z.object({ importId: z.uuid() })

/** Импорт пользователей из Excel (P0-E04 S04, ADR-0041). */
export function registerUsersImportRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/admin/users/import/template.xlsx',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Шаблон XLSX: русские заголовки и справочники ролей, подразделений, должностей',
    handler: async (_request, reply) => {
      const content = await UsersImport.template()
      reply
        .header('content-type', XLSX_MIME)
        .header('content-disposition', 'attachment; filename="kchs-users-import.xlsx"')
      return reply.send(content)
    },
  })

  route({
    method: 'POST',
    url: '/admin/users/import',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Проверить или импортировать пользователей из загруженного файла XLSX',
    schema: {
      body: UsersImportStartInput,
      response: { 202: z.object({ importId: z.uuid() }) },
    },
    handler: async (request, reply) => {
      const importId = await UsersImport.start(request.ctx, request.body)
      reply.code(202)
      return { importId }
    },
  })

  route({
    method: 'GET',
    url: '/admin/users/import/:importId',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Ход импорта и отчёт по строкам',
    schema: { params: ImportParam, response: { 200: UsersImportStatus } },
    handler: async (request) => UsersImport.status(request.ctx, request.params.importId),
  })

  route({
    method: 'GET',
    url: '/admin/users/import/:importId/report.csv',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Отчёт импорта в CSV',
    schema: { params: ImportParam },
    handler: async (request, reply) => {
      const csv = await UsersImport.reportCsv(request.ctx, request.params.importId)
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="kchs-users-import-report.csv"')
      return reply.send(csv)
    },
  })

  route({
    method: 'GET',
    url: '/admin/users/import/:importId/credentials.csv',
    auth: { capability: 'users.manage' },
    tags: ['org'],
    summary: 'Временные пароли созданных — один раз и только инициатору импорта',
    schema: { params: ImportParam },
    handler: async (request, reply) => {
      const csv = await UsersImport.takeCredentials(request.ctx, request.params.importId)
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('content-disposition', 'attachment; filename="kchs-users-passwords.csv"')
      return reply.send(csv)
    },
  })

  route({
    method: 'POST',
    url: '/internal/users-import/:importId/parsed',
    auth: 'public',
    tags: ['internal'],
    summary: 'Движок передаёт строки файла импорта пользователей',
    schema: {
      params: ImportParam,
      body: UsersImportParsed,
      response: { 200: z.object({ applyJobId: z.uuid() }) },
    },
    handler: async (request) => {
      if (!validServiceToken(request.headers['x-kchs-service-token'])) {
        throw errors.unauthorized('Недействительный сервисный токен')
      }
      return {
        applyJobId: await UsersImport.acceptParsed(request.params.importId, request.body),
      }
    },
  })
}
