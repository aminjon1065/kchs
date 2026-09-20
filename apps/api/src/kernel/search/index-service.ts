import {
  confidentialityRank,
  type SearchDocument,
  type SearchHit,
  type SearchQuery,
  type SearchResponse,
} from '@kchs/contracts'
import { and, asc, eq, gt, gte, inArray, lte, or, sql } from 'drizzle-orm'
import { type Index, MeiliSearch } from 'meilisearch'
import { config } from '~/shared/config/index.js'
import type { UserCtx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { links, objectAncestors, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { readPrincipalsFor } from '../access/acl-service.js'
import { clearanceLimit, effectiveConfidentiality } from '../access/confidentiality.js'
import { objectType } from '../objects/registry.js'
import { TagService } from '../tags/service.js'
import { type SemanticHit, semanticEnabled, semanticSearch, similarObjects } from './semantic.js'

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
    filterableAttributes: [
      'type',
      'spaceId',
      'ownerId',
      'aclPrincipals',
      'updatedAt',
      'parentId',
      'clearance',
      // Статус объекта в модуле: поиск в архиве документов (ADR-0086)
      'meta.status',
    ],
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
  // Гриф — свой или объекта, к которому прикреплено (ADR-0080): выдачу режет допуск
  const clearance = confidentialityRank(await effectiveConfidentiality(objectId))
  const tagNames = await TagService.names(objectId)
  const document: SearchDocument = {
    parentId: row.parentId,
    type: row.type,
    spaceId: row.spaceId,
    title: row.title,
    body: row.subtitle ?? '',
    ownerId: row.ownerId,
    updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
    meta: row.meta,
    ...custom,
    // Идентичность, права и теги — только от ядра (см. SearchContent)
    id: objectId,
    objectId,
    aclPrincipals,
    clearance,
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

/** Есть ли объекты, чьи читатели зависят от прав данного: потомки и его вложения. */
export async function hasAccessDependents(objectId: string): Promise<boolean> {
  const [descendant] = await db()
    .select({ id: objectAncestors.objectId })
    .from(objectAncestors)
    .where(eq(objectAncestors.ancestorId, objectId))
    .limit(1)
  if (descendant) return true
  const [attachment] = await db()
    .select({ id: links.id })
    .from(links)
    .where(and(eq(links.sourceId, objectId), eq(links.kind, 'attachment')))
    .limit(1)
  return Boolean(attachment)
}

/**
 * Переиндексация поддерева: читатели потомков зависят от прав предков
 * (наследование ACL и граница restricted), поэтому изменение доступа или
 * перенос папки меняет фильтр прав у всего её содержимого.
 */
export async function reindexSubtree(objectId: string, batchSize = 200): Promise<number> {
  await indexObject(objectId)
  let total = 1
  let cursor: string | null = null
  for (;;) {
    const scope = eq(objectAncestors.ancestorId, objectId)
    const rows: Array<{ id: string }> = await db()
      .select({ id: objectAncestors.objectId })
      .from(objectAncestors)
      .where(cursor ? and(scope, gt(objectAncestors.objectId, cursor)) : scope)
      .orderBy(asc(objectAncestors.objectId))
      .limit(batchSize)
    if (rows.length === 0) break
    await indexObjects(rows.map((row) => row.id))
    total += rows.length
    cursor = rows[rows.length - 1]?.id ?? null
  }

  // Вложения объекта и его потомков: их читатели — читатели объектов-хостов
  const subtree = db()
    .select({ id: objectAncestors.objectId })
    .from(objectAncestors)
    .where(eq(objectAncestors.ancestorId, objectId))
  const attached = await db()
    .selectDistinct({ id: links.targetId })
    .from(links)
    .where(
      and(
        eq(links.kind, 'attachment'),
        or(eq(links.sourceId, objectId), inArray(links.sourceId, subtree)),
      ),
    )
  await indexObjects(attached.map((row) => row.id))
  return total + attached.length
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
  // Гриф выше допуска не находится никем — и администратором вне режима (ADR-0080).
  // Документы, проиндексированные до появления грифов, ранга не имеют — они общие
  const limit = clearanceLimit(ctx)
  if (limit !== null) filters.push(`(clearance NOT EXISTS OR clearance <= ${limit})`)
  if (query.types?.length) filters.push(anyOf('type', query.types))
  if (query.spaceIds?.length) filters.push(anyOf('spaceId', query.spaceIds))
  if (query.ownerIds?.length) filters.push(anyOf('ownerId', query.ownerIds))
  if (query.statuses?.length) filters.push(anyOf('meta.status', query.statuses))
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
    facets: ['type', 'spaceId', 'meta.status'],
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

  // Смысл поверх слов (ADR-0099): списки сливаются рангами (RRF), поэтому
  // точное совпадение слов не тонет, а близкий по смыслу текст находится
  const semanticHits =
    query.mode === 'hybrid' && query.offset === 0 && query.q.trim().length >= 3
      ? await semanticSearch(ctx, query.q, query.limit)
      : []
  const merged = semanticHits.length > 0 ? await fuse(ctx, hits, semanticHits, query) : hits

  return {
    hits: merged,
    total: Math.max(result.estimatedTotalHits ?? hits.length, merged.length),
    semantic: semanticHits.length > 0,
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

/** Ранговое слияние двух списков (RRF): чем выше в любом, тем выше в общем. */
const RRF_K = 60

async function fuse(
  ctx: UserCtx,
  words: SearchHit[],
  meaning: SemanticHit[],
  query: SearchQuery,
): Promise<SearchHit[]> {
  const scores = new Map<string, number>()
  words.forEach((hit, index) => {
    scores.set(hit.objectId, (scores.get(hit.objectId) ?? 0) + 1 / (RRF_K + index + 1))
  })
  meaning.forEach((hit, index) => {
    scores.set(hit.objectId, (scores.get(hit.objectId) ?? 0) + 1 / (RRF_K + index + 1))
  })

  const known = new Map(words.map((hit) => [hit.objectId, hit]))
  const missing = meaning.filter((hit) => !known.has(hit.objectId)).map((hit) => hit.objectId)
  const snippets = new Map(meaning.map((hit) => [hit.objectId, hit.text]))
  for (const hit of await hitsForObjects(ctx, missing, query)) {
    known.set(hit.objectId, { ...hit, snippet: snippets.get(hit.objectId) ?? hit.snippet })
  }

  return [...known.values()]
    .sort((a, b) => (scores.get(b.objectId) ?? 0) - (scores.get(a.objectId) ?? 0))
    .slice(0, query.limit)
}

/**
 * Карточки объектов, найденных только по смыслу. Фильтры запроса применяются
 * здесь же: в векторном индексе их нет, а выдача обязана им подчиняться.
 */
async function hitsForObjects(
  _ctx: UserCtx,
  objectIds: string[],
  query: SearchQuery,
): Promise<SearchHit[]> {
  if (objectIds.length === 0) return []
  const conditions = [inArray(objects.id, objectIds), sql`${objects.deletedAt} is null`]
  if (query.types?.length) conditions.push(inArray(objects.type, query.types))
  if (query.spaceIds?.length) conditions.push(inArray(objects.spaceId, query.spaceIds))
  if (query.ownerIds?.length) conditions.push(inArray(objects.ownerId, query.ownerIds))
  if (query.statuses?.length) {
    conditions.push(sql`${objects.meta}->>'status' in ${query.statuses}`)
  }
  if (query.updatedFrom) conditions.push(gte(objects.updatedAt, query.updatedFrom))
  if (query.updatedTo) conditions.push(lte(objects.updatedAt, query.updatedTo))

  const rows = await db()
    .select({
      id: objects.id,
      type: objects.type,
      title: objects.title,
      subtitle: objects.subtitle,
      spaceId: objects.spaceId,
      updatedAt: objects.updatedAt,
      meta: objects.meta,
    })
    .from(objects)
    .where(and(...conditions))

  const spaceIds = [...new Set(rows.map((row) => row.spaceId).filter(Boolean))] as string[]
  const spaceTitles = spaceIds.length
    ? new Map(
        (
          await db()
            .select({ id: objects.id, title: objects.title })
            .from(objects)
            .where(inArray(objects.id, spaceIds))
        ).map((row) => [row.id, row.title]),
      )
    : new Map<string, string>()

  return rows.map((row) => {
    const definition = objectType(row.type)
    return {
      objectId: row.id,
      type: row.type as SearchHit['type'],
      title: row.title,
      snippet: row.subtitle ?? null,
      spaceId: row.spaceId,
      spaceName: row.spaceId ? (spaceTitles.get(row.spaceId) ?? null) : null,
      icon: definition?.icon ?? null,
      url: definition?.route(row.id) ?? `/o/${row.id}`,
      updatedAt: row.updatedAt,
      meta: row.meta,
    }
  })
}

/** Похожие объекты для контекстной панели (ADR-0099). */
export async function similar(ctx: UserCtx, objectId: string, limit: number): Promise<SearchHit[]> {
  const hits = await similarObjects(ctx, objectId, limit)
  if (hits.length === 0) return []
  const cards = await hitsForObjects(
    ctx,
    hits.map((hit) => hit.objectId),
    { q: '', limit, offset: 0, mode: 'words' } as SearchQuery,
  )
  const order = new Map(hits.map((hit, index) => [hit.objectId, index]))
  const snippets = new Map(hits.map((hit) => [hit.objectId, hit.text]))
  return cards
    .map((card) => ({ ...card, snippet: snippets.get(card.objectId) ?? card.snippet }))
    .sort((a, b) => (order.get(a.objectId) ?? 0) - (order.get(b.objectId) ?? 0))
}

export { semanticEnabled }
