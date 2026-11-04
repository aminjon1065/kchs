import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * События: Реестр объектов и доступ (02-platform-kernel.md §1, 03-access-model.md). Домены `object`, `acl` целиком
 * принадлежат этому файлу (ADR-0189); общий каталог собирается в `catalog.ts`.
 */
export const OBJECT_EVENTS = {
  // ── object ────────────────────────────────────────────────────────────────
  'object.created': z.object({ type: z.string(), title: z.string() }),
  'object.updated': z.object({ title: z.string().optional() }),
  'object.moved': z.object({
    fromParentId: Uuid.nullable(),
    toParentId: Uuid.nullable(),
    fromSpaceId: Uuid.nullable(),
    toSpaceId: Uuid.nullable(),
  }),
  // cascadeOf — корень операции: объект ушёл в архив или корзину вместе с ним (ADR-0228)
  'object.archived': z.object({ cascadeOf: Uuid.optional() }),
  'object.restored': z.object({ from: z.enum(['archive', 'trash']), cascadeOf: Uuid.optional() }),
  'object.trashed': z.object({ cascadeOf: Uuid.optional() }),
  'object.deleted': z.object({ type: z.string() }),
  'object.shared': z.object({
    added: z.array(z.object({ principal: z.string(), level: z.string() })).default([]),
    removed: z.array(z.object({ principal: z.string() })).default([]),
    changed: z.array(z.object({ principal: z.string(), level: z.string() })).default([]),
    accessMode: z.string().optional(),
    /** Права — следствие другого действия (участник поручения): без уведомления. */
    quiet: z.boolean().optional(),
  }),
  'object.linked': z.object({ kind: z.string(), targetId: Uuid }),
  'object.unlinked': z.object({ kind: z.string(), targetId: Uuid }),
  'object.tagged': z.object({ tagIds: z.array(Uuid) }),
  'acl.changed': z.object({ objectId: Uuid }),
} as const satisfies Record<string, z.ZodType>
