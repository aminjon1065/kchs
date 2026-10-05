import type { RouteRegistrar } from '~/shared/http/route.js'
import { availableSections, ConfigPackages } from '../domain/config-package.js'

/**
 * Импорт и экспорт конфигурации (14-automation-integrations.md §6, ADR-0097):
 * перенос настройки между контурами по стабильным ключам.
 */
export function registerConfigPackageRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /config/sections',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Разделы, которые установка умеет выгружать и применять',
    handler: async () => ({ items: availableSections() }),
  })

  route({
    route: 'POST /config/export',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Выгрузить пакет конфигурации',
    // Выгрузка ничего не меняет: это POST ради тела запроса
    readOnly: true,
    handler: async (request) => ConfigPackages.exportPackage(request.ctx, request.body),
  })

  route({
    route: 'POST /config/import/preview',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Предпросмотр различий пакета с текущей конфигурацией',
    readOnly: true,
    handler: async (request) => ConfigPackages.preview(request.ctx, request.body.package),
  })

  route({
    route: 'POST /config/import',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Применить пакет конфигурации',
    handler: async (request) => ConfigPackages.apply(request.ctx, request.body),
  })
}
