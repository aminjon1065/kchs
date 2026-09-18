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
  updatedFrom: z.string().optional(),
  updatedTo: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(1000).default(0),
})
export type SearchQuery = z.infer<typeof SearchQuery>

export const SearchFacet = z.object({
  field: z.string(),
  values: z.array(z.object({ value: z.string(), count: z.number().int() })),
})

export const SearchResponse = z.object({
  hits: z.array(SearchHit),
  total: z.number().int(),
  estimated: z.boolean().default(true),
  facets: z.array(SearchFacet).default([]),
  tookMs: z.number().int(),
})
export type SearchResponse = z.infer<typeof SearchResponse>
