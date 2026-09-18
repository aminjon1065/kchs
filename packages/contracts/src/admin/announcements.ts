import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Timestamp, Uuid } from '../common/primitives.js'

/**
 * Объявления организации (15-admin-operations.md «Система»; 12-calendar-
 * notifications-home.md §4, виджет «Объявления»). Публикует администратор,
 * видят все сотрудники в «Мой день» в период показа.
 */
export const ANNOUNCEMENT_SEVERITIES = ['info', 'warning', 'critical'] as const
export const AnnouncementSeverity = z.enum(ANNOUNCEMENT_SEVERITIES)
export type AnnouncementSeverity = z.infer<typeof AnnouncementSeverity>

export const Announcement = z.object({
  id: Uuid,
  title: z.string(),
  body: z.string(),
  severity: AnnouncementSeverity,
  startsAt: Timestamp,
  endsAt: Timestamp.nullable(),
  createdBy: UserRef.nullable(),
  createdAt: Timestamp,
})
export type Announcement = z.infer<typeof Announcement>

/** Для консоли: состояние на текущий момент — запланировано, показывается, снято. */
export const AnnouncementStatus = z.enum(['scheduled', 'active', 'ended'])
export type AnnouncementStatus = z.infer<typeof AnnouncementStatus>

export const AdminAnnouncement = Announcement.extend({ status: AnnouncementStatus })
export type AdminAnnouncement = z.infer<typeof AdminAnnouncement>

export const AnnouncementCreateInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(4000),
    severity: AnnouncementSeverity.default('info'),
    /** Начало показа; по умолчанию — сразу. */
    startsAt: Timestamp.nullable().optional(),
    /** Окончание показа; без него объявление висит, пока его не снимут. */
    endsAt: Timestamp.nullable().optional(),
  })
  .refine(
    (input) => !input.endsAt || new Date(input.endsAt) > new Date(input.startsAt ?? Date.now()),
    { message: 'Окончание показа должно быть позже начала', path: ['endsAt'] },
  )
export type AnnouncementCreateInput = z.infer<typeof AnnouncementCreateInput>
