import { isDeepStrictEqual } from 'node:util'
import {
  NOTEBOOK_DOC,
  NOTEBOOK_MAX_CELLS,
  type NotebookCell,
  type NotebookCellsInput,
  type NotebookCreateInput,
  NotebookParams,
  type NotebookRecord,
  richBodyText,
} from '@kchs/contracts'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import * as Y from 'yjs'
import { authorize } from '~/kernel/access/authorize.js'
import { CollabService } from '~/kernel/collab/server.js'
import { CollabStore } from '~/kernel/collab/store.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import type { SearchContent } from '~/kernel/objects/registry.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx, UserCtx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { notebooks, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { insertCells, type NotebookBody, notebookState, readNotebook } from './notebook-doc.js'

/** Текста тетради в поисковом индексе — не больше (как у датасета). */
const SEARCH_BODY_LIMIT = 20_000

/** Датасеты, графики, показатели, карты и слои ячеек — зависимости тетради («Используется в»). */
function dependenciesOf(cells: NotebookCell[]): string[] {
  const ids = new Set<string>()
  for (const cell of cells) {
    if ((cell.kind === 'query' || cell.kind === 'ai') && cell.datasetId) ids.add(cell.datasetId)
    if (cell.kind === 'chart' && cell.chartId) ids.add(cell.chartId)
    if (cell.kind === 'metric' && cell.metricId) ids.add(cell.metricId)
    if (cell.kind === 'map' && cell.mapId) ids.add(cell.mapId)
    if (cell.kind === 'map' && cell.layerId) ids.add(cell.layerId)
  }
  return [...ids]
}

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

/** Ячейки из API ссылаются только на то, что автор видит (как плитки дашборда). */
async function assertReferences(ctx: Ctx, cells: NotebookCell[]): Promise<void> {
  for (const id of dependenciesOf(cells)) await authorize(ctx, 'view', id)
}

/** Документ из JSON: состояние Yjs и снимок, прочитанный из него же (без повторов ячеек). */
function build(body: NotebookBody): { state: Uint8Array; body: NotebookBody } {
  const state = notebookState(body)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const normalized = readNotebook(doc)
  doc.destroy()
  return { state, body: normalized }
}

/** Текст тетради для поиска: текстовые ячейки, вопросы и ответы ИИ, подписи ячеек. */
function searchText(cells: NotebookCell[]): string {
  const parts: string[] = []
  for (const cell of cells) {
    if (cell.title) parts.push(cell.title)
    if (cell.kind === 'text') parts.push(richBodyText(cell.body))
    if (cell.kind === 'ai') {
      if (cell.question) parts.push(cell.question)
      if (cell.answer) parts.push(cell.answer.title)
    }
  }
  return parts.filter(Boolean).join('\n').slice(0, SEARCH_BODY_LIMIT)
}

/**
 * Тетради (06-analytics-engine.md §11, ADR-0070/0071): объект реестра, тело —
 * совместный документ Yjs; таблица `notebooks` хранит его JSON-снимок, который
 * пишет сервер совместного редактирования после правок.
 */
export const NotebookService = {
  async create(tx: Executor, ctx: Ctx, input: NotebookCreateInput): Promise<string> {
    await assertReferences(ctx, input.cells)
    const { state, body } = build({ cells: input.cells, params: input.params })
    const object = await ObjectService.create(tx, ctx, {
      type: 'notebook',
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      title: input.name,
      meta: { cells: body.cells.length },
    })
    await tx.insert(notebooks).values({
      id: object.id,
      cells: body.cells,
      params: body.params as unknown as Record<string, unknown>,
    })
    // Состояние Yjs — сразу: первое открытие не строит документ из JSON
    await CollabStore.create(tx, object.id, state)
    await LinkService.setDependencies(tx, object.id, await existing(tx, dependenciesOf(body.cells)))
    return object.id
  },

  async get(id: string, executor: Executor = db()): Promise<NotebookRecord> {
    const [row] = await executor
      .select({ notebook: notebooks, object: objects })
      .from(notebooks)
      .innerJoin(objects, eq(objects.id, notebooks.id))
      .where(eq(notebooks.id, id))
      .limit(1)
    if (!row?.object.spaceId) throw errors.notFound('Тетрадь')
    const params = NotebookParams.safeParse(row.notebook.params)
    return {
      id,
      name: row.object.title,
      spaceId: row.object.spaceId,
      parentId: row.object.parentId,
      cells: row.notebook.cells as NotebookCell[],
      params: params.success ? params.data : { period: null, territory: null },
      version: row.object.version,
      updatedAt: row.object.updatedAt,
    }
  },

  /**
   * Ячейки от сервера (из «Исследования», ИИ) — через совместный документ:
   * у открывших тетрадь они появляются сразу, снимок записан к возврату.
   */
  async addCells(ctx: UserCtx, id: string, input: NotebookCellsInput): Promise<NotebookRecord> {
    await assertReferences(ctx, input.cells)
    await CollabService.change(ctx, { id, type: 'notebook' }, (doc) => {
      const count = doc.getArray(NOTEBOOK_DOC.order).length
      if (count + input.cells.length > NOTEBOOK_MAX_CELLS) {
        throw errors.validation(`В тетради не больше ${NOTEBOOK_MAX_CELLS} ячеек`)
      }
      insertCells(doc, input.cells, input.index)
    })
    return NotebookService.get(id)
  },

  /** Начальное состояние для тетради без документа Yjs (создана до совместной правки). */
  async initialState(id: string, executor: Executor): Promise<Uint8Array | null> {
    const [row] = await executor
      .select({ cells: notebooks.cells, params: notebooks.params })
      .from(notebooks)
      .where(eq(notebooks.id, id))
      .limit(1)
    if (!row) return null
    const params = NotebookParams.safeParse(row.params)
    return notebookState({
      cells: row.cells as NotebookCell[],
      params: params.success ? params.data : { period: null, territory: null },
    })
  },

  /**
   * Снимок после совместной правки (вызывает ядро в транзакции записи
   * состояния): JSON ячеек и параметров, зависимости, версия объекта и
   * `notebook.updated`. Без изменений в JSON (правка вне раскладки) — ничего.
   */
  async snapshot(tx: Executor, ctx: Ctx, id: string, doc: Y.Doc): Promise<void> {
    const next = readNotebook(doc)
    const [row] = await tx
      .select({ cells: notebooks.cells, params: notebooks.params })
      .from(notebooks)
      .where(eq(notebooks.id, id))
      .limit(1)
    if (!row) return
    const changed: Array<'cells' | 'params'> = []
    if (!isDeepStrictEqual(row.cells, next.cells)) changed.push('cells')
    if (!isDeepStrictEqual(row.params, next.params)) changed.push('params')
    if (changed.length === 0) return

    await tx
      .update(notebooks)
      .set({
        cells: next.cells,
        params: next.params as unknown as Record<string, unknown>,
        updatedAt: sql`now()`,
      })
      .where(eq(notebooks.id, id))
    if (changed.includes('cells')) {
      await LinkService.setDependencies(tx, id, await existing(tx, dependenciesOf(next.cells)))
    }
    const object = await ObjectService.update(
      tx,
      ctx,
      id,
      { meta: { cells: next.cells.length }, mergeMeta: true },
      { silent: true },
    )
    await publishEvent(tx, ctx, {
      type: 'notebook.updated',
      object: { id, type: 'notebook', spaceId: object.spaceId, title: object.title },
      payload: { changed },
    })
  },

  /** Документ поиска: название и текст ячеек (данные ячеек в индекс не попадают). */
  async searchable(id: string): Promise<SearchContent | null> {
    const [row] = await db()
      .select({ notebook: notebooks, object: objects })
      .from(notebooks)
      .innerJoin(objects, eq(objects.id, notebooks.id))
      .where(eq(notebooks.id, id))
      .limit(1)
    if (!row) return null
    return {
      parentId: row.object.parentId,
      type: 'notebook',
      spaceId: row.object.spaceId,
      title: row.object.title,
      body: searchText(row.notebook.cells as NotebookCell[]),
      ownerId: row.object.ownerId,
      updatedAt: Math.floor(new Date(row.object.updatedAt).getTime() / 1000),
      meta: {},
    }
  },
}
