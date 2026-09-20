import { z } from 'zod'
import { BackupService } from '~/kernel/backup/service.js'
import { JobService } from '~/kernel/jobs/service.js'
import { db } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import type { RouteRegistrar } from '~/shared/http/route.js'

/** Копия — дело долгое: запись о прогоне появляется сразу, итог — по завершении. */
const Backup = z.object({
  id: z.uuid(),
  status: z.enum(['running', 'done', 'failed']),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  sizeBytes: z.number().int().nullable(),
  requestedBy: z.uuid().nullable(),
  error: z.string().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  verifiedNote: z.string().nullable(),
})
const BackupList = z.object({ items: z.array(Backup) })

/**
 * Резервные копии (15-admin-operations.md §5): список прогонов, копия по
 * требованию и отметка о проверке восстановлением. Рядом — обслуживание
 * (§6): переиндексация поиска, у которой нет своего расписания. Только
 * администратор системы; каждое действие — в аудит.
 */
export function registerBackupRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/admin/backups',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Резервные копии базы',
    schema: { response: { 200: BackupList } },
    handler: async () => ({ items: await BackupService.list() }),
  })

  route({
    method: 'POST',
    url: '/admin/backups',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Сделать резервную копию сейчас',
    description: 'Дамп идёт потоком в бакет копий; запись о прогоне возвращается по завершении.',
    rateLimit: { max: 3, timeWindow: '10 minutes' },
    schema: { response: { 200: Backup } },
    handler: async (request) => BackupService.run(request.ctx),
  })

  route({
    method: 'POST',
    url: '/admin/backups/:id/verified',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Отметить копию проверенной восстановлением',
    schema: {
      params: z.object({ id: z.uuid() }),
      body: z.object({ note: z.string().max(500).default('') }),
      response: { 200: Backup },
    },
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
    method: 'POST',
    url: '/admin/maintenance/reindex',
    auth: { capability: 'admin.system' },
    tags: ['admin'],
    summary: 'Переиндексировать поиск',
    description: 'Полная переиндексация идёт заданием; за ходом следит экран «Процессы».',
    rateLimit: { max: 3, timeWindow: '10 minutes' },
    schema: { response: { 200: z.object({ jobId: z.uuid() }) } },
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
