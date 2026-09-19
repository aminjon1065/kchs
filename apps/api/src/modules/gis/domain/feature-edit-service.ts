import type {
  DatasetRow,
  FeatureEdit,
  FeatureEditInput,
  FeatureEditOp,
  FeatureEditReview,
  FeatureEditStatus,
  FeatureEditsQuery,
  FeatureGeometry,
  InboxItem,
  LayerEditAccess,
  LayerEditReason,
  LayerFeature,
  LayerFeatureInput,
  LayerFeaturePatch,
} from '@kchs/contracts'
import { and, desc, eq, type SQL, sql } from 'drizzle-orm'
import { authorize, loadObject } from '~/kernel/access/authorize.js'
import { directory } from '~/kernel/directory/port.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { InboxService } from '~/kernel/inbox/service.js'
import { DatasetQueries, DatasetRows, type RowWriteAccess } from '~/modules/data/public.js'
import { actorId, type Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { featureEdits } from '~/shared/db/schema/index.js'
import { AppError, errors, isAppError } from '~/shared/errors.js'
import { normalizeGeometry } from './feature-geometry.js'
import { LayerService, type StoredLayer } from './layer-service.js'

type EditRow = typeof featureEdits.$inferSelect

/** Права пользователя на правку объектов слоя и доступ к строкам датасета. */
interface EditAccess extends Omit<LayerEditAccess, 'pending'> {
  rows: RowWriteAccess
}

/** Дело во Входящих владельца слоя — по одному на правку (ключ и копии заместителей). */
const inboxKey = (editId: number | string) => `feature-edit:${editId}`

/** Кнопки дела «Проверить правку»: принять или отклонить с комментарием. */
const REVIEW_ACTIONS: InboxItem['actions'] = [
  { key: 'approve', labelKey: 'inbox.actions.accept', variant: 'primary', requiresComment: false },
  { key: 'reject', labelKey: 'inbox.actions.reject', variant: 'danger', requiresComment: true },
]

const INBOX_TITLES: Record<FeatureEditOp, string> = {
  create: 'inbox.tpl.reviewFeatureCreate',
  update: 'inbox.tpl.reviewFeatureUpdate',
  delete: 'inbox.tpl.reviewFeatureDelete',
}

/** Отказ в правке — понятной причиной; без доступа к данным объект слоя не раскрывается. */
function denied(reason: LayerEditReason | null): AppError {
  switch (reason) {
    case 'layer_readonly':
      return errors.forbidden('Правка объектов слоя выключена')
    case 'no_data_access':
      return errors.notFound('Объект')
    case 'dataset_readonly':
      return errors.forbidden('Правка строк отключена в настройках датасета')
    case 'row_policy':
      return errors.forbidden('Строки датасета ограничены политикой — править их может управляющий')
    default:
      return errors.forbidden('Недостаточно прав для правки объектов слоя')
  }
}

/**
 * Режим правки (ADR-0076): напрямую — право `edit_features` на слой (edit) и
 * запись строк датасета (edit, правка включена, без политики строк); на проверку —
 * модерируемый слой, право `suggest_features` (comment) и доступ к строкам.
 * Проверяют правки те, кто правит напрямую.
 */
async function accessOf(ctx: Ctx, layer: StoredLayer): Promise<EditAccess> {
  const rows = await DatasetRows.access(ctx, layer.datasetId)
  const none = (reason: LayerEditReason): EditAccess => ({
    mode: 'none',
    reason,
    canReview: false,
    rows,
  })
  if (!layer.editable) return none('layer_readonly')
  if (!rows.view) return none('no_data_access')
  if (rows.reason === 'dataset_readonly') return none('dataset_readonly')
  const [edit, suggest] = await Promise.all([
    authorize(ctx, 'edit_features', layer.id, { soft: true }),
    authorize(ctx, 'suggest_features', layer.id, { soft: true }),
  ])
  if (edit.allowed && rows.direct) {
    return { mode: 'direct', reason: null, canReview: layer.moderated, rows }
  }
  const reason: LayerEditReason = rows.reason ?? 'no_rights'
  if (layer.moderated && suggest.allowed) {
    return { mode: 'suggest', reason, canReview: false, rows }
  }
  return none(reason)
}

async function requireDirect(ctx: Ctx, layer: StoredLayer): Promise<void> {
  const access = await accessOf(ctx, layer)
  if (access.mode !== 'direct') {
    throw access.mode === 'suggest'
      ? errors.forbidden('Правки этого слоя проходят проверку — отправьте правку на проверку')
      : denied(access.reason)
  }
}

const layerRef = (layer: StoredLayer) => ({
  id: layer.id,
  type: 'layer',
  spaceId: layer.spaceId,
  title: layer.name,
})

/** Геометрия передаётся отдельно от значений полей. */
function attributeValues(layer: StoredLayer, values: Record<string, unknown>) {
  if (layer.geometryField in values) {
    throw errors.validation('Геометрия передаётся полем geometry', [
      { path: layer.geometryField, message: 'Геометрия — отдельно от значений' },
    ])
  }
  return values
}

function toFeature(layer: StoredLayer, row: DatasetRow): LayerFeature {
  const { [layer.geometryField]: geometry, ...values } = row.values
  return {
    id: row._id,
    ver: row._ver,
    values,
    geometry:
      typeof geometry === 'object' && geometry !== null && !Array.isArray(geometry)
        ? (geometry as Record<string, unknown>)
        : null,
  }
}

/** Строка, которую видит автор правки, в той версии, что он видел. */
async function currentRow(ctx: Ctx, layer: StoredLayer, rowId: string, ver: number) {
  const row = await DatasetQueries.row(ctx, layer.datasetId, rowId)
  if (row._ver !== ver) {
    throw new AppError('conflict', 'Объект уже изменили — проверьте его текущие значения', 409, {
      data: { current: row, changedFields: [] },
    })
  }
  return row
}

async function pendingCount(layerId: string, authorId: string | null): Promise<number> {
  const conditions: SQL[] = [eq(featureEdits.layerId, layerId), eq(featureEdits.status, 'pending')]
  if (authorId) conditions.push(eq(featureEdits.authorId, authorId))
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(featureEdits)
    .where(and(...conditions))
  return row?.count ?? 0
}

async function toEdits(rows: EditRow[], visible: Set<string> | null): Promise<FeatureEdit[]> {
  const refs = await directory().refs([
    ...new Set(
      rows.flatMap((row) => [row.authorId, row.reviewerId]).filter((id): id is string => !!id),
    ),
  ])
  return rows.map((row) => ({
    id: String(row.id),
    layerId: row.layerId,
    datasetId: row.datasetId,
    rowId: row.rowId === null ? null : String(row.rowId),
    op: row.op as FeatureEditOp,
    // Проверяющему — только поля, которые он видит (политика столбцов)
    values: visible
      ? Object.fromEntries(Object.entries(row.values).filter(([key]) => visible.has(key)))
      : row.values,
    geometry: row.geometry,
    baseVer: row.baseVer,
    note: row.note,
    status: row.status as FeatureEditStatus,
    author: row.authorId ? (refs.get(row.authorId) ?? null) : null,
    reviewer: row.reviewerId ? (refs.get(row.reviewerId) ?? null) : null,
    comment: row.comment,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
  }))
}

/** Применение принятой правки строкой датасета — в транзакции решения. */
async function apply(
  tx: Executor,
  ctx: Ctx,
  layer: StoredLayer,
  edit: EditRow,
  force: boolean,
): Promise<string | null> {
  const editId = String(edit.id)
  const geometry = edit.geometry ? { [layer.geometryField]: edit.geometry } : {}
  const op = edit.op as FeatureEditOp
  if (op === 'create') {
    const row = await DatasetRows.insert(tx, ctx, layer.datasetId, { ...edit.values, ...geometry })
    await publishEvent(tx, ctx, {
      type: 'feature.created',
      object: layerRef(layer),
      payload: { datasetId: layer.datasetId, rowId: row._id, editId },
    })
    return row._id
  }
  const rowId = String(edit.rowId)
  // «Применить всё равно»: поверх версии, которую видит проверяющий
  const ver = force
    ? (await DatasetQueries.row(ctx, layer.datasetId, rowId))._ver
    : (edit.baseVer ?? 0)
  if (op === 'update') {
    const values = { ...edit.values, ...geometry }
    const row = await DatasetRows.update(tx, ctx, layer.datasetId, rowId, { values, ver })
    if (row._ver !== ver) {
      await publishEvent(tx, ctx, {
        type: 'feature.updated',
        object: layerRef(layer),
        payload: { datasetId: layer.datasetId, rowId, editId, fields: Object.keys(values) },
      })
    }
    return rowId
  }
  const removed = await DatasetRows.remove(tx, ctx, layer.datasetId, rowId, ver)
  if (removed > 0) {
    await publishEvent(tx, ctx, {
      type: 'feature.deleted',
      object: layerRef(layer),
      payload: { datasetId: layer.datasetId, rowId, editId },
    })
  }
  return rowId
}

/**
 * Правка объектов слоя (07-gis-engine.md §7, ADR-0076): запись строки датасета
 * через слой — с проверкой геометрии, версией строки и событиями `feature.*` в
 * той же транзакции; модерируемый слой принимает предложения правок
 * (`feature_edits`), их проверяют редакторы слоя, принятая правка применяется
 * строкой датасета.
 */
export const FeatureEditService = {
  async access(ctx: Ctx, layerId: string): Promise<LayerEditAccess> {
    const layer = await LayerService.load(layerId)
    const { rows: _rows, ...access } = await accessOf(ctx, layer)
    const pending =
      layer.moderated && access.mode !== 'none'
        ? await pendingCount(layer.id, access.canReview ? null : actorId(ctx))
        : 0
    return { ...access, pending }
  },

  async create(ctx: Ctx, layerId: string, input: LayerFeatureInput): Promise<LayerFeature> {
    const layer = await LayerService.load(layerId)
    await requireDirect(ctx, layer)
    const values = attributeValues(layer, input.values)
    const geometry = await normalizeGeometry(input.geometry, layer.geometryType)
    return db().transaction(async (tx) => {
      const row = await DatasetRows.insert(tx, ctx, layer.datasetId, {
        ...values,
        [layer.geometryField]: geometry,
      })
      await publishEvent(tx, ctx, {
        type: 'feature.created',
        object: layerRef(layer),
        payload: { datasetId: layer.datasetId, rowId: row._id, editId: null },
      })
      return toFeature(layer, row)
    })
  },

  async update(
    ctx: Ctx,
    layerId: string,
    rowId: string,
    patch: LayerFeaturePatch,
  ): Promise<LayerFeature> {
    const layer = await LayerService.load(layerId)
    await requireDirect(ctx, layer)
    const values: Record<string, unknown> = { ...attributeValues(layer, patch.values) }
    if (patch.geometry) {
      values[layer.geometryField] = await normalizeGeometry(patch.geometry, layer.geometryType)
    }
    if (Object.keys(values).length === 0) throw errors.validation('Нет изменений')
    return db().transaction(async (tx) => {
      const row = await DatasetRows.update(tx, ctx, layer.datasetId, rowId, {
        values,
        ver: patch.ver,
      })
      if (row._ver !== patch.ver) {
        await publishEvent(tx, ctx, {
          type: 'feature.updated',
          object: layerRef(layer),
          payload: { datasetId: layer.datasetId, rowId, editId: null, fields: Object.keys(values) },
        })
      }
      return toFeature(layer, row)
    })
  },

  async remove(ctx: Ctx, layerId: string, rowId: string, ver: number): Promise<void> {
    const layer = await LayerService.load(layerId)
    await requireDirect(ctx, layer)
    await db().transaction(async (tx) => {
      const removed = await DatasetRows.remove(tx, ctx, layer.datasetId, rowId, ver)
      if (removed === 0) throw errors.notFound('Объект')
      await publishEvent(tx, ctx, {
        type: 'feature.deleted',
        object: layerRef(layer),
        payload: { datasetId: layer.datasetId, rowId, editId: null },
      })
    })
  },

  /**
   * Предложение правки модерируемого слоя: значения проверяются с правами автора
   * (как при записи), изменяемая строка должна быть ему видна в той версии, что
   * он правил. Владельцу слоя — дело во Входящих.
   */
  async submit(ctx: Ctx, layerId: string, input: FeatureEditInput): Promise<FeatureEdit> {
    const layer = await LayerService.load(layerId)
    if (!layer.editable) throw denied('layer_readonly')
    if (!layer.moderated) throw errors.forbidden('Слой без модерации: правки вносятся напрямую')
    await authorize(ctx, 'suggest_features', layer.id)
    const access = await DatasetRows.access(ctx, layer.datasetId)
    if (!access.view) throw denied('no_data_access')
    if (access.reason === 'dataset_readonly') throw denied('dataset_readonly')

    let values: Record<string, unknown> = {}
    let geometry: FeatureGeometry | null = null
    let rowId: string | null = null
    let baseVer: number | null = null
    if (input.op === 'delete') {
      await currentRow(ctx, layer, input.rowId, input.ver)
      rowId = input.rowId
      baseVer = input.ver
    } else {
      const proposed = attributeValues(layer, input.values)
      if (input.op === 'update') {
        await currentRow(ctx, layer, input.rowId, input.ver)
        rowId = input.rowId
        baseVer = input.ver
      }
      if (input.geometry) geometry = await normalizeGeometry(input.geometry, layer.geometryType)
      const checked = await DatasetRows.validate(
        ctx,
        layer.datasetId,
        { ...proposed, ...(geometry ? { [layer.geometryField]: geometry } : {}) },
        input.op === 'create',
      )
      const { [layer.geometryField]: _geometry, ...rest } = checked
      values = rest
      if (input.op === 'update' && Object.keys(values).length === 0 && !geometry) {
        throw errors.validation('Нет изменений')
      }
    }

    const authorId = actorId(ctx)
    const layerObject = await loadObject(layer.id)
    return db().transaction(async (tx) => {
      const [edit] = await tx
        .insert(featureEdits)
        .values({
          layerId: layer.id,
          datasetId: layer.datasetId,
          rowId: rowId === null ? null : Number(rowId),
          op: input.op,
          values,
          geometry: geometry as Record<string, unknown> | null,
          baseVer,
          note: input.note?.trim() || null,
          authorId,
        })
        .returning()
      if (!edit) throw errors.internal('Правка не сохранена')
      const ownerId = layerObject?.ownerId ?? null
      if (ownerId && ownerId !== authorId) {
        await InboxService.open(tx, ctx, {
          userId: ownerId,
          kind: 'review_edit',
          objectId: layer.id,
          titleKey: INBOX_TITLES[input.op],
          payload: { editId: String(edit.id), op: input.op },
          dedupeKey: inboxKey(edit.id),
          actions: REVIEW_ACTIONS,
        })
      }
      await publishEvent(tx, ctx, {
        type: 'feature.edit_submitted',
        object: layerRef(layer),
        payload: {
          editId: String(edit.id),
          op: input.op,
          datasetId: layer.datasetId,
          rowId,
          authorId,
        },
      })
      const [out] = await toEdits([edit], null)
      return out as FeatureEdit
    })
  },

  /** Правки слоя: проверяющему — все (или свои), остальным — только свои. */
  async list(ctx: Ctx, layerId: string, query: FeatureEditsQuery): Promise<FeatureEdit[]> {
    const layer = await LayerService.load(layerId)
    const access = await accessOf(ctx, layer)
    const all = query.scope === 'all' && access.canReview
    const conditions: SQL[] = [eq(featureEdits.layerId, layer.id)]
    if (query.status) conditions.push(eq(featureEdits.status, query.status))
    if (!all) conditions.push(eq(featureEdits.authorId, actorId(ctx) ?? ''))
    const rows = await db()
      .select()
      .from(featureEdits)
      .where(and(...conditions))
      .orderBy(desc(featureEdits.createdAt), desc(featureEdits.id))
      .limit(query.limit)
    const visible = all
      ? new Set((await DatasetQueries.visibleFields(ctx, layer.datasetId)).keys())
      : null
    return toEdits(rows, visible)
  },

  /**
   * Решение по правке: принятая применяется строкой датасета с правами
   * проверяющего в той же транзакции (строку изменили после подачи — 409 с
   * текущими значениями, `force` применяет поверх); дело во Входящих закрывается.
   */
  async review(
    ctx: Ctx,
    layerId: string,
    editId: string,
    input: FeatureEditReview,
  ): Promise<FeatureEdit> {
    const layer = await LayerService.load(layerId)
    const access = await accessOf(ctx, layer)
    if (!access.canReview) {
      throw errors.forbidden('Правки слоя проверяют редакторы, которые правят его данные')
    }
    return db().transaction(async (tx) => {
      const [edit] = await tx
        .select()
        .from(featureEdits)
        .where(and(eq(featureEdits.id, Number(editId)), eq(featureEdits.layerId, layer.id)))
        .for('update')
      if (!edit) throw errors.notFound('Правка')
      if (edit.status !== 'pending') throw errors.conflict('Правка уже рассмотрена')

      let rowId = edit.rowId === null ? null : String(edit.rowId)
      if (input.decision === 'approve') {
        try {
          rowId = await apply(tx, ctx, layer, edit, input.force)
        } catch (error) {
          // Строку удалили после подачи — применять нечего
          if (isAppError(error) && error.code === 'not_found') {
            throw errors.conflict('Объект уже удалён — отклоните правку')
          }
          throw error
        }
      }
      const status: FeatureEditStatus = input.decision === 'approve' ? 'approved' : 'rejected'
      const [updated] = await tx
        .update(featureEdits)
        .set({
          status,
          reviewerId: actorId(ctx),
          comment: input.comment?.trim() || null,
          reviewedAt: new Date().toISOString(),
          rowId: rowId === null ? null : Number(rowId),
        })
        .where(eq(featureEdits.id, edit.id))
        .returning()
      await InboxService.resolve(tx, ctx, {
        objectId: layer.id,
        kind: 'review_edit',
        dedupeKey: inboxKey(edit.id),
      })
      await publishEvent(tx, ctx, {
        type: 'feature.edit_reviewed',
        object: layerRef(layer),
        payload: {
          editId: String(edit.id),
          op: edit.op as FeatureEditOp,
          decision: status,
          datasetId: layer.datasetId,
          rowId,
          authorId: edit.authorId,
        },
      })
      const [out] = await toEdits([updated ?? edit], null)
      return out as FeatureEdit
    })
  },
}
