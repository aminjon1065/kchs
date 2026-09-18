import { z } from 'zod'
import { FilterNode } from '../common/filter.js'
import { Uuid } from '../common/primitives.js'
import { SortItem } from '../common/sort.js'
import { FieldType } from '../fields/field-def.js'
import { ObjectType } from '../objects/object.js'

/** Режимы CollectionView (02-platform-kernel.md §13). */
export const VIEW_MODES = [
  'table',
  'list',
  'board',
  'calendar',
  'timeline',
  'map',
  'gallery',
] as const
export const ViewMode = z.enum(VIEW_MODES)
export type ViewMode = z.infer<typeof ViewMode>

export const ViewColumn = z.object({
  key: z.string(),
  width: z.number().int().min(40).max(1200).optional(),
  pinned: z.enum(['left', 'right']).nullable().optional(),
  hidden: z.boolean().default(false),
})

export const ViewDefinition = z.object({
  mode: ViewMode.default('table'),
  filter: FilterNode.nullable().default(null),
  sort: z.array(SortItem).default([]),
  groupBy: z.string().nullable().default(null),
  columns: z.array(ViewColumn).default([]),
  search: z.string().default(''),
  density: z.enum(['comfortable', 'compact']).optional(),
  params: z.record(z.string(), z.unknown()).default({}),
})
export type ViewDefinition = z.infer<typeof ViewDefinition>

export const SavedView = z.object({
  id: Uuid,
  title: z.string(),
  objectType: z.string(),
  spaceId: Uuid.nullable(),
  ownerId: Uuid.nullable(),
  shared: z.boolean(),
  pinned: z.boolean(),
  definition: ViewDefinition,
})
export type SavedView = z.infer<typeof SavedView>

export const ViewCreateInput = z.object({
  title: z.string().min(1).max(200),
  objectType: z.string().min(1).max(64),
  spaceId: Uuid.nullable().optional(),
  shared: z.boolean().default(false),
  definition: ViewDefinition,
})
export type ViewCreateInput = z.infer<typeof ViewCreateInput>

/** Запрос списка объектов через CollectionView. */
export const ObjectListQuery = z.object({
  type: ObjectType.optional(),
  types: z.string().optional(),
  spaceId: Uuid.optional(),
  /** `root` — только объекты верхнего уровня пространства (parent_id IS NULL). */
  parentId: z.union([Uuid, z.literal('root')]).optional(),
  q: z.string().max(300).optional(),
  filter: z.string().optional(),
  sort: z.string().optional(),
  lifecycle: z.enum(['active', 'archived', 'trashed', 'any']).default('active'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // stringbool: z.coerce.boolean превращал строку «false» в true
  count: z.stringbool().optional(),
  /** Системные объекты (папка «Вложения») в списки не попадают, пока их не запросили явно. */
  includeSystem: z.stringbool().optional(),
})
export type ObjectListQuery = z.infer<typeof ObjectListQuery>

/**
 * Поле списка объектов для FilterBuilder и сортировки CollectionView.
 * Общие поля есть у всех объектов, модули добавляют поля своих типов.
 */
export const ListField = z.object({
  key: z.string(),
  /** Ключ словаря подписи. */
  labelKey: z.string(),
  type: FieldType,
  sortable: z.boolean().default(false),
  options: z.array(z.object({ value: z.string(), labelKey: z.string() })).optional(),
})
export type ListField = z.infer<typeof ListField>

export const ListFieldsResponse = z.object({ items: z.array(ListField) })
export type ListFieldsResponse = z.infer<typeof ListFieldsResponse>
