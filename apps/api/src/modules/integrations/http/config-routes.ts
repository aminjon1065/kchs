import {
  ConfigExportInput,
  ConfigImportInput,
  ConfigImportPreview,
  ConfigImportResult,
  ConfigPackage,
  ConfigSection,
} from '@kchs/contracts'
import { z } from 'zod'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { availableSections, ConfigPackages } from '../domain/config-package.js'

/**
 * Импорт и экспорт конфигурации (14-automation-integrations.md §6, ADR-0097):
 * перенос настройки между контурами по стабильным ключам.
 */
export function registerConfigPackageRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/config/sections',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Разделы, которые установка умеет выгружать и применять',
    schema: { response: { 200: z.object({ items: z.array(ConfigSection) }) } },
    handler: async () => ({ items: availableSections() }),
  })

  route({
    method: 'POST',
    url: '/config/export',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Выгрузить пакет конфигурации',
    // Выгрузка ничего не меняет: это POST ради тела запроса
    readOnly: true,
    schema: { body: ConfigExportInput, response: { 200: ConfigPackage } },
    handler: async (request) => ConfigPackages.exportPackage(request.ctx, request.body),
  })

  route({
    method: 'POST',
    url: '/config/import/preview',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Предпросмотр различий пакета с текущей конфигурацией',
    readOnly: true,
    schema: {
      body: z.object({ package: ConfigPackage }),
      response: { 200: ConfigImportPreview },
    },
    handler: async (request) => ConfigPackages.preview(request.ctx, request.body.package),
  })

  route({
    method: 'POST',
    url: '/config/import',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Применить пакет конфигурации',
    schema: { body: ConfigImportInput, response: { 200: ConfigImportResult } },
    handler: async (request) => ConfigPackages.apply(request.ctx, request.body),
  })
}
