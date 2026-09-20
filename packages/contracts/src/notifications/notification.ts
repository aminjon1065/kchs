import { z } from 'zod'
import { UserRef } from '../auth/session.js'
import { Timestamp } from '../common/primitives.js'
import { ObjectSummary } from '../objects/object.js'

export const NOTIFICATION_CATEGORIES = [
  'inbox',
  'mention',
  'discussion',
  'object',
  'tasks',
  'documents',
  'chat.direct',
  'chat.mention',
  'chat.channel',
  'meetings',
  'calendar',
  'data',
  'system',
] as const
export const NotificationCategory = z.enum(NOTIFICATION_CATEGORIES)
export type NotificationCategory = z.infer<typeof NotificationCategory>

export const NOTIFICATION_CHANNELS = ['app', 'email', 'telegram', 'push'] as const
export const NotificationChannel = z.enum(NOTIFICATION_CHANNELS)
export type NotificationChannel = z.infer<typeof NotificationChannel>

export const DeliveryMode = z.enum(['immediate', 'digest', 'off'])
export type DeliveryMode = z.infer<typeof DeliveryMode>

export const Notification = z.object({
  id: z.string(),
  category: NotificationCategory,
  title: z.string(),
  body: z.string().nullable(),
  object: ObjectSummary.nullable(),
  actor: UserRef.nullable(),
  url: z.string().nullable(),
  /** Количество слитых событий: «3 изменения в Документ №…». */
  aggregateCount: z.number().int().default(1),
  readAt: Timestamp.nullable(),
  createdAt: Timestamp,
})
export type Notification = z.infer<typeof Notification>

export const NotificationPreference = z.object({
  category: NotificationCategory,
  channel: NotificationChannel,
  mode: DeliveryMode,
})

export const NotificationPreferences = z.object({
  items: z.array(NotificationPreference),
  /**
   * Режимы по умолчанию для доступных пользователю каналов (ADR-0061): экран
   * настроек показывает действующий режим, даже если пользователь его не менял.
   */
  defaults: z.array(NotificationPreference).default([]),
  quietHours: z
    .object({ from: z.string(), to: z.string(), enabled: z.boolean() })
    .nullable()
    .default(null),
  doNotDisturbUntil: Timestamp.nullable().default(null),
  digestHour: z.number().int().min(0).max(23).default(8),
})
export type NotificationPreferences = z.infer<typeof NotificationPreferences>
