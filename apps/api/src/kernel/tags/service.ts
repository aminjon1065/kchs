import { TAG_NAME_MAX, TAGS_PER_OBJECT_MAX, type TagColor, type TagView } from '@kchs/contracts'
import { and, asc, eq, ilike, isNull, or, type SQL, sql } from 'drizzle-orm'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, objectTags, tags } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { publishEvent } from '../events/publisher.js'

/** Имя тега: пробелы схлопнуты, не длиннее TAG_NAME_MAX символов. */
export function normalizeTagName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim()
  if (!name) throw errors.validation('Пустое имя тега', [{ path: 'name', message: 'empty' }])
  if (name.length > TAG_NAME_MAX) {
    throw errors.validation(`Имя тега длиннее ${TAG_NAME_MAX} символов`, [
      { path: 'name', message: 'too_long' },
    ])
  }
  return name
}

/** Словарь пространства и общие теги (без пространства), видимые везде. */
function visibleIn(spaceId: string | null): SQL | undefined {
  return spaceId ? or(eq(tags.spaceId, spaceId), isNull(tags.spaceId)) : isNull(tags.spaceId)
}

/** Тег по имени без учёта регистра; тег пространства важнее общего. */
async function findTag(tx: Executor, spaceId: string | null, name: string) {
  const [tag] = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(visibleIn(spaceId), sql`lower(${tags.name}) = lower(${name})`))
    .orderBy(sql`${tags.spaceId} nulls last`)
    .limit(1)
  return tag
}

async function eventObject(tx: Executor, objectId: string) {
  const [object] = await tx
    .select({ id: objects.id, type: objects.type, spaceId: objects.spaceId, title: objects.title })
    .from(objects)
    .where(eq(objects.id, objectId))
    .limit(1)
  return object ?? null
}

/**
 * Теги (02-platform-kernel.md §14): словарь по пространствам, назначение
 * объектам через `object_tags`. Тег создаётся в пространстве объекта при
 * первом использовании; имена уникальны без учёта регистра. Каждое изменение
 * набора тегов публикует `object.tagged` — по нему переиндексируется поиск
 * и обновляются открытые вкладки.
 */
export const TagService = {
  async forObject(objectId: string, executor: Executor = db()): Promise<TagView[]> {
    return executor
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(objectTags)
      .innerJoin(tags, eq(tags.id, objectTags.tagId))
      .where(eq(objectTags.objectId, objectId))
      .orderBy(asc(tags.name))
  },

  async add(
    tx: Executor,
    ctx: Ctx,
    objectId: string,
    input: { name: string; color?: TagColor | null },
  ): Promise<TagView[]> {
    const name = normalizeTagName(input.name)
    const object = await eventObject(tx, objectId)
    if (!object) throw errors.notFound()

    const tag =
      (await findTag(tx, object.spaceId, name)) ??
      // Одновременное создание одного имени: вставка без ошибки, затем чтение
      (await tx
        .insert(tags)
        .values({ id: newId(), spaceId: object.spaceId, name, color: input.color ?? null })
        .onConflictDoNothing()
        .then(() => findTag(tx, object.spaceId, name)))
    if (!tag) throw errors.internal('Тег не создан')

    const current = await TagService.forObject(objectId, tx)
    if (current.some((item) => item.id === tag.id)) return current
    if (current.length >= TAGS_PER_OBJECT_MAX) {
      throw errors.validation(`У объекта не больше ${TAGS_PER_OBJECT_MAX} тегов`, [
        { path: 'name', message: 'too_many' },
      ])
    }
    await tx.insert(objectTags).values({ objectId, tagId: tag.id }).onConflictDoNothing()
    const next = await TagService.forObject(objectId, tx)
    await publishEvent(tx, ctx, {
      type: 'object.tagged',
      object,
      payload: { tagIds: next.map((item) => item.id) },
    })
    return next
  },

  async remove(tx: Executor, ctx: Ctx, objectId: string, tagId: string): Promise<TagView[]> {
    const deleted = await tx
      .delete(objectTags)
      .where(and(eq(objectTags.objectId, objectId), eq(objectTags.tagId, tagId)))
      .returning({ tagId: objectTags.tagId })
    const next = await TagService.forObject(objectId, tx)
    if (deleted.length > 0) {
      await publishEvent(tx, ctx, {
        type: 'object.tagged',
        object: await eventObject(tx, objectId),
        payload: { tagIds: next.map((item) => item.id) },
      })
    }
    return next
  },

  /** Подсказки: теги пространства и общие, по началу имени. */
  async suggest(spaceId: string | null, q: string, limit = 20): Promise<TagView[]> {
    const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`)
    const scope = visibleIn(spaceId)
    return db()
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(tags)
      .where(q ? and(scope, ilike(tags.name, `${escaped}%`)) : scope)
      .orderBy(asc(tags.name))
      .limit(limit)
  },

  /** Имена тегов объекта для поискового индекса. */
  async names(objectId: string): Promise<string[]> {
    return (await TagService.forObject(objectId)).map((tag) => tag.name)
  },
}
