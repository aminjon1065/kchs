import {
  PAGE_DOC,
  type PageBlock,
  type PageVersionCompareQuery,
  type PageVersionCompareResult,
  type PageVersionDetail,
  type PageVersionReason,
  type PageVersionRecord,
} from '@kchs/contracts'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { CollabService } from '~/kernel/collab/server.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { pages, pageVersions } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { newId } from '~/shared/ids.js'
import { diffText } from '~/shared/text-diff.js'
import { loadPage, type PageRow, pageText } from './page-core.js'
import { insertPageBlocks } from './page-doc.js'

/** Текста версии в сравнении — не больше: дальше показывается «сравнено начало». */
const COMPARE_LIMIT = 200_000

type VersionRow = typeof pageVersions.$inferSelect

async function toRecords(rows: VersionRow[]): Promise<PageVersionRecord[]> {
  const people = await directory().refs([
    ...new Set(rows.map((row) => row.createdBy).filter((id): id is string => Boolean(id))),
  ])
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    reason: row.reason as PageVersionReason,
    note: row.note,
    createdBy: row.createdBy ? (people.get(row.createdBy) ?? null) : null,
    createdAt: row.createdAt,
  }))
}

async function loadVersion(pageId: string, versionId: string): Promise<VersionRow> {
  const [row] = await db()
    .select()
    .from(pageVersions)
    .where(and(eq(pageVersions.id, versionId), eq(pageVersions.pageId, pageId)))
    .limit(1)
  if (!row) throw errors.notFound('Версия страницы')
  return row
}

/**
 * Версии страницы (13-search-knowledge-ai.md §2, ADR-0095): снимок блоков при
 * публикации, по кнопке «Сохранить версию» и перед откатом. Сравнение — по
 * тексту версий (общий алгоритм по словам, `shared/text-diff.ts`), откат
 * возвращает блоки версии в совместный документ.
 */
export const PageVersions = {
  /**
   * Снимок текущего состояния страницы версией — в транзакции вызывающего
   * (публикация, кнопка, откат). Номер растёт на единицу.
   */
  async snapshot(
    tx: Executor,
    ctx: Ctx,
    row: PageRow,
    input: { reason: PageVersionReason; note: string | null },
  ): Promise<{ id: string; number: number }> {
    const id = newId()
    const number = row.versionNumber + 1
    await tx.insert(pageVersions).values({
      id,
      pageId: row.id,
      number,
      title: row.title,
      blocks: row.blocks,
      reason: input.reason,
      note: input.note,
      createdBy: ctx.kind === 'user' ? (ctx.onBehalfOf ?? ctx.userId) : null,
    })
    await tx
      .update(pages)
      .set({ versionNumber: number, updatedAt: sql`now()` })
      .where(eq(pages.id, row.id))
    await publishEvent(tx, ctx, {
      type: 'page.version_created',
      object: { id: row.id, type: 'page', spaceId: row.spaceId, title: row.title },
      payload: { versionId: id, number, reason: input.reason },
    })
    return { id, number }
  },

  async list(ctx: UserCtx, pageId: string): Promise<PageVersionRecord[]> {
    await authorize(ctx, 'view', pageId)
    const rows = await db()
      .select()
      .from(pageVersions)
      .where(eq(pageVersions.pageId, pageId))
      .orderBy(desc(pageVersions.number))
    return toRecords(rows)
  },

  async get(ctx: UserCtx, pageId: string, versionId: string): Promise<PageVersionDetail> {
    await authorize(ctx, 'view', pageId)
    const row = await loadVersion(pageId, versionId)
    const [record] = await toRecords([row])
    if (!record) throw errors.notFound('Версия страницы')
    return { ...record, blocks: row.blocks as PageBlock[] }
  },

  /** Снимок по кнопке: сначала записывается открытый документ, затем версия. */
  async create(
    ctx: UserCtx,
    pageId: string,
    input: { note: string | null },
  ): Promise<PageVersionRecord> {
    await authorize(ctx, 'edit', pageId)
    await CollabService.change(ctx, { id: pageId, type: 'page' }, () => {})
    const created = await db().transaction(async (tx) => {
      const row = await loadPage(tx, pageId)
      if (!row) throw errors.notFound('Страница')
      return PageVersions.snapshot(tx, ctx, row, { reason: 'manual', note: input.note })
    })
    const [record] = await toRecords([await loadVersion(pageId, created.id)])
    if (!record) throw errors.internal('Версия не записана')
    return record
  },

  /**
   * Откат к версии: текущее состояние сохраняется версией (`restore`), затем
   * блоки версии заменяют содержимое совместного документа — у всех, кто держит
   * страницу открытой, текст меняется сразу.
   */
  async restore(ctx: UserCtx, pageId: string, versionId: string): Promise<PageVersionRecord> {
    await authorize(ctx, 'manage', pageId)
    const version = await loadVersion(pageId, versionId)
    // Текущий текст — в версию, чтобы откат можно было откатить
    await CollabService.change(ctx, { id: pageId, type: 'page' }, () => {})
    await db().transaction(async (tx) => {
      const row = await loadPage(tx, pageId)
      if (!row) throw errors.notFound('Страница')
      await PageVersions.snapshot(tx, ctx, row, { reason: 'restore', note: null })
      await publishEvent(tx, ctx, {
        type: 'page.restored',
        object: { id: pageId, type: 'page', spaceId: row.spaceId, title: row.title },
        payload: { versionId: version.id, number: version.number },
      })
    })
    const blocks = version.blocks as PageBlock[]
    await CollabService.change(ctx, { id: pageId, type: 'page' }, (doc) => {
      const map = doc.getMap(PAGE_DOC.blocks)
      const order = doc.getArray(PAGE_DOC.order)
      order.delete(0, order.length)
      for (const key of [...map.keys()]) map.delete(key)
      insertPageBlocks(doc, blocks)
    })
    const [record] = await toRecords([version])
    if (!record) throw errors.internal('Версия не прочитана')
    return record
  },

  /**
   * Сравнение версий по словам: `to` не задан — текущий текст страницы,
   * `from` не задан — версия перед `to` (пустая сторона, если её нет).
   */
  async compare(
    ctx: UserCtx,
    pageId: string,
    query: PageVersionCompareQuery,
  ): Promise<PageVersionCompareResult> {
    await authorize(ctx, 'view', pageId)
    const page = await loadPage(db(), pageId)
    if (!page) throw errors.notFound('Страница')

    const to = query.to ? await loadVersion(pageId, query.to) : null
    const from = query.from
      ? await loadVersion(pageId, query.from)
      : await previousVersion(pageId, to?.number ?? page.versionNumber + 1)

    const side = (row: VersionRow | null, fallback: { title: string }) =>
      row
        ? { id: row.id, number: row.number, title: row.title, createdAt: row.createdAt }
        : { id: null, number: 0, title: fallback.title, createdAt: null }

    const fromText = from ? pageText(from.blocks as PageBlock[]) : ''
    const toText = to ? pageText(to.blocks as PageBlock[]) : pageText(page.blocks)
    const truncated = fromText.length > COMPARE_LIMIT || toText.length > COMPARE_LIMIT
    const diff = diffText(fromText.slice(0, COMPARE_LIMIT), toText.slice(0, COMPARE_LIMIT))
    return {
      from: side(from, { title: page.title }),
      to: side(to, { title: page.title }),
      segments: diff.segments,
      stats: diff.stats,
      truncated,
    }
  },
}

/** Версия перед номером `number`; её нет — сравнение идёт с пустой страницей. */
async function previousVersion(pageId: string, number: number): Promise<VersionRow | null> {
  const [row] = await db()
    .select()
    .from(pageVersions)
    .where(and(eq(pageVersions.pageId, pageId), lt(pageVersions.number, number)))
    .orderBy(desc(pageVersions.number))
    .limit(1)
  return row ?? null
}
