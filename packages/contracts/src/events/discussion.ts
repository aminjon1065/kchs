import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Обсуждения и упоминания (02-platform-kernel.md §6). Домены `message`, `mention` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const DISCUSSION_EVENTS = {
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
  /** Участник дочитал беседу до сообщения — отметки «прочитано» (ADR-0161). */
  'message.read': z.object({ conversationId: Uuid, messageId: z.string(), userId: Uuid }),
  'mention.created': z.object({
    conversationId: Uuid,
    messageId: z.string(),
    userIds: z.array(Uuid),
  }),
} as const satisfies Record<string, z.ZodType>
