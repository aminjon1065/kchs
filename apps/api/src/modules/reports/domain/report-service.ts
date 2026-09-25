import { isDeepStrictEqual } from 'node:util'
import {
  DEFAULT_REPORT_SETTINGS,
  notebookCellsToBlocks,
  type ReportBlock,
  type ReportCreateInput,
  type ReportFromNotebookInput,
  ReportParams,
  type ReportRecord,
  ReportSettings,
  reportBlockReferences,
  richBodyText,
} from '@kchs/contracts'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { authorize } from '~/kernel/access/authorize.js'
import { CollabStore } from '~/kernel/collab/store.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import type { SearchContent } from '~/kernel/objects/registry.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { objects, reports } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { notebookRecord } from '../../data/public.js'
import { type ReportBody, readReport, reportState } from './report-doc.js'

/** Текста отчёта в поисковом индексе — не больше (как у тетради). */
const SEARCH_BODY_LIMIT = 20_000

/** Зависимости — только на существующие объекты: блоки пишут клиенты. */
async function existing(tx: Executor, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await tx
    .select({ id: objects.id })
    .from(objects)
    .where(and(inArray(objects.id, ids), isNull(objects.deletedAt)))
  return rows.map((row) => row.id)
}

/** Блоки из API ссылаются только на то, что автор видит (как ячейки тетради). */
async function assertReferences(ctx: Ctx, blocks: ReportBlock[]): Promise<void> {
  for (const id of reportBlockReferences(blocks)) await authorize(ctx, 'view', id)
}

/** Документ из JSON: состояние Yjs и снимок, прочитанный из него же. */
function build(body: ReportBody): { state: Uint8Array; body: ReportBody } {
  const state = reportState(body)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const normalized = readReport(doc)
  doc.destroy()
  return { state, body: normalized }
}

function searchText(blocks: ReportBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.title) parts.push(block.title)
    if (block.kind === 'text') parts.push(richBodyText(block.body))
  }
  return parts.filter(Boolean).join('\n').slice(0, SEARCH_BODY_LIMIT)
}

function paramsOf(value: unknown): ReportParams {
  const parsed = ReportParams.safeParse(value)
  return parsed.success ? parsed.data : { period: null, territory: null }
}

function settingsOf(value: unknown): ReportSettings {
  const parsed = ReportSettings.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_REPORT_SETTINGS
}

/**
 * Отчёты (06-analytics-engine.md §12, ADR-0078): объект реестра, шаблон —
 * совместный документ Yjs; таблица `reports` хранит его JSON-снимок, который
 * пишет сервер совместного редактирования после правок.
 */
export const ReportService = {
  async create(tx: Executor, ctx: Ctx, input: ReportCreateInput): Promise<string> {
    await assertReferences(ctx, input.blocks)
    const { state, body } = build({
      blocks: input.blocks,
      params: input.params,
      settings: input.settings,
    })
    const object = await ObjectService.create(tx, ctx, {
      type: 'report',
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      title: input.name,
      meta: { blocks: body.blocks.length },
    })
    await tx.insert(reports).values({
      id: object.id,
      blocks: body.blocks,
      params: body.params as unknown as Record<string, unknown>,
      settings: body.settings as unknown as Record<string, unknown>,
    })
    await CollabStore.create(tx, object.id, state)
    await LinkService.setDependencies(
      tx,
      object.id,
      await existing(tx, reportBlockReferences(body.blocks)),
    )
    return object.id
  },

  /**
   * «Экспорт в отчёт» из тетради (P2-E05 S03): ячейки снимка → блоки, параметры
   * тетради → параметры отчёта; отчёт — рядом с тетрадью, связь «Источник».
   */
  async fromNotebook(ctx: UserCtx, input: ReportFromNotebookInput): Promise<string> {
    await authorize(ctx, 'view', input.notebookId)
    const notebook = await notebookRecord(input.notebookId)
    const spaceId = input.spaceId ?? notebook.spaceId
    const parentId = input.parentId !== undefined ? input.parentId : notebook.parentId
    await authorize(ctx, 'create_child', parentId ?? spaceId)
    const blocks = notebookCellsToBlocks(notebook.cells)
    // Ссылки на невидимые автору объекты не переносятся: блок остаётся пустым
    const visible = new Set<string>()
    for (const id of reportBlockReferences(blocks)) {
      const decision = await authorize(ctx, 'view', id, { soft: true })
      if (decision.allowed) visible.add(id)
    }
    const cleaned = blocks.map((block) => withVisibleReferences(block, visible))
    return db().transaction(async (tx) => {
      const id = await ReportService.create(tx, ctx, {
        name: input.name ?? notebook.name,
        spaceId,
        parentId,
        blocks: cleaned,
        params: notebook.params,
        settings: DEFAULT_REPORT_SETTINGS,
      })
      await LinkService.link(tx, ctx, id, input.notebookId, 'source')
      return id
    })
  },

  async get(id: string, executor: Executor = db()): Promise<ReportRecord> {
    const [row] = await executor
      .select({ report: reports, object: objects })
      .from(reports)
      .innerJoin(objects, eq(objects.id, reports.id))
      .where(eq(reports.id, id))
      .limit(1)
    if (!row?.object.spaceId) throw errors.notFound('Отчёт')
    const schedule = row.report.schedule as { enabled?: unknown } | null
    return {
      id,
      name: row.object.title,
      spaceId: row.object.spaceId,
      parentId: row.object.parentId,
      blocks: row.report.blocks as ReportBlock[],
      params: paramsOf(row.report.params),
      settings: settingsOf(row.report.settings),
      scheduled: schedule?.enabled === true,
      template: (row.object.meta as { template?: unknown } | null)?.template === true,
      version: row.object.version,
      updatedAt: row.object.updatedAt,
    }
  },

  /** Начальное состояние для отчёта без документа Yjs. */
  async initialState(id: string, executor: Executor): Promise<Uint8Array | null> {
    const [row] = await executor
      .select({ blocks: reports.blocks, params: reports.params, settings: reports.settings })
      .from(reports)
      .where(eq(reports.id, id))
      .limit(1)
    if (!row) return null
    return reportState({
      blocks: row.blocks as ReportBlock[],
      params: paramsOf(row.params),
      settings: settingsOf(row.settings),
    })
  },

  /**
   * Снимок после совместной правки (ядро вызывает в транзакции записи
   * состояния): JSON шаблона, зависимости, версия объекта и `report.updated`.
   */
  async snapshot(tx: Executor, ctx: Ctx, id: string, doc: Y.Doc): Promise<void> {
    const next = readReport(doc)
    const [row] = await tx
      .select({ blocks: reports.blocks, params: reports.params, settings: reports.settings })
      .from(reports)
      .where(eq(reports.id, id))
      .limit(1)
    if (!row) return
    const changed: Array<'blocks' | 'params' | 'settings'> = []
    if (!isDeepStrictEqual(row.blocks, next.blocks)) changed.push('blocks')
    if (!isDeepStrictEqual(row.params, next.params)) changed.push('params')
    if (!isDeepStrictEqual(row.settings, next.settings)) changed.push('settings')
    if (changed.length === 0) return

    await tx
      .update(reports)
      .set({
        blocks: next.blocks,
        params: next.params as unknown as Record<string, unknown>,
        settings: next.settings as unknown as Record<string, unknown>,
        updatedAt: sql`now()`,
      })
      .where(eq(reports.id, id))
    if (changed.includes('blocks')) {
      await LinkService.setDependencies(
        tx,
        id,
        await existing(tx, reportBlockReferences(next.blocks)),
      )
    }
    const object = await ObjectService.update(
      tx,
      ctx,
      id,
      { meta: { blocks: next.blocks.length }, mergeMeta: true },
      { silent: true },
    )
    await publishEvent(tx, ctx, {
      type: 'report.updated',
      object: { id, type: 'report', spaceId: object.spaceId, title: object.title },
      payload: { changed },
    })
  },

  /** Документ поиска: название, текст и подписи блоков (данные в индекс не попадают). */
  async searchable(id: string): Promise<SearchContent | null> {
    const [row] = await db()
      .select({ report: reports, object: objects })
      .from(reports)
      .innerJoin(objects, eq(objects.id, reports.id))
      .where(eq(reports.id, id))
      .limit(1)
    if (!row) return null
    return {
      parentId: row.object.parentId,
      type: 'report',
      spaceId: row.object.spaceId,
      title: row.object.title,
      body: searchText(row.report.blocks as ReportBlock[]),
      ownerId: row.object.ownerId,
      updatedAt: Math.floor(new Date(row.object.updatedAt).getTime() / 1000),
      meta: {},
    }
  },
}

/** Ссылки блока на объекты, которых автор не видит, — сброшены. */
function withVisibleReferences(block: ReportBlock, visible: ReadonlySet<string>): ReportBlock {
  const keep = (id: string | null) => (id && visible.has(id) ? id : null)
  switch (block.kind) {
    case 'query':
      return { ...block, datasetId: keep(block.datasetId) }
    case 'chart':
      return { ...block, chartId: keep(block.chartId) }
    case 'metrics':
      return { ...block, metricIds: block.metricIds.filter((id) => visible.has(id)) }
    case 'map':
      return { ...block, mapId: keep(block.mapId), layerId: keep(block.layerId) }
    default:
      return block
  }
}
