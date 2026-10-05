import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Уведомления и «Входящие» (02-platform-kernel.md §7). Домены `notification`, `inbox` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const NOTIFICATION_EVENTS = {
  // ── notifications ─────────────────────────────────────────────────────────
  'notification.sent': z.object({
    userId: Uuid,
    category: z.string(),
    channels: z.array(z.string()),
  }),
  /** `alsoFor` — заместители, получившие копию дела. */
  'inbox.opened': z.object({
    userId: Uuid,
    kind: z.string(),
    itemId: Uuid,
    alsoFor: z.array(Uuid).optional(),
  }),
  'inbox.resolved': z.object({ userId: Uuid, itemId: Uuid, outcome: z.string() }),
  'inbox.snoozed': z.object({ userId: Uuid, itemId: Uuid, until: z.string() }),
} as const satisfies Record<string, z.ZodType>
