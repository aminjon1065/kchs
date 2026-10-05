import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Модуль «Чаты» (11-communications-meetings.md §1). Домены `chat` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const CHAT_EVENTS = {
  // ── chat (11-communications-meetings.md §1, ADR-0090) ─────────────────────
  // Объект событий чата — беседа; сообщения остаются домену `discussion`
  'chat.created': z.object({
    kind: z.string(),
    privacy: z.string(),
    memberIds: z.array(Uuid).default([]),
  }),
  'chat.renamed': z.object({ title: z.string(), from: z.string() }),
  /** Вступили сами (открытый канал) или добавил владелец: `invitedBy`. */
  'chat.member_joined': z.object({
    userIds: z.array(Uuid),
    invitedBy: Uuid.nullable().default(null),
  }),
  'chat.member_left': z.object({ userIds: z.array(Uuid), removed: z.boolean().default(false) }),
  'chat.message_pinned': z.object({ messageId: z.string(), preview: z.string() }),
  'chat.message_unpinned': z.object({ messageId: z.string() }),
  /** Сообщения пересланы в другие беседы: `targetIds` — куда. */
  'chat.messages_forwarded': z.object({
    messageIds: z.array(z.string()),
    targetIds: z.array(Uuid),
  }),
  /** Статус присутствия изменён — объекта у события нет. */
  'chat.presence_changed': z.object({
    userId: Uuid,
    status: z.string(),
    from: z.string(),
  }),
} as const satisfies Record<string, z.ZodType>
