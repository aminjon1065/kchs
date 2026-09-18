import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * Каталог доменных событий (16-api-and-events.md §2).
 * Регистрация типа события без схемы полезной нагрузки запрещена — проверяется тестом.
 * Здесь — события, появляющиеся в фазе 0; модули расширяют каталог своими схемами.
 */
const empty = z.object({})

export const EVENT_PAYLOADS = {
  // ── object ────────────────────────────────────────────────────────────────
  'object.created': z.object({ type: z.string(), title: z.string() }),
  'object.updated': z.object({ title: z.string().optional() }),
  'object.moved': z.object({
    fromParentId: Uuid.nullable(),
    toParentId: Uuid.nullable(),
    fromSpaceId: Uuid.nullable(),
    toSpaceId: Uuid.nullable(),
  }),
  'object.archived': empty,
  'object.restored': z.object({ from: z.enum(['archive', 'trash']) }),
  'object.trashed': empty,
  'object.deleted': z.object({ type: z.string() }),
  'object.shared': z.object({
    added: z.array(z.object({ principal: z.string(), level: z.string() })).default([]),
    removed: z.array(z.object({ principal: z.string() })).default([]),
    changed: z.array(z.object({ principal: z.string(), level: z.string() })).default([]),
    accessMode: z.string().optional(),
  }),
  'object.linked': z.object({ kind: z.string(), targetId: Uuid }),
  'object.unlinked': z.object({ kind: z.string(), targetId: Uuid }),
  'object.tagged': z.object({ tagIds: z.array(Uuid) }),

  // ── identity ──────────────────────────────────────────────────────────────
  'user.created': z.object({ login: z.string() }),
  'user.updated': empty,
  'user.blocked': z.object({ reason: z.string().nullable().default(null) }),
  'user.login': z.object({ ip: z.string().nullable(), userAgent: z.string().nullable() }),
  'user.login_failed': z.object({ login: z.string(), reason: z.string() }),
  'user.logout': empty,
  'user.password_changed': empty,
  'user.mfa_enabled': z.object({ kind: z.string() }),
  'user.mfa_disabled': z.object({ kind: z.string() }),
  'user.roles_changed': z.object({ userId: Uuid, roles: z.array(z.string()) }),
  'org.unit_changed': z.object({ unitId: Uuid, change: z.string() }),
  'org.employment_changed': z.object({ userId: Uuid, unitId: Uuid.nullable() }),
  'delegation.started': z.object({ fromUserId: Uuid, toUserId: Uuid, scope: z.string() }),
  'delegation.ended': z.object({ fromUserId: Uuid, toUserId: Uuid }),
  'session.revoked': z.object({ sessionIds: z.array(Uuid) }),

  // ── space ─────────────────────────────────────────────────────────────────
  'space.created': z.object({ key: z.string(), kind: z.string() }),
  'space.member_added': z.object({ userId: Uuid, role: z.string() }),
  'space.member_removed': z.object({ userId: Uuid }),
  'space.member_role_changed': z.object({ userId: Uuid, role: z.string(), from: z.string() }),

  // ── discussion ────────────────────────────────────────────────────────────
  'message.posted': z.object({
    conversationId: Uuid,
    messageId: z.string(),
    preview: z.string(),
    threadRootId: z.string().nullable().default(null),
    mentions: z.array(Uuid).default([]),
  }),
  'message.edited': z.object({ conversationId: Uuid, messageId: z.string() }),
  'message.deleted': z.object({ conversationId: Uuid, messageId: z.string() }),
  'message.reacted': z.object({ conversationId: Uuid, messageId: z.string(), emoji: z.string() }),
  'mention.created': z.object({
    conversationId: Uuid,
    messageId: z.string(),
    userIds: z.array(Uuid),
  }),

  // ── files ─────────────────────────────────────────────────────────────────
  'file.uploaded': z.object({ name: z.string(), size: z.number(), mime: z.string() }),
  'file.version_added': z.object({ versionId: Uuid, number: z.number().int() }),
  'file.text_extracted': z.object({ chars: z.number().int() }),
  'file.previewed': z.object({ status: z.string() }),
  'file.shared_link_created': z.object({ linkId: Uuid }),
  'file.downloaded': z.object({ versionId: Uuid.nullable() }),

  // ── notifications ─────────────────────────────────────────────────────────
  'notification.sent': z.object({
    userId: Uuid,
    category: z.string(),
    channels: z.array(z.string()),
  }),
  'inbox.opened': z.object({ userId: Uuid, kind: z.string(), itemId: Uuid }),
  'inbox.resolved': z.object({ userId: Uuid, itemId: Uuid, outcome: z.string() }),
  'inbox.snoozed': z.object({ userId: Uuid, itemId: Uuid, until: z.string() }),

  // ── jobs ──────────────────────────────────────────────────────────────────
  'job.queued': z.object({ jobId: Uuid, queue: z.string(), name: z.string() }),
  'job.started': z.object({ jobId: Uuid }),
  'job.finished': z.object({ jobId: Uuid, durationMs: z.number().int() }),
  'job.failed': z.object({ jobId: Uuid, error: z.string() }),

  // ── admin ─────────────────────────────────────────────────────────────────
  'settings.changed': z.object({ scope: z.string(), key: z.string() }),
  'acl.changed': z.object({ objectId: Uuid }),
  'role.assigned': z.object({ userId: Uuid, roleKey: z.string() }),
  'announcement.published': z.object({ title: z.string() }),
  'announcement.withdrawn': z.object({ title: z.string() }),
} as const satisfies Record<string, z.ZodType>

export type EventType = keyof typeof EVENT_PAYLOADS
export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EventType[]

export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOADS)[T]>

export function isKnownEventType(type: string): type is EventType {
  return type in EVENT_PAYLOADS
}
