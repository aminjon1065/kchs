import { AdminAnnouncement, Announcement, AnnouncementCreateInput } from '@kchs/contracts'
import { z } from 'zod'
import { db } from '~/shared/db/client.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { AnnouncementService } from './service.js'

export function registerAnnouncementRoutes(route: RouteRegistrar): void {
  route({
    method: 'GET',
    url: '/announcements',
    auth: 'session',
    tags: ['announcements'],
    summary: 'Объявления, которые показываются сейчас',
    schema: { response: { 200: z.object({ items: z.array(Announcement) }) } },
    handler: async () => ({ items: await AnnouncementService.active() }),
  })

  route({
    method: 'GET',
    url: '/admin/announcements',
    auth: { capability: 'admin.system' },
    tags: ['announcements'],
    summary: 'Все объявления: запланированные, показываемые и снятые',
    schema: { response: { 200: z.object({ items: z.array(AdminAnnouncement) }) } },
    handler: async () => ({ items: await AnnouncementService.list() }),
  })

  route({
    method: 'POST',
    url: '/admin/announcements',
    auth: { capability: 'admin.system' },
    tags: ['announcements'],
    summary: 'Опубликовать объявление',
    schema: {
      body: AnnouncementCreateInput,
      response: { 200: z.object({ id: z.uuid() }) },
    },
    handler: async (request) => ({
      id: await db().transaction((tx) => AnnouncementService.create(tx, request.ctx, request.body)),
    }),
  })

  route({
    method: 'POST',
    url: '/admin/announcements/:id/withdraw',
    auth: { capability: 'admin.system' },
    tags: ['announcements'],
    summary: 'Снять объявление с показа',
    schema: {
      params: z.object({ id: z.uuid() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        AnnouncementService.withdraw(tx, request.ctx, request.params.id),
      )
      return { ok: true }
    },
  })
}
