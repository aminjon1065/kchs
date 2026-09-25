import { isDeepStrictEqual } from 'node:util'
import {
  PAGE_DOC,
  PAGE_MAX_BLOCKS,
  type PageAcknowledgeInput,
  type PageBlock,
  type PageBlocksInput,
  type PageCreateInput,
  type PageRecord,
  type PageStatus,
  type PageTemplate,
  type PageTreeNode,
  type PageTreeQuery,
  type PageUpdateInput,
} from '@kchs/contracts'
import type { Locale } from '@kchs/i18n'
import { and, asc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm'
import type * as Y from 'yjs'
import { authorize, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { Acknowledgments } from '~/kernel/acknowledgments/index.js'
import { CollabService } from '~/kernel/collab/server.js'
import { CollabStore } from '~/kernel/collab/store.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { LinkService } from '~/kernel/links/service.js'
import type { SearchContent } from '~/kernel/objects/registry.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { config } from '~/shared/config/index.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, pages } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { loadPage, type PageRow, pageDependencies, pageOutline, pageText } from './page-core.js'
import { buildPageDoc, insertPageBlocks, pageState, readPage } from './page-doc.js'
import { defaultReviewAt, localDay, REVIEW_INBOX_KIND, reviewStale } from './page-review.js'
import { templateBlocks } from './page-templates.js'
import { PageVersions } from './page-version-service.js'

/** Текста страницы в поисковом индексе объектов — не больше (как у тетради). */
const SEARCH_BODY_LIMIT = 20_000

/** Страниц в дереве за один ответ — не больше: дерево пространства не бесконечно. */
const TREE_LIMIT = 1000

/**
 * Зависимости — только на существующие объекты: идентификаторы в документе
 * пишут клиенты, и несуществующий сорвал бы запись снимка.
 */
async function existing(tx: Executor, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await tx
    .select({ id: objects.id })
    .from(objects)
    .where(and(inArray(objects.id, ids), isNull(objects.deletedAt)))
  return rows.map((row) => row.id)
}

/** Блоки из API ссылаются только на то, что автор видит (как плитки дашборда). */
async function assertReferences(ctx: Ctx, blocks: readonly PageBlock[]): Promise<void> {
  for (const id of pageDependencies(blocks)) await authorize(ctx, 'view', id)
}

async function toRecord(ctx: UserCtx, row: PageRow): Promise<PageRecord> {
  const [edit, manage, ack] = await Promise.all([
    authorize(ctx, 'edit', row.id, { soft: true }),
    authorize(ctx, 'manage', row.id, { soft: true }),
    authorize(ctx, 'request_acknowledgment', row.id, { soft: true }),
  ])
  const people = await directory().refs(
    [row.ownerId, row.publishedBy].filter((id): id is string => Boolean(id)),
  )
  return {
    id: row.id,
    title: row.title,
    spaceId: row.spaceId as string,
    parentId: row.parentId,
    status: row.status,
    template: row.template as PageTemplate,
    blocks: row.blocks,
    outline: pageOutline(row.blocks),
    owner: row.ownerId ? (people.get(row.ownerId) ?? null) : null,
    reviewAt: row.reviewAt,
    reviewStale: reviewStale(row.reviewAt, localDay(new Date(), config().TZ)),
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy ? (people.get(row.publishedBy) ?? null) : null,
    versionNumber: row.versionNumber,
    acknowledgmentRequested: row.acknowledgmentAt !== null,
    can: {
      edit: edit.allowed,
      publish: manage.allowed,
      manage: manage.allowed,
      requestAcknowledgment: ack.allowed && row.status === 'published',
    },
    version: row.version,
    updatedAt: row.updatedAt,
  }
}

/** Конец дня срока — момент, до которого ознакомление считается вовремя. */
const endOfDay = (date: string | null): string | null => (date ? `${date}T23:59:59.000Z` : null)

/**
 * Страницы базы знаний (13-search-knowledge-ai.md §2, ADR-0095): объект реестра
 * `page` в дереве пространства, тело — совместный документ Yjs; таблица `pages`
 * хранит его JSON-снимок, который пишет сервер совместного редактирования.
 */
export const PageService = {
  load: loadPage,

  /**
   * Новая страница: блоки шаблона (или переданные) сразу попадают в документ
   * Yjs — первое открытие не строит его из JSON. Права наследуются от родителя
   * (страница или раздел) или от пространства.
   */
  async create(tx: Executor, ctx: Ctx, input: PageCreateInput, locale: Locale): Promise<string> {
    const source = input.blocks ?? templateBlocks(input.template, locale)
    await assertReferences(ctx, source)
    const { state, blocks } = buildPageDoc(source)
    const object = await ObjectService.create(tx, ctx, {
      type: 'page',
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      title: input.title,
      meta: { status: 'draft' },
    })
    await tx.insert(pages).values({
      id: object.id,
      status: 'draft',
      template: input.template,
      blocks,
      ownerId: ctx.kind === 'user' ? (ctx.onBehalfOf ?? ctx.userId) : object.ownerId,
    })
    await CollabStore.create(tx, object.id, state)
    await LinkService.setDependencies(tx, object.id, await existing(tx, pageDependencies(blocks)))
    return object.id
  },

  async get(ctx: UserCtx, id: string): Promise<PageRecord> {
    await authorize(ctx, 'view', id)
    const row = await loadPage(db(), id)
    if (!row) throw errors.notFound('Страница')
    return toRecord(ctx, row)
  },

  /**
   * Блоки от сервера (шаблон, вставка объекта из другого экрана) — через
   * совместный документ: у открывших страницу они появляются сразу, снимок
   * записан к возврату (как ячейки тетради, ADR-0070 §7).
   */
  async addBlocks(ctx: UserCtx, id: string, input: PageBlocksInput): Promise<PageRecord> {
    await authorize(ctx, 'edit', id)
    await assertReferences(ctx, input.blocks)
    await CollabService.change(ctx, { id, type: 'page' }, (doc) => {
      const count = doc.getArray(PAGE_DOC.order).length
      if (count + input.blocks.length > PAGE_MAX_BLOCKS) {
        throw errors.conflict(`На странице не больше ${PAGE_MAX_BLOCKS} блоков`)
      }
      insertPageBlocks(doc, input.blocks, input.index)
    })
    return PageService.get(ctx, id)
  },

  /**
   * Владелец, срок пересмотра и возврат в работу. Опубликованную страницу
   * возвращают в `draft` или отправляют на пересмотр вручную — публикация
   * делается отдельным действием (она снимает версию).
   */
  async update(ctx: UserCtx, id: string, input: PageUpdateInput): Promise<PageRecord> {
    await authorize(ctx, 'manage', id)
    if (input.ownerId) {
      const [active] = await directory().activeUsers([input.ownerId])
      if (!active) throw errors.validation('Владелец страницы не найден')
    }
    await db().transaction(async (tx) => {
      const row = await loadPage(tx, id)
      if (!row) throw errors.notFound('Страница')
      const next: Record<string, unknown> = { updatedAt: sql`now()` }
      if (input.ownerId !== undefined) next.ownerId = input.ownerId
      if (input.reviewAt !== undefined) {
        next.reviewAt = input.reviewAt
        // Новый срок — новое дело о пересмотре, когда он подойдёт
        next.reviewOpenedFor = null
      }
      const status = input.status && input.status !== row.status ? input.status : null
      if (status) next.status = status
      await tx.update(pages).set(next).where(eq(pages.id, id))
      if (status) {
        await ObjectService.update(tx, ctx, id, { meta: { status }, mergeMeta: true })
        await publishEvent(tx, ctx, {
          type: 'page.status_changed',
          object: { id, type: 'page', spaceId: row.spaceId, title: row.title },
          payload: { from: row.status, to: status, cause: 'manual' },
        })
      } else {
        await ObjectService.update(tx, ctx, id, {})
      }
    })
    return PageService.get(ctx, id)
  },

  /**
   * Публикация: снимок открытого документа становится версией, страница —
   * опубликованной, срок пересмотра назначается заново. Публикует владелец
   * страницы или тот, кто ею распоряжается (`manage`).
   */
  async publish(
    ctx: UserCtx,
    id: string,
    input: { note: string | null; reviewAt?: string | null },
  ): Promise<PageRecord> {
    await authorize(ctx, 'manage', id)
    // Снимок открытого документа: публикуется то, что видит человек
    await CollabService.change(ctx, { id, type: 'page' }, () => {})
    await db().transaction(async (tx) => {
      const row = await loadPage(tx, id)
      if (!row) throw errors.notFound('Страница')
      const version = await PageVersions.snapshot(tx, ctx, row, {
        reason: 'publish',
        note: input.note,
      })
      const requested = input.reviewAt === undefined ? row.reviewAt : input.reviewAt
      // Регламенту и инструкции срок ставится сам — год от публикации (N35)
      const reviewAt =
        input.reviewAt ??
        defaultReviewAt(row.template as PageTemplate, localDay(new Date(), config().TZ)) ??
        requested
      await tx
        .update(pages)
        .set({
          status: 'published',
          publishedAt: sql`now()`,
          publishedBy: ctx.onBehalfOf ?? ctx.userId,
          reviewAt,
          reviewOpenedFor: null,
          updatedAt: sql`now()`,
        })
        .where(eq(pages.id, id))
      await ObjectService.update(tx, ctx, id, { meta: { status: 'published' }, mergeMeta: true })
      // Дело «Пересмотреть страницу» закрывается публикацией — действие сделано
      await InboxService.resolve(tx, ctx, { objectId: id, kind: REVIEW_INBOX_KIND })
      await publishEvent(tx, ctx, {
        type: 'page.published',
        object: { id, type: 'page', spaceId: row.spaceId, title: row.title },
        payload: { versionId: version.id, number: version.number, reviewAt },
      })
      if (row.status !== 'published') {
        await publishEvent(tx, ctx, {
          type: 'page.status_changed',
          object: { id, type: 'page', spaceId: row.spaceId, title: row.title },
          payload: { from: row.status, to: 'published', cause: 'publish' },
        })
      }
    })
    return PageService.get(ctx, id)
  },

  /**
   * Дерево страниц пространства: только то, что смотрящий видит (предикат
   * видимости ядра). С `q` — плоский список найденного по названию.
   */
  async tree(ctx: UserCtx, query: PageTreeQuery): Promise<PageTreeNode[]> {
    await authorize(ctx, 'view', query.spaceId)
    const conditions = [
      eq(objects.spaceId, query.spaceId),
      isNull(objects.deletedAt),
      isNull(objects.archivedAt),
      visibleObjectsSql(ctx, 'page'),
    ]
    if (query.q) conditions.push(ilike(objects.title, `%${query.q}%`))
    const rows = await db()
      .select({
        id: objects.id,
        title: objects.title,
        parentId: objects.parentId,
        status: pages.status,
        updatedAt: objects.updatedAt,
      })
      .from(pages)
      .innerJoin(objects, eq(objects.id, pages.id))
      .where(and(...conditions))
      .orderBy(asc(objects.title))
      .limit(TREE_LIMIT)
    const ids = new Set(rows.map((row) => row.id))
    const withChildren = new Set(
      rows.map((row) => row.parentId).filter((id): id is string => Boolean(id)),
    )
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      // Родитель вне выдачи (раздел, невидимая страница) — узел показывается в корне
      parentId: row.parentId && ids.has(row.parentId) ? row.parentId : null,
      status: row.status as PageStatus,
      hasChildren: withChildren.has(row.id),
      updatedAt: row.updatedAt,
    }))
  },

  /**
   * Ознакомление со страницей — механизмом ядра (ADR-0084). Права получателей
   * не выдаются: страница базы знаний лежит в пространстве, и знакомят с ней
   * тех, кто её и так видит; кому она не видна, дело не откроется.
   */
  async requestAcknowledgment(
    ctx: UserCtx,
    id: string,
    input: PageAcknowledgeInput,
  ): Promise<{ requested: number; skipped: number }> {
    await authorize(ctx, 'request_acknowledgment', id)
    const row = await loadPage(db(), id)
    if (!row) throw errors.notFound('Страница')
    if (row.status !== 'published') {
      throw errors.conflict('Страница ещё не опубликована', { status: row.status })
    }
    if (input.userIds.length === 0 && input.unitIds.length === 0) {
      throw errors.validation('Укажите, кого знакомить со страницей')
    }
    return db().transaction(async (tx) => {
      const outcome = await Acknowledgments.request(tx, ctx, {
        objectId: id,
        source: 'manual',
        userIds: input.userIds,
        unitIds: input.unitIds,
        dueAt: endOfDay(input.dueAt),
        requireSecondFactor: input.requireSecondFactor,
        note: input.note,
      })
      await tx
        .update(pages)
        .set({ acknowledgmentAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(pages.id, id))
      return { requested: outcome.added.length, skipped: outcome.skipped.length }
    })
  },

  /** Начальное состояние для страницы без документа Yjs (создана раньше). */
  async initialState(id: string, executor: Executor): Promise<Uint8Array | null> {
    const row = await loadPage(executor, id)
    return row ? pageState(row.blocks) : null
  },

  /**
   * Снимок после совместной правки (ядро вызывает в транзакции записи
   * состояния): JSON блоков, зависимости, версия объекта и `page.updated`.
   * Без изменений в JSON (правка вне раскладки) — ничего.
   */
  async snapshot(tx: Executor, ctx: Ctx, id: string, doc: Y.Doc): Promise<void> {
    const next = readPage(doc)
    const row = await loadPage(tx, id)
    if (!row || isDeepStrictEqual(row.blocks, next)) return

    await tx.update(pages).set({ blocks: next, updatedAt: sql`now()` }).where(eq(pages.id, id))
    await LinkService.setDependencies(tx, id, await existing(tx, pageDependencies(next)))
    const object = await ObjectService.update(tx, ctx, id, {}, { silent: true })
    await publishEvent(tx, ctx, {
      type: 'page.updated',
      object: { id, type: 'page', spaceId: object.spaceId, title: object.title },
      payload: { changed: ['blocks'] },
    })
  },

  /** Документ поиска объектов: название и текст блоков (данные блоков — нет). */
  async searchable(id: string): Promise<SearchContent | null> {
    const row = await loadPage(db(), id)
    if (!row) return null
    return {
      parentId: row.parentId,
      type: 'page',
      spaceId: row.spaceId,
      title: row.title,
      body: pageText(row.blocks).slice(0, SEARCH_BODY_LIMIT),
      ownerId: row.registryOwnerId,
      updatedAt: Math.floor(new Date(row.updatedAt).getTime() / 1000),
      meta: { status: row.status },
    }
  },

  /** Сводка для карточек, чипов и пикеров: состояние и срок пересмотра. */
  async summaries(
    ids: string[],
  ): Promise<Map<string, { status: string; reviewAt: string | null }>> {
    const rows = await db()
      .select({ id: pages.id, status: pages.status, reviewAt: pages.reviewAt })
      .from(pages)
      .where(inArray(pages.id, ids))
    return new Map(rows.map((row) => [row.id, { status: row.status, reviewAt: row.reviewAt }]))
  },
}
