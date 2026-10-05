import { BackupService } from '~/kernel/backup/service.js'
import { JobService } from '~/kernel/jobs/service.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'

/**
 * Резервные копии (15-admin-operations.md §5): список прогонов, копия по
 * требованию и отметка о проверке восстановлением. Рядом — обслуживание
 * (§6): переиндексация поиска, у которой нет своего расписания. Только
 * администратор системы; каждое действие — в аудит.
 */
export function registerBackupRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /admin/backups',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Резервные копии базы',
    handler: async () => ({ items: await BackupService.list() }),
  })

  route({
    route: 'POST /admin/backups',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Сделать резервную копию сейчас',
    description: 'Дамп идёт потоком в бакет копий; запись о прогоне возвращается по завершении.',
    rateLimit: { max: 3, timeWindow: '10 minutes' },
    handler: async (request) => BackupService.run(request.ctx),
  })

  route({
    route: 'POST /admin/backups/:id/verified',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Отметить копию проверенной восстановлением',
    handler: async (request) => {
      const saved = await BackupService.markVerified(
        request.ctx,
        request.params.id,
        request.body.note,
      )
      if (!saved) throw errors.notFound('Резервная копия')
      return saved
    },
  })

  route({
    route: 'POST /admin/maintenance/reindex',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Переиндексировать поиск',
    description: 'Полная переиндексация идёт заданием; за ходом следит экран «Процессы».',
    rateLimit: { max: 3, timeWindow: '10 minutes' },
    handler: async (request) => {
      const jobId = await db().transaction((tx) =>
        JobService.schedule(tx, request.ctx, {
          queue: 'index',
          name: 'search.reindex',
          data: {},
          idempotencyKey: 'admin:search.reindex',
        }),
      )
      return { jobId }
    },
  })
}
