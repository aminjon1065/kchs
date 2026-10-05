import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AnnouncementService } from './service.js'

export function registerAnnouncementRoutes(route: RouteRegistrar): void {
  route({
    route: 'GET /announcements',
    auth: 'session',
    tags: ['announcements'],
    summary: 'Объявления, которые показываются сейчас',
    handler: async () => ({ items: await AnnouncementService.active() }),
  })

  route({
    route: 'GET /admin/announcements',
    auth: { capability: 'admin.system' },
    tags: ['announcements'],
    summary: 'Все объявления: запланированные, показываемые и снятые',
    handler: async () => ({ items: await AnnouncementService.list() }),
  })

  route({
    route: 'POST /admin/announcements',
    auth: { capability: 'admin.system' },
    tags: ['announcements'],
    summary: 'Опубликовать объявление',
    handler: async (request) => ({
      id: await db().transaction((tx) => AnnouncementService.create(tx, request.ctx, request.body)),
    }),
  })

  route({
    route: 'POST /admin/announcements/:id/withdraw',
    auth: { capability: 'admin.system' },
    tags: ['announcements'],
    summary: 'Снять объявление с показа',
    handler: async (request) => {
      await db().transaction((tx) =>
        AnnouncementService.withdraw(tx, request.ctx, request.params.id),
      )
      return { ok: true }
    },
  })
}
