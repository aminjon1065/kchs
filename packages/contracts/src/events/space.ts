import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Пространства (02-platform-kernel.md §2). Домены `space` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const SPACE_EVENTS = {
  // ── space ─────────────────────────────────────────────────────────────────
  'space.created': z.object({ key: z.string(), kind: z.string() }),
  'space.member_added': z.object({ userId: Uuid, role: z.string() }),
  'space.member_removed': z.object({ userId: Uuid }),
  'space.member_role_changed': z.object({ userId: Uuid, role: z.string(), from: z.string() }),
} as const satisfies Record<string, z.ZodType>
