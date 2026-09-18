import { z } from 'zod'

export const SortDirection = z.enum(['asc', 'desc'])
export type SortDirection = z.infer<typeof SortDirection>

export const SortItem = z.object({
  field: z.string().min(1).max(128),
  direction: SortDirection.default('asc'),
  nulls: z.enum(['first', 'last']).optional(),
})
export type SortItem = z.infer<typeof SortItem>

/** Строковая форма из query-параметра: `field:asc,field2:desc`. */
export const SortQuery = z
  .string()
  .max(512)
  .transform((raw): SortItem[] =>
    raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [field = '', direction] = part.split(':')
        return { field, direction: direction === 'desc' ? ('desc' as const) : ('asc' as const) }
      }),
  )
