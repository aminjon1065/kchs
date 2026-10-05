import { FeatureService } from '~/kernel/features/service.js'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'

/**
 * Возможности установки (15-admin-operations.md §1): включает и выключает
 * администратор системы, изменение идёт в аудит. Маршруты помечены тегом
 * `admin` — эта возможность не выключается, иначе её некому было бы вернуть.
 */
export function registerFeatureRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /admin/features',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Возможности установки',
    handler: async () => ({ items: await FeatureService.list() }),
  })

  route({
    route: 'PATCH /admin/features/:key',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Включить или выключить возможность',
    handler: async (request) => {
      await db().transaction((tx) =>
        FeatureService.set(tx, request.ctx, request.params.key, request.body.enabled),
      )
      // Кэш процесса — после коммита: иначе параллельный запрос закэширует старое
      FeatureService.invalidate()
      return { items: await FeatureService.list() }
    },
  })
}
