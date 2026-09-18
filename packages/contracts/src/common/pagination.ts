import { z } from 'zod'

/**
 * Курсорная пагинация (16-api-and-events.md §1):
 * `?cursor=&limit=`, ответ `{items, nextCursor, total?}`.
 */
export const CursorQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  count: z.coerce.boolean().optional(),
})
export type CursorQuery = z.infer<typeof CursorQuery>

export function cursorPage<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().optional(),
    approx: z.boolean().optional(),
  })
}

export type CursorPage<T> = {
  items: T[]
  nextCursor: string | null
  total?: number
  approx?: boolean
}
