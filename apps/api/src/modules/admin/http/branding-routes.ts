import { BrandingService } from '~/kernel/settings/branding.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'

/**
 * Брендирование (15-admin-operations.md §1): название, логотип, акцент и
 * приписка на экране входа. Читать может кто угодно — оболочка показывает это
 * до входа; менять — администратор системы, изменение идёт в аудит.
 */
export function registerBrandingRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /branding',
    auth: 'public',
    tags: ['auth'],
    summary: 'Брендирование установки: название, логотип, акцент',
    description: 'Отдаётся до входа — экран входа показывает название и логотип организации.',
    handler: async () => BrandingService.current(),
  })

  route({
    route: 'PATCH /admin/branding',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Изменить брендирование',
    handler: async (request) => {
      const branding = await db().transaction((tx) =>
        BrandingService.update(tx, request.ctx, request.body),
      )
      // Кэш процесса — после коммита: иначе параллельный запрос закэширует старое
      BrandingService.invalidate()
      return branding
    },
  })
}
