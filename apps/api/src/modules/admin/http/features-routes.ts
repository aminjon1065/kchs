import { FeatureFlagList, FeatureFlagPatch } from '@kchs/contracts'
import { z } from 'zod'
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
    method: 'GET',
    url: '/admin/features',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Возможности установки',
    schema: { response: { 200: FeatureFlagList } },
    handler: async () => ({ items: await FeatureService.list() }),
  })

  route({
    method: 'PATCH',
    url: '/admin/features/:key',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Включить или выключить возможность',
    schema: {
      params: z.object({ key: z.string().min(1).max(64) }),
      body: FeatureFlagPatch,
      response: { 200: FeatureFlagList },
    },
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
