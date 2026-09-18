import type { SearchDocument, SearchHit, SearchQuery, SearchResponse } from '@kchs/contracts'
import { eq, inArray } from 'drizzle-orm'
import { type Index, MeiliSearch } from 'meilisearch'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { readPrincipalsFor } from '../access/acl-service.js'
import { objectType } from '../objects/registry.js'
import { TagService } from '../tags/service.js'

/** Имя индекса объектов; префикс отделяет, например, тестовый индекс от рабочего. */
export function objectsIndexName(): string {
  return `${config().MEILI_INDEX_PREFIX}objects`
}

let client: MeiliSearch | null = null

export function meili(): MeiliSearch {
  if (!client) {
    const env = config()
    client = new MeiliSearch({ host: env.MEILI_HOST, apiKey: env.MEILI_MASTER_KEY })
  }
  return client
}

export function objectsIndex(): Index<SearchDocument> {
  return meili().index<SearchDocument>(objectsIndexName())
}

/** Настройка индекса: фильтры по правам и фасетам, ранжирование по свежести. */
export async function ensureSearchIndex(): Promise<void> {
  const log = logger().child({ module: 'search' })
  try {
    await meili().createIndex(objectsIndexName(), { primaryKey: 'id' })
  } catch {
    // индекс уже существует
  }
  await objectsIndex().updateSettings({
    searchableAttributes: ['title', 'body', 'tags'],
    filterableAttributes: ['type', 'spaceId', 'ownerId', 'aclPrincipals', 'updatedAt', 'parentId'],
    sortableAttributes: ['updatedAt'],
    displayedAttributes: ['*'],
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
    typoTolerance: { enabled: true, minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 } },
    pagination: { maxTotalHits: 5000 },
  })
  log.info('поисковый индекс готов')
}

/**
 * Индексация объекта. Права применяются фильтром `aclPrincipals`
 * (02-platform-kernel.md §8).
 */
export async function indexObject(objectId: string): Promise<void> {
  const [row] = await db().select().from(objects).where(eq(objects.id, objectId)).limit(1)
  if (!row || row.deletedAt) {
    await removeFromIndex(objectId)
    return
  }

  const definition = objectType(row.type)
  const custom = definition?.searchable ? await definition.searchable(objectId) : null
  if (definition?.searchable && custom === null) {
    await removeFromIndex(objectId)
    return
  }

  const aclPrincipals = await readPrincipalsFor(objectId)
  const tagNames = await TagService.names(objectId)
  const document: SearchDocument = {
    id: objectId,
    objectId,
    parentId: row.parentId,
    type: row.type,
    spaceId: row.spaceId,
    title: row.title,
    body: row.subtitle ?? '',
    ownerId: row.ownerId,
    updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
    meta: row.meta,
    aclPrincipals,
    ...custom,
    tags: tagNames,
  }

  await objectsIndex().addDocuments([document])
}

export async function indexObjects(objectIds: string[]): Promise<void> {
  for (const id of objectIds) await indexObject(id)
}

export async function removeFromIndex(objectId: string): Promise<void> {
  await objectsIndex()
    .deleteDocument(objectId)
    .catch(() => undefined)
}

/** Полная переиндексация (обслуживание, восстановление после сбоя). */
export async function reindexAll(batchSize = 200): Promise<number> {
  await ensureSearchIndex()
  let offset = 0
  let total = 0
  for (;;) {
    const rows = await db().select({ id: objects.id }).from(objects).limit(batchSize).offset(offset)
    if (rows.length === 0) break
    await indexObjects(rows.map((r) => r.id))
    total += rows.length
    offset += batchSize
  }
  return total
}

/**
 * Строковое значение для выражения фильтра Meilisearch. Значения экранируются
 * всегда, даже прошедшие валидацию: выход из кавычек позволил бы дописать
 * `) OR (…` и обойти фильтр прав — в Meilisearch AND связывает сильнее OR.
 */
export function meiliValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function anyOf(field: string, values: string[]): string {
  return `(${values.map((v) => `${field} = ${meiliValue(v)}`).join(' OR ')})`
}

/** Поиск с фильтром прав: пользователь видит только свои принципалы. */
export async function search(ctx: UserCtx, query: SearchQuery): Promise<SearchResponse> {
  const started = Date.now()
  const filters: string[] = []

  if (!ctx.isSystemAdmin && !ctx.isSecurityAuditor) {
    const principals = ctx.principals.keys.filter((k) => !k.startsWith('acting_as:'))
    filters.push(
      `(${[...principals.map((k) => `aclPrincipals = ${meiliValue(k)}`), `ownerId = ${meiliValue(ctx.userId)}`].join(' OR ')})`,
    )
  }
  if (query.types?.length) filters.push(anyOf('type', query.types))
  if (query.spaceIds?.length) filters.push(anyOf('spaceId', query.spaceIds))
  if (query.ownerIds?.length) filters.push(anyOf('ownerId', query.ownerIds))
  if (query.updatedFrom) {
    filters.push(`updatedAt >= ${epochSeconds(query.updatedFrom)}`)
  }
  if (query.updatedTo) {
    filters.push(`updatedAt <= ${epochSeconds(query.updatedTo)}`)
  }

  const result = await objectsIndex().search(query.q, {
    limit: query.limit,
    offset: query.offset,
    filter: filters.length ? filters.join(' AND ') : undefined,
    attributesToCrop: ['body'],
    cropLength: 30,
    attributesToHighlight: ['title', 'body'],
    highlightPreTag: '<mark>',
    highlightPostTag: '</mark>',
    facets: ['type', 'spaceId'],
  })

  const spaceIds = [...new Set(result.hits.map((h) => h.spaceId).filter(Boolean))] as string[]
  const spaceTitles = spaceIds.length
    ? new Map(
        (
          await db()
            .select({ id: objects.id, title: objects.title })
            .from(objects)
            .where(inArray(objects.id, spaceIds))
        ).map((r) => [r.id, r.title]),
      )
    : new Map<string, string>()

  const hits: SearchHit[] = result.hits.map((hit) => {
    const formatted = (hit as unknown as { _formatted?: { title?: string; body?: string } })
      ._formatted
    const definition = objectType(hit.type)
    return {
      objectId: hit.objectId,
      type: hit.type as SearchHit['type'],
      title: formatted?.title ?? hit.title,
      snippet: formatted?.body ?? null,
      spaceId: hit.spaceId,
      spaceName: hit.spaceId ? (spaceTitles.get(hit.spaceId) ?? null) : null,
      icon: definition?.icon ?? null,
      url: definition?.route(hit.objectId) ?? `/o/${hit.objectId}`,
      updatedAt: new Date(hit.updatedAt * 1000).toISOString(),
      meta: hit.meta,
    }
  })

  return {
    hits,
    total: result.estimatedTotalHits ?? hits.length,
    estimated: true,
    facets: Object.entries(result.facetDistribution ?? {}).map(([field, values]) => ({
      field,
      values: Object.entries(values as Record<string, number>).map(([value, count]) => ({
        value,
        count,
      })),
    })),
    tookMs: Date.now() - started,
  }
}

function epochSeconds(value: string): number {
  const ms = new Date(value).getTime()
  if (Number.isNaN(ms)) throw errors.validation('Некорректная дата в фильтре поиска')
  return Math.floor(ms / 1000)
}

export async function searchHealthy(): Promise<boolean> {
  try {
    const health = await meili().health()
    return health.status === 'available'
  } catch {
    return false
  }
}
