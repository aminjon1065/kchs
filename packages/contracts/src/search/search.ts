import { z } from 'zod'
import { Timestamp, Uuid } from '../common/primitives.js'
import { ObjectType } from '../objects/object.js'

/** Документ поискового индекса (02-platform-kernel.md §8). */
export const SearchDocument = z.object({
  id: z.string(),
  objectId: Uuid,
  parentId: Uuid.nullable(),
  type: z.string(),
  spaceId: Uuid.nullable(),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()).default([]),
  ownerId: Uuid.nullable(),
  updatedAt: z.number().int(),
  meta: z.record(z.string(), z.unknown()).default({}),
  /** Принципалы с правом чтения — фильтр выдачи. */
  aclPrincipals: z.array(z.string()).default([]),
  /**
   * Ранг действующего грифа (0 — public … 3 — secret): выдача ограничена
   * допуском смотрящего (ADR-0080). Задаёт только ядро, как и права.
   */
  clearance: z.number().int().min(0).max(3).default(0),
})
export type SearchDocument = z.infer<typeof SearchDocument>

export const SearchHit = z.object({
  objectId: Uuid,
  type: ObjectType,
  title: z.string(),
  snippet: z.string().nullable(),
  spaceId: Uuid.nullable(),
  spaceName: z.string().nullable(),
  icon: z.string().nullable(),
  url: z.string(),
  updatedAt: Timestamp,
  score: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
})
export type SearchHit = z.infer<typeof SearchHit>

export const SearchQuery = z.object({
  q: z.string().max(500).default(''),
  types: z.array(ObjectType).optional(),
  spaceIds: z.array(Uuid).optional(),
  ownerIds: z.array(Uuid).optional(),
  /**
   * Статус объекта в его модуле (`meta.status`): поиск в архиве документов —
   * общий поиск с фильтром статуса (08-documents.md §12, ADR-0086).
   */
  statuses: z.array(z.string().min(1).max(40)).max(20).optional(),
  updatedFrom: z.string().optional(),
  updatedTo: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(1000).default(0),
  /**
   * `hybrid` — слова и смысл вместе (по умолчанию, ADR-0099); `words` — только
   * словесный поиск. Без настроенной модели векторов режимы совпадают.
   */
  mode: z.enum(['hybrid', 'words']).default('hybrid'),
})
export type SearchQuery = z.infer<typeof SearchQuery>

export const SearchFacet = z.object({
  field: z.string(),
  values: z.array(z.object({ value: z.string(), count: z.number().int() })),
})

export const SearchResponse = z.object({
  hits: z.array(SearchHit),
  total: z.number().int(),
  /** В выдаче участвовал поиск по смыслу (модель векторов настроена). */
  semantic: z.boolean().default(false),
  estimated: z.boolean().default(true),
  facets: z.array(SearchFacet).default([]),
  tookMs: z.number().int(),
})
export type SearchResponse = z.infer<typeof SearchResponse>

/** Похожие объекты (ADR-0099): ближайшие по смыслу к данному. */
export const SimilarQuery = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(6),
})
export type SimilarQuery = z.infer<typeof SimilarQuery>

export const SimilarObjects = z.object({
  items: z.array(SearchHit),
  /** Семантика выключена: модель векторов не настроена в этой установке. */
  enabled: z.boolean(),
})
export type SimilarObjects = z.infer<typeof SimilarObjects>
