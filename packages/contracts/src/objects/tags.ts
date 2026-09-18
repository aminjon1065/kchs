import { z } from 'zod'
import { Uuid } from '../common/primitives.js'

/**
 * Цвет тега — ключ категориальной палитры дизайн-системы (03-ui/02-design-system.md §2),
 * а не произвольный CSS-цвет: так тег одинаково читается в светлой и тёмной теме.
 */
export const TAG_COLORS = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'chart-6',
  'chart-7',
  'chart-8',
  'chart-9',
  'chart-10',
] as const
export const TagColor = z.enum(TAG_COLORS)
export type TagColor = z.infer<typeof TagColor>

export const TAG_NAME_MAX = 60
export const TAGS_PER_OBJECT_MAX = 30

export const TagView = z.object({
  id: Uuid,
  name: z.string(),
  /** Цвет из старых данных вне палитры клиент показывает без цвета. */
  color: z.string().nullable(),
})
export type TagView = z.infer<typeof TagView>

export const TagAssignInput = z.object({
  name: z.string().min(1).max(120),
  color: TagColor.nullable().optional(),
})
export type TagAssignInput = z.infer<typeof TagAssignInput>

export const TagListResponse = z.object({ items: z.array(TagView) })
export type TagListResponse = z.infer<typeof TagListResponse>
