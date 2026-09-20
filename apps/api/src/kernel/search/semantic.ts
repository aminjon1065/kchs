import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { config } from '~/shared/config/index.js'
import type { Ctx } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import { EMBEDDING_DIM, embeddings, objects } from '~/shared/db/schema/index.js'
import { logger } from '~/shared/logger/index.js'
import { visibleObjectsSql } from '../access/authorize.js'
import { objectType } from '../objects/registry.js'

/**
 * Поиск по смыслу (13-search-knowledge-ai.md §1, ADR-0099): текст объекта
 * режется на куски, движок считает векторы (`bge-m3`), pgvector ищет ближайшие.
 * Без настроенной модели функция выключена — поиск остаётся словесным.
 */

/** Кусок текста: столько символов помещается в окно модели с запасом. */
const CHUNK_CHARS = 900
/** Нахлёст: фраза на границе кусков не теряет соседей. */
const CHUNK_OVERLAP = 120
/** Предел кусков на объект: длинный регламент не раздувает индекс. */
const MAX_CHUNKS = 40
/** Короткий текст (название + подпись) ищется словами не хуже — вектор не нужен. */
const MIN_TEXT = 80
/** Сколько времени помним, что движок ответил «модель не настроена». */
const DISABLED_TTL_MS = 5 * 60_000

let disabledUntil = 0

export interface SemanticHit {
  objectId: string
  /** Косинусная близость 0…1: 1 — полное совпадение смысла. */
  score: number
  /** Кусок текста, который совпал: цитата для ассистента и подсказки. */
  text: string
}

/** Настроена ли семантика: адрес движка, служебный токен и живая модель. */
export function semanticConfigured(): boolean {
  const env = config()
  return Boolean(env.ENGINE_INTERNAL_URL && env.INTERNAL_SERVICE_TOKEN)
}

export function semanticEnabled(): boolean {
  return semanticConfigured() && Date.now() >= disabledUntil
}

/** Ответ движка на векторизацию или null, если модель не настроена. */
async function embedTexts(texts: string[]): Promise<{ model: string; vectors: number[][] } | null> {
  if (!semanticEnabled() || texts.length === 0) return null
  const env = config()
  const log = logger().child({ module: 'semantic' })
  try {
    const response = await fetch(`${env.ENGINE_INTERNAL_URL}/ai/embed`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kchs-service-token': env.INTERNAL_SERVICE_TOKEN as string,
      },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(120_000),
    })
    if (response.status === 503) {
      // Модель не настроена: не спрашиваем движок снова каждую минуту
      disabledUntil = Date.now() + DISABLED_TTL_MS
      log.info('семантика выключена: модель векторов не настроена')
      return null
    }
    if (!response.ok) {
      log.warn({ status: response.status }, 'движок не посчитал векторы')
      return null
    }
    const body = (await response.json()) as { model: string; dim: number; vectors: number[][] }
    if (body.dim !== EMBEDDING_DIM) {
      disabledUntil = Date.now() + DISABLED_TTL_MS
      log.warn({ dim: body.dim }, `модель векторов даёт не ${EMBEDDING_DIM} измерений`)
      return null
    }
    return { model: body.model, vectors: body.vectors }
  } catch (error) {
    log.warn({ err: error }, 'движок недоступен для векторов')
    return null
  }
}

/** Режет текст на куски по границам абзацев и предложений. */
export function chunkText(text: string): string[] {
  const clean = text
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
  if (clean.length <= CHUNK_CHARS) return clean ? [clean] : []
  const chunks: string[] = []
  let start = 0
  while (start < clean.length && chunks.length < MAX_CHUNKS) {
    const end = Math.min(start + CHUNK_CHARS, clean.length)
    let cut = end
    if (end < clean.length) {
      const window = clean.slice(start, end)
      const stop = Math.max(
        window.lastIndexOf('\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
      )
      if (stop > CHUNK_CHARS / 2) cut = start + stop + 1
    }
    chunks.push(clean.slice(start, cut).trim())
    if (cut >= clean.length) break
    start = Math.max(cut - CHUNK_OVERLAP, start + 1)
  }
  return chunks.filter(Boolean)
}

/** Текст объекта для векторов: название, подпись и содержимое типа. */
async function textOf(objectId: string): Promise<string | null> {
  const [row] = await db()
    .select({ type: objects.type, title: objects.title, subtitle: objects.subtitle })
    .from(objects)
    .where(and(eq(objects.id, objectId), sql`${objects.deletedAt} is null`))
    .limit(1)
  if (!row) return null
  const definition = objectType(row.type)
  const custom = definition?.searchable ? await definition.searchable(objectId) : null
  if (definition?.searchable && custom === null) return null
  const parts = [row.title, row.subtitle ?? '', custom?.body ?? '']
  const text = parts.filter(Boolean).join('\n\n').trim()
  return text.length >= MIN_TEXT ? text : null
}

const hashOf = (text: string): string =>
  createHash('sha256').update(text).digest('base64url').slice(0, 22)

/**
 * Пересчитывает векторы объекта. Неизменившиеся куски не пересчитываются:
 * правка одного абзаца не гоняет модель по всему регламенту.
 */
export async function indexEmbeddings(objectId: string): Promise<number> {
  if (!semanticEnabled()) return 0
  const text = await textOf(objectId)
  if (!text) {
    await db().delete(embeddings).where(eq(embeddings.objectId, objectId))
    return 0
  }

  const chunks = chunkText(text)
  const existing = await db()
    .select({ chunkNo: embeddings.chunkNo, hash: embeddings.hash })
    .from(embeddings)
    .where(eq(embeddings.objectId, objectId))
  const known = new Map(existing.map((row) => [row.chunkNo, row.hash]))

  const stale = chunks
    .map((chunk, index) => ({ index, chunk, hash: hashOf(chunk) }))
    .filter((item) => known.get(item.index) !== item.hash)
  const embedded = await embedTexts(stale.map((item) => item.chunk))
  if (!embedded) return 0

  await db().transaction(async (tx) => {
    for (const [position, item] of stale.entries()) {
      const vector = embedded.vectors[position]
      if (!vector) continue
      await tx
        .insert(embeddings)
        .values({
          objectId,
          chunkNo: item.index,
          text: item.chunk,
          embedding: vector,
          model: embedded.model,
          hash: item.hash,
          indexedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: [embeddings.objectId, embeddings.chunkNo],
          set: {
            text: item.chunk,
            embedding: vector,
            model: embedded.model,
            hash: item.hash,
            indexedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        })
    }
    // Объект укоротили — лишние куски уходят вместе с ним
    const extra = [...known.keys()].filter((chunkNo) => chunkNo >= chunks.length)
    if (extra.length > 0) {
      await tx
        .delete(embeddings)
        .where(and(eq(embeddings.objectId, objectId), inArray(embeddings.chunkNo, extra)))
    }
  })
  return stale.length
}

export async function dropEmbeddings(objectId: string): Promise<void> {
  await db().delete(embeddings).where(eq(embeddings.objectId, objectId))
}

/** Ближайшие по смыслу куски, видимые смотрящему; по объекту — лучший кусок. */
async function nearest(
  ctx: Ctx,
  vector: number[],
  limit: number,
  options: { excludeObjectId?: string; types?: readonly string[] } = {},
): Promise<SemanticHit[]> {
  const literal = sql.raw(`'[${vector.join(',')}]'::extensions.vector`)
  const rows = await db()
    .select({
      objectId: embeddings.objectId,
      text: embeddings.text,
      distance: sql<number>`${embeddings.embedding} <=> ${literal}`,
    })
    .from(embeddings)
    .innerJoin(objects, eq(objects.id, embeddings.objectId))
    .where(
      and(
        sql`${objects.deletedAt} is null`,
        visibleObjectsSql(ctx),
        options.excludeObjectId
          ? sql`${embeddings.objectId} <> ${options.excludeObjectId}`
          : sql`true`,
        options.types?.length ? inArray(objects.type, [...options.types]) : sql`true`,
      ),
    )
    .orderBy(sql`${embeddings.embedding} <=> ${literal}`)
    .limit(limit * 4)

  const best = new Map<string, SemanticHit>()
  for (const row of rows) {
    const score = 1 - Number(row.distance)
    const current = best.get(row.objectId)
    if (!current || score > current.score) {
      best.set(row.objectId, { objectId: row.objectId, score, text: row.text })
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}

/** Поиск по смыслу: пустой ответ, если семантика выключена. */
export async function semanticSearch(
  ctx: Ctx,
  query: string,
  limit = 20,
  options: { types?: readonly string[] } = {},
): Promise<SemanticHit[]> {
  const trimmed = query.trim()
  if (!trimmed || !semanticEnabled()) return []
  const embedded = await embedTexts([trimmed])
  const vector = embedded?.vectors[0]
  if (!vector) return []
  return nearest(ctx, vector, limit, options)
}

/** Похожие объекты: по векторам самого объекта, сам он из выдачи исключён. */
export async function similarObjects(
  ctx: Ctx,
  objectId: string,
  limit = 10,
): Promise<SemanticHit[]> {
  if (!semanticEnabled()) return []
  const [row] = await db()
    .select({ embedding: embeddings.embedding })
    .from(embeddings)
    .where(and(eq(embeddings.objectId, objectId), eq(embeddings.chunkNo, 0)))
    .limit(1)
  if (!row) return []
  return nearest(ctx, row.embedding, limit, { excludeObjectId: objectId })
}

/**
 * Векторы по готовым кускам: модуль, который знает структуру объекта (база
 * знаний режет страницу по блокам), передаёт их сам — тогда цитата совпадает
 * с фрагментом, который видит человек.
 */
export async function indexChunks(
  objectId: string,
  chunks: ReadonlyArray<{ text: string }>,
): Promise<number> {
  if (!semanticEnabled()) return 0
  const texts = chunks
    .map((chunk) => chunk.text.trim())
    .filter(Boolean)
    .slice(0, MAX_CHUNKS)
  if (texts.length === 0) {
    await dropEmbeddings(objectId)
    return 0
  }

  const existing = await db()
    .select({ chunkNo: embeddings.chunkNo, hash: embeddings.hash })
    .from(embeddings)
    .where(eq(embeddings.objectId, objectId))
  const known = new Map(existing.map((row) => [row.chunkNo, row.hash]))
  const stale = texts
    .map((text, index) => ({ index, text, hash: hashOf(text) }))
    .filter((item) => known.get(item.index) !== item.hash)
  const embedded = await embedTexts(stale.map((item) => item.text))
  if (!embedded) return 0

  await db().transaction(async (tx) => {
    for (const [position, item] of stale.entries()) {
      const vector = embedded.vectors[position]
      if (!vector) continue
      await tx
        .insert(embeddings)
        .values({
          objectId,
          chunkNo: item.index,
          text: item.text,
          embedding: vector,
          model: embedded.model,
          hash: item.hash,
          indexedAt: sql`now()`,
        })
        .onConflictDoUpdate({
          target: [embeddings.objectId, embeddings.chunkNo],
          set: {
            text: item.text,
            embedding: vector,
            model: embedded.model,
            hash: item.hash,
            indexedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        })
    }
    const extra = [...known.keys()].filter((chunkNo) => chunkNo >= texts.length)
    if (extra.length > 0) {
      await tx
        .delete(embeddings)
        .where(and(eq(embeddings.objectId, objectId), inArray(embeddings.chunkNo, extra)))
    }
  })
  return stale.length
}
