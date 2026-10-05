import { z } from 'zod'
import {
  AdminAnnouncement,
  Announcement,
  AnnouncementCreateInput,
} from '../../admin/announcements.js'
import { defineRoutes } from '../../http/route-contract.js'

/**
 * Маршруты ядра «announcements» (ADR-0188). Регистрация —
 * `apps/api/src/kernel/announcements/`: http.ts.
 */
export const kernelAnnouncementsRoutes = defineRoutes({
  'GET /announcements': { response: { 200: z.object({ items: z.array(Announcement) }) } },
  'GET /admin/announcements': {
    response: { 200: z.object({ items: z.array(AdminAnnouncement) }) },
  },
  'POST /admin/announcements': {
    body: AnnouncementCreateInput,
    response: { 200: z.object({ id: z.uuid() }) },
  },
  'POST /admin/announcements/:id/withdraw': {
    params: z.object({ id: z.uuid() }),
    response: { 200: z.object({ ok: z.boolean() }) },
  },
})
