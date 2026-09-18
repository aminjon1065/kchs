import {
  BatchGetInput,
  cursorPage,
  LinkCreateInput,
  ListFieldsResponse,
  levelValue,
  ObjectListQuery,
  ObjectPatchInput,
  ObjectRecord,
  ObjectSummary,
  ObjectType,
  SortQuery,
} from '@kchs/contracts'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { isGuest } from '~/shared/context.js'
import { db } from '~/shared/db/client.js'
import {
  favorites,
  objectAncestors,
  objects,
  objectTags,
  recentViews,
  subscriptions,
  tags,
} from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { decodeCursor, encodeCursor } from '~/shared/http/pagination.js'
import type { RouteRegistrar } from '~/shared/http/route.js'
import { authorize, loadObject, visibleObjectsSql } from '../access/authorize.js'
import { listActivity } from '../activity/service.js'
import { LinkService } from '../links/service.js'
import { compileObjectFilter, compileObjectSort, parseFilter } from './filter-sql.js'
import { describeListFields, listFieldsFor } from './list-fields.js'
import { allowedActions, objectType } from './registry.js'
import { hiddenSummary, ObjectService } from './service.js'

const IdParam = z.object({ id: z.uuid() })
const RECENT_LIMIT = 200

export function registerObjectRoutes(route: RouteRegistrar): void {
  // ─── Карточка объекта ──────────────────────────────────────────────────────
  route({
    method: 'GET',
    url: '/objects/:id',
    auth: { action: 'view' },
    tags: ['objects'],
    summary: 'Карточка объекта из реестра',
    schema: { params: IdParam, response: { 200: ObjectRecord } },
    handler: async (request) => {
      const { id } = request.params
      const decision = await authorize(request.ctx, 'view', id)
      const [row] = await db().select().from(objects).where(eq(objects.id, id)).limit(1)
      if (!row) throw errors.notFound()

      const definition = objectType(row.type)
      // У гостя по ссылке нет личного состояния: избранного, подписок и недавних
      const personal = !isGuest(request.ctx)
      const [breadcrumbRows, tagRows, favRow, subRow] = await Promise.all([
        db()
          .select({
            id: objects.id,
            type: objects.type,
            title: objects.title,
            depth: objectAncestors.depth,
          })
          .from(objectAncestors)
          .innerJoin(objects, eq(objects.id, objectAncestors.ancestorId))
          .where(eq(objectAncestors.objectId, id))
          .orderBy(desc(objectAncestors.depth)),
        db()
          .select({ id: tags.id, name: tags.name, color: tags.color })
          .from(objectTags)
          .innerJoin(tags, eq(tags.id, objectTags.tagId))
          .where(eq(objectTags.objectId, id)),
        personal
          ? db()
              .select({ objectId: favorites.objectId })
              .from(favorites)
              .where(and(eq(favorites.userId, request.ctx.userId), eq(favorites.objectId, id)))
              .limit(1)
          : [],
        personal
          ? db()
              .select({ objectId: subscriptions.objectId })
              .from(subscriptions)
              .where(
                and(eq(subscriptions.userId, request.ctx.userId), eq(subscriptions.objectId, id)),
              )
              .limit(1)
          : [],
      ])

      const summaries = await ObjectService.summaries([id])
      const summary = summaries.get(id)!

      // Недавние: фиксируем просмотр
      if (personal) {
        await db()
          .insert(recentViews)
          .values({ userId: request.ctx.userId, objectId: id })
          .onConflictDoUpdate({
            target: [recentViews.userId, recentViews.objectId],
            set: { viewedAt: sql`now()` },
          })
      }

      return {
        ...summary,
        parentId: row.parentId,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        archivedAt: row.archivedAt,
        deletedAt: row.deletedAt,
        accessMode: row.accessMode as 'inherit' | 'restricted',
        version: row.version,
        tags: tagRows,
        breadcrumbs: breadcrumbRows.map((b) => ({ id: b.id, type: b.type, title: b.title })),
        level: decision.level,
        allowedActions: allowedActions(row.type, decision.level, request.ctx, levelValue),
        favorite: favRow.length > 0,
        subscribed: subRow.length > 0,
        icon: row.icon ?? definition?.icon ?? null,
      }
    },
  })

  route({
    method: 'PATCH',
    url: '/objects/:id',
    auth: { action: 'edit' },
    tags: ['objects'],
    summary: 'Изменить общие поля объекта',
    schema: { params: IdParam, body: ObjectPatchInput, response: { 200: ObjectSummary } },
    handler: async (request) => {
      const { id } = request.params
      const patch = request.body
      const expectedVersion = request.headers['if-match']
        ? Number(String(request.headers['if-match']).replace(/"/g, ''))
        : undefined

      await db().transaction(async (tx) => {
        if (patch.parentId !== undefined || patch.spaceId !== undefined) {
          const decision = await authorize(request.ctx, 'move', id)
          // Перенос кладёт объект в чужой контейнер: нужно право создавать в нём,
          // иначе можно подбросить объект в пространство, к которому нет доступа
          const current = await loadObject(id, tx)
          const destination = patch.parentId ?? patch.spaceId ?? current?.spaceId ?? null
          if (destination && decision.allowed) {
            await authorize(request.ctx, 'create_child', destination)
          }
          await ObjectService.move(tx, request.ctx, id, {
            parentId: patch.parentId,
            spaceId: patch.spaceId,
          })
        }
        await ObjectService.update(
          tx,
          request.ctx,
          id,
          {
            title: patch.title,
            subtitle: patch.subtitle,
            icon: patch.icon,
            meta: patch.meta,
            mergeMeta: true,
          },
          { expectedVersion },
        )
      })

      const summaries = await ObjectService.summaries([id])
      return summaries.get(id)
    },
  })

  route({
    method: 'DELETE',
    url: '/objects/:id',
    auth: { action: 'delete' },
    tags: ['objects'],
    summary: 'Переместить объект в корзину',
    schema: { params: IdParam, response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
      await db().transaction((tx) => ObjectService.trash(tx, request.ctx, request.params.id))
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/objects/:id/restore',
    // Объект уже в корзине: политика проверяется вручную с allowTrashed
    auth: 'session',
    tags: ['objects'],
    summary: 'Восстановить объект из корзины или архива',
    schema: { params: IdParam, response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
      await authorize(request.ctx, 'delete', request.params.id, { allowTrashed: true })
      await db().transaction((tx) => ObjectService.restore(tx, request.ctx, request.params.id))
      return { ok: true }
    },
  })

  route({
    method: 'POST',
    url: '/objects/:id/archive',
    auth: { action: 'archive' },
    tags: ['objects'],
    summary: 'Отправить объект в архив',
    schema: { params: IdParam, response: { 200: z.object({ ok: z.boolean() }) } },
    handler: async (request) => {
      await db().transaction((tx) => ObjectService.archive(tx, request.ctx, request.params.id))
      return { ok: true }
    },
  })

  // ─── Пакетная выборка сводок ───────────────────────────────────────────────
  route({
    method: 'POST',
    url: '/objects/batch-get',
    auth: 'session',
    tags: ['objects'],
    summary: 'Сводки объектов для чипов и пикеров',
    schema: { body: BatchGetInput, response: { 200: z.object({ items: z.array(ObjectSummary) }) } },
    handler: async (request) => {
      const summaries = await ObjectService.summaries(request.body.ids)
      const items: unknown[] = []
      for (const [id, summary] of summaries) {
        const decision = await authorize(request.ctx, 'view', id, { soft: true })
        items.push(decision.allowed ? summary : hiddenSummary(summary))
      }
      return { items }
    },
  })

  // ─── Списки объектов ───────────────────────────────────────────────────────
  route({
    method: 'GET',
    url: '/objects/fields',
    auth: 'session',
    tags: ['objects'],
    summary: 'Поля списка объектов для фильтров и сортировки',
    schema: {
      querystring: z.object({ type: ObjectType.optional(), types: z.string().max(500).optional() }),
      response: { 200: ListFieldsResponse },
    },
    handler: async (request) => ({
      items: describeListFields(listFieldsFor(requestedTypes(request.query))),
    }),
  })

  route({
    method: 'GET',
    url: '/objects',
    auth: 'session',
    tags: ['objects'],
    summary: 'Список объектов с учётом видимости, фильтром и сортировкой',
    schema: {
      querystring: ObjectListQuery,
      response: { 200: cursorPage(ObjectSummary) },
    },
    handler: async (request) => {
      const query = request.query
      const fields = listFieldsFor(requestedTypes(query))
      const filter = parseFilter(query.filter)
      const sort = query.sort ? SortQuery.parse(query.sort) : []
      const conditions = [visibleObjectsSql(request.ctx, query.type)]

      if (query.lifecycle === 'active') {
        conditions.push(isNull(objects.deletedAt), isNull(objects.archivedAt))
      } else if (query.lifecycle === 'archived') {
        conditions.push(isNull(objects.deletedAt), sql`${objects.archivedAt} is not null`)
      } else if (query.lifecycle === 'trashed') {
        conditions.push(sql`${objects.deletedAt} is not null`)
      }

      if (query.type) conditions.push(eq(objects.type, query.type))
      if (query.types) {
        conditions.push(inArray(objects.type, query.types.split(',').filter(Boolean)))
      }
      if (query.spaceId) conditions.push(eq(objects.spaceId, query.spaceId))
      if (query.parentId === 'root') conditions.push(isNull(objects.parentId))
      else if (query.parentId) conditions.push(eq(objects.parentId, query.parentId))
      if (query.q) {
        const escaped = query.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)
        conditions.push(sql`${objects.title} ILIKE ${`%${escaped}%`}`)
      }
      if (filter) conditions.push(await compileObjectFilter(filter, fields, request.ctx))

      const total = query.count
        ? Number(
            (
              await db()
                .select({ count: sql<number>`count(*)::int` })
                .from(objects)
                .where(and(...conditions))
            )[0]?.count ?? 0,
          )
        : undefined

      let rows: Array<{ id: string }>
      let nextCursor: string | null = null

      if (sort.length === 0) {
        // По умолчанию — свежие сверху, курсор по ключу (updated_at, id)
        const cursor = decodeCursor<{ updatedAt: string; id: string }>(query.cursor)
        const keyset = cursor
          ? [sql`(${objects.updatedAt}, ${objects.id}) < (${cursor.updatedAt}, ${cursor.id})`]
          : []
        rows = await db()
          .select({ id: objects.id, updatedAt: objects.updatedAt })
          .from(objects)
          .where(and(...conditions, ...keyset))
          .orderBy(desc(objects.updatedAt), desc(objects.id))
          .limit(query.limit + 1)
        const last = rows[query.limit - 1] as { id: string; updatedAt: string } | undefined
        if (rows.length > query.limit && last) {
          nextCursor = encodeCursor({ updatedAt: last.updatedAt, id: last.id })
        }
      } else {
        // Произвольная сортировка — курсор-смещение (списки объектов умеренного размера)
        const offset = decodeCursor<{ offset: number }>(query.cursor)?.offset ?? 0
        rows = await db()
          .select({ id: objects.id })
          .from(objects)
          .where(and(...conditions))
          .orderBy(...compileObjectSort(sort, fields, sql`${objects.id}`))
          .limit(query.limit + 1)
          .offset(offset)
        if (rows.length > query.limit) nextCursor = encodeCursor({ offset: offset + query.limit })
      }

      const page = rows.slice(0, query.limit)
      const summaries = await ObjectService.summaries(page.map((r) => r.id))
      const items = page.map((r) => summaries.get(r.id)).filter(Boolean)
      return { items, nextCursor, ...(total !== undefined ? { total } : {}) }
    },
  })

  // ─── Избранное, недавние, подписки ────────────────────────────────────────
  route({
    method: 'GET',
    url: '/me/favorites',
    auth: 'session',
    tags: ['objects'],
    summary: 'Избранные объекты',
    schema: { response: { 200: z.object({ items: z.array(ObjectSummary) }) } },
    handler: async (request) => {
      const rows = await db()
        .select({ objectId: favorites.objectId })
        .from(favorites)
        .where(eq(favorites.userId, request.ctx.userId))
        .orderBy(favorites.sort)
      const summaries = await ObjectService.summaries(rows.map((r) => r.objectId))
      return { items: [...summaries.values()] }
    },
  })

  route({
    method: 'PUT',
    url: '/objects/:id/favorite',
    auth: { action: 'view' },
    tags: ['objects'],
    summary: 'Добавить в избранное',
    schema: { params: IdParam, response: { 200: z.object({ favorite: z.boolean() }) } },
    handler: async (request) => {
      await db()
        .insert(favorites)
        .values({ userId: request.ctx.userId, objectId: request.params.id })
        .onConflictDoNothing()
      return { favorite: true }
    },
  })

  route({
    method: 'DELETE',
    url: '/objects/:id/favorite',
    auth: { action: 'view' },
    tags: ['objects'],
    summary: 'Убрать из избранного',
    schema: { params: IdParam, response: { 200: z.object({ favorite: z.boolean() }) } },
    handler: async (request) => {
      await db()
        .delete(favorites)
        .where(
          and(eq(favorites.userId, request.ctx.userId), eq(favorites.objectId, request.params.id)),
        )
      return { favorite: false }
    },
  })

  route({
    method: 'GET',
    url: '/me/recent',
    auth: 'session',
    tags: ['objects'],
    summary: 'Недавно открытые объекты',
    schema: {
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }),
      response: { 200: z.object({ items: z.array(ObjectSummary) }) },
    },
    handler: async (request) => {
      const rows = await db()
        .select({ objectId: recentViews.objectId })
        .from(recentViews)
        .innerJoin(objects, eq(objects.id, recentViews.objectId))
        .where(and(eq(recentViews.userId, request.ctx.userId), isNull(objects.deletedAt)))
        .orderBy(desc(recentViews.viewedAt))
        .limit(request.query.limit)
      const summaries = await ObjectService.summaries(rows.map((r) => r.objectId))
      return { items: rows.map((r) => summaries.get(r.objectId)).filter(Boolean) }
    },
  })

  route({
    method: 'PUT',
    url: '/objects/:id/subscription',
    auth: { action: 'view' },
    tags: ['objects'],
    summary: 'Подписаться на изменения объекта',
    schema: {
      params: IdParam,
      body: z.object({ subscribed: z.boolean() }),
      response: { 200: z.object({ subscribed: z.boolean() }) },
    },
    handler: async (request) => {
      if (request.body.subscribed) {
        await db()
          .insert(subscriptions)
          .values({ userId: request.ctx.userId, objectId: request.params.id })
          .onConflictDoNothing()
      } else {
        await db()
          .delete(subscriptions)
          .where(
            and(
              eq(subscriptions.userId, request.ctx.userId),
              eq(subscriptions.objectId, request.params.id),
            ),
          )
      }
      return { subscribed: request.body.subscribed }
    },
  })

  // ─── Связи и активность ────────────────────────────────────────────────────
  route({
    method: 'GET',
    url: '/objects/:id/links',
    auth: { action: 'view' },
    tags: ['objects'],
    summary: 'Связи объекта',
    schema: { params: IdParam },
    handler: async (request) => {
      const [links, uses, usedBy] = await Promise.all([
        LinkService.listFor(request.ctx, request.params.id),
        LinkService.dependenciesOf(request.ctx, request.params.id),
        LinkService.dependents(request.ctx, request.params.id),
      ])
      return { links, uses, usedBy }
    },
  })

  route({
    method: 'POST',
    url: '/objects/:id/links',
    auth: { action: 'edit' },
    tags: ['objects'],
    summary: 'Создать связь',
    schema: {
      params: IdParam,
      body: LinkCreateInput,
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await authorize(request.ctx, 'view', request.body.targetId)
      await db().transaction((tx) =>
        LinkService.link(
          tx,
          request.ctx,
          request.params.id,
          request.body.targetId,
          request.body.kind,
          request.body.meta,
        ),
      )
      return { ok: true }
    },
  })

  route({
    method: 'DELETE',
    url: '/objects/:id/links/:targetId/:kind',
    auth: { action: 'edit' },
    tags: ['objects'],
    summary: 'Удалить связь',
    schema: {
      params: z.object({ id: z.uuid(), targetId: z.uuid(), kind: z.string() }),
      response: { 200: z.object({ ok: z.boolean() }) },
    },
    handler: async (request) => {
      await db().transaction((tx) =>
        LinkService.unlink(
          tx,
          request.ctx,
          request.params.id,
          request.params.targetId,
          request.params.kind as never,
        ),
      )
      return { ok: true }
    },
  })

  route({
    method: 'GET',
    url: '/objects/:id/activity',
    auth: { action: 'view' },
    tags: ['objects'],
    summary: 'Лента активности объекта',
    schema: {
      params: IdParam,
      querystring: z.object({
        limit: z.coerce.number().int().min(1).max(100).default(30),
        cursor: z.string().optional(),
      }),
    },
    handler: async (request) =>
      listActivity(request.params.id, {
        limit: request.query.limit,
        cursor: request.query.cursor,
      }),
  })

  // ─── Корзина ───────────────────────────────────────────────────────────────
  route({
    method: 'GET',
    url: '/trash',
    auth: 'session',
    tags: ['objects'],
    summary: 'Корзина пользователя',
    schema: { response: { 200: z.object({ items: z.array(ObjectSummary) }) } },
    handler: async (request) => {
      const rows = await db()
        .select({ id: objects.id })
        .from(objects)
        .where(and(visibleObjectsSql(request.ctx), sql`${objects.deletedAt} is not null`))
        .orderBy(desc(objects.deletedAt))
        .limit(200)
      const summaries = await ObjectService.summaries(rows.map((r) => r.id))
      return { items: [...summaries.values()] }
    },
  })
}

/** Обслуживание: обрезка списка недавних до 200 записей на пользователя. */
export async function trimRecentViews(userId: string): Promise<void> {
  await db().execute(sql`
    DELETE FROM ${recentViews}
     WHERE user_id = ${userId}
       AND object_id NOT IN (
         SELECT object_id FROM ${recentViews}
          WHERE user_id = ${userId}
          ORDER BY viewed_at DESC
          LIMIT ${RECENT_LIMIT})`)
}

function requestedTypes(query: { type?: string; types?: string }): string[] {
  if (query.type) return [query.type]
  return (query.types ?? '').split(',').filter(Boolean)
}
