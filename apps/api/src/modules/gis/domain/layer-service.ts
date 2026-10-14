import {
  type LayerCreateInput,
  type LayerGeometryType,
  type LayerRecord,
  LayerStyle,
  type LayerSystemSource,
  type LayerUpdateInput,
  layerStyleFields,
} from '@kchs/contracts'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { authorize, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { objects } from '~/kernel/objects/schema.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { DatasetGeo, datasetRecord } from '~/modules/data/public.js'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor, type Tx } from '~/shared/db/client.js'
import { errors } from '~/shared/errors.js'
import { layers } from '../schema.js'
import { type LayerSourceRef, systemLayerGeometry } from './layer-source.js'
import { defaultStyle } from './style-fields.js'
import { viewerGeometry } from './viewer-geometry.js'

/** Строка слоя с объектом реестра — всё, что нужно тайлам и карточке. */
export interface StoredLayer {
  id: string
  name: string
  spaceId: string
  parentId: string | null
  datasetId: string | null
  /** Системный датасет с правами смотрящего вместо датасета (ADR-0223). */
  systemSource: LayerSystemSource | null
  geometryField: string
  geometryType: LayerGeometryType
  style: LayerStyle
  tileFields: string[]
  editable: boolean
  moderated: boolean
  version: number
  updatedAt: string
}

/** Поля стиля и поля тайла должны быть полями источника (не геометрией слоя). */
async function assertFields(
  ctx: Ctx,
  source: LayerSourceRef,
  geometryField: string,
  style: LayerStyle,
  tileFields: string[],
): Promise<void> {
  const keys = source.systemSource
    ? (await systemLayerGeometry(ctx, source.systemSource)).fields
    : new Set((await datasetRecord(source.datasetId as string)).fields.map((field) => field.key))
  for (const key of [...layerStyleFields(style), ...tileFields]) {
    if (!keys.has(key) || key === geometryField) {
      throw errors.validation(`В датасете нет поля «${key}»`)
    }
  }
}

async function load(id: string, executor: Executor = db()): Promise<StoredLayer> {
  const [row] = await executor
    .select({ layer: layers, object: objects })
    .from(layers)
    .innerJoin(objects, eq(objects.id, layers.id))
    .where(and(eq(layers.id, id), isNull(objects.deletedAt)))
    .limit(1)
  if (!row?.object.spaceId) throw errors.notFound('Слой')
  return {
    id,
    name: row.object.title,
    spaceId: row.object.spaceId,
    parentId: row.object.parentId,
    datasetId: row.layer.datasetId,
    systemSource: row.layer.systemSource as LayerSystemSource | null,
    geometryField: row.layer.geometryField,
    geometryType: row.layer.geometryType as LayerGeometryType,
    style: LayerStyle.parse(row.layer.style),
    tileFields: row.layer.tileFields,
    editable: row.layer.editable,
    moderated: row.layer.moderated,
    version: row.object.version,
    updatedAt: new Date(row.object.updatedAt).toISOString(),
  }
}

/** Поле геометрии и вид источника слоя; автор слоя должен видеть датасет-источник. */
async function describeSource(
  ctx: Ctx,
  source: LayerSourceRef,
  geometryField: string | undefined,
): Promise<{ field: string; geometryType: LayerGeometryType }> {
  if (source.systemSource) {
    const geo = await systemLayerGeometry(ctx, source.systemSource)
    if (geometryField && geometryField !== geo.field) {
      throw errors.validation(`В источнике нет поля геометрии «${geometryField}»`)
    }
    return { field: geo.field, geometryType: geo.geometryType }
  }
  const datasetId = source.datasetId as string
  // Автор слоя должен видеть датасет, иначе слой ссылался бы на недоступное
  await authorize(ctx, 'view', datasetId)
  const geo = await DatasetGeo.describe(datasetId, geometryField)
  return { field: geo.field.key, geometryType: geo.geometryType }
}

/**
 * Слои (07-gis-engine.md §1–4, ADR-0064): объект реестра `layer` — представление
 * датасета; права на слой не открывают данные — тайлы и объекты читаются с
 * политиками смотрящего.
 */
export const LayerService = {
  load,

  async create(tx: Tx, ctx: Ctx, input: LayerCreateInput): Promise<string> {
    const source: LayerSourceRef = {
      datasetId: input.datasetId ?? null,
      systemSource: input.systemSource ?? null,
    }
    const geo = await describeSource(ctx, source, input.geometryField)
    // Системный источник — только чтение: строки принадлежат своим модулям (ADR-0223)
    if (source.systemSource && (input.editable || input.moderated)) {
      throw errors.validation('Слой системного датасета не правится на карте')
    }
    const style = input.style ?? defaultStyle(geo.geometryType)
    const tileFields = input.tileFields ?? []
    await assertFields(ctx, source, geo.field, style, tileFields)
    const object = await ObjectService.create(tx, ctx, {
      type: 'layer',
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      title: input.name,
      meta: {
        ...(source.datasetId ? { datasetId: source.datasetId } : {}),
        ...(source.systemSource ? { systemSource: source.systemSource } : {}),
        geometryType: geo.geometryType,
      },
    })
    await tx.insert(layers).values({
      id: object.id,
      datasetId: source.datasetId,
      systemSource: source.systemSource,
      geometryField: geo.field,
      geometryType: geo.geometryType,
      style: style as unknown as Record<string, unknown>,
      tileFields,
      editable: input.editable,
      moderated: input.moderated,
    })
    if (source.datasetId) await LinkService.setDependencies(tx, object.id, [source.datasetId])
    await publishEvent(tx, ctx, {
      type: 'layer.published',
      object: { id: object.id, type: 'layer', spaceId: object.spaceId, title: input.name },
      payload: {
        datasetId: source.datasetId,
        ...(source.systemSource ? { systemSource: source.systemSource } : {}),
        geometryType: geo.geometryType,
      },
    })
    return object.id
  },

  async get(ctx: Ctx, id: string): Promise<LayerRecord> {
    const layer = await load(id)
    // Системный источник открыт каждому: строки ограничивает политика смотрящего
    const allowed = layer.datasetId
      ? (await authorize(ctx, 'view', layer.datasetId, { soft: true })).allowed
      : true
    const geo =
      allowed && layer.datasetId
        ? await DatasetGeo.describe(layer.datasetId, layer.geometryField)
        : null
    // Под политикой строк — рамка и счётчик только своих строк
    const own = allowed ? await viewerGeometry(ctx, layer, layer.geometryField) : null
    return {
      id: layer.id,
      name: layer.name,
      spaceId: layer.spaceId,
      parentId: layer.parentId,
      datasetId: layer.datasetId,
      systemSource: layer.systemSource,
      geometryField: layer.geometryField,
      geometryType: layer.geometryType,
      style: layer.style,
      tileFields: layer.tileFields,
      editable: layer.editable,
      moderated: layer.moderated,
      dataAccess: allowed,
      extent: own ? own.extent : (geo?.extent ?? null),
      featureCount: own ? own.count : (geo?.rowCount ?? 0),
      datasetVersion: geo?.version ?? 0,
      version: layer.version,
      updatedAt: layer.updatedAt,
    }
  },

  async update(tx: Tx, ctx: Ctx, id: string, input: LayerUpdateInput): Promise<void> {
    const layer = await load(id, tx)
    const changed: string[] = []
    if (input.name !== undefined) {
      await ObjectService.update(tx, ctx, id, { title: input.name })
      changed.push('name')
    }
    const style = input.style ?? layer.style
    const tileFields = input.tileFields ?? layer.tileFields
    if (input.style || input.tileFields) {
      await assertFields(ctx, layer, layer.geometryField, style, tileFields)
    }
    if (layer.systemSource && (input.editable || input.moderated)) {
      throw errors.validation('Слой системного датасета не правится на карте')
    }
    const set: Partial<typeof layers.$inferInsert> = {}
    if (input.style) {
      set.style = style as unknown as Record<string, unknown>
      changed.push('style')
    }
    if (input.tileFields) {
      set.tileFields = tileFields
      changed.push('tileFields')
    }
    if (input.editable !== undefined) {
      set.editable = input.editable
      changed.push('editable')
    }
    if (input.moderated !== undefined) {
      set.moderated = input.moderated
      changed.push('moderated')
    }
    if (Object.keys(set).length > 0) {
      await tx.update(layers).set(set).where(eq(layers.id, id))
      // Версия объекта — часть адреса тайлов: новый стиль не берётся из кэша
      await ObjectService.update(tx, ctx, id, { meta: {}, mergeMeta: true }, { silent: true })
    }
    if (changed.length === 0) return
    await publishEvent(tx, ctx, {
      type: 'layer.style_changed',
      object: { id, type: 'layer', spaceId: layer.spaceId, title: input.name ?? layer.name },
      payload: { changed },
    })
  },

  /** Слои датасета, видимые смотрящему, — для «Показать на карте». */
  async forDataset(ctx: Ctx, datasetId: string): Promise<Array<{ id: string; name: string }>> {
    const rows = await db()
      .select({ id: objects.id, name: objects.title })
      .from(layers)
      .innerJoin(objects, eq(objects.id, layers.id))
      .where(
        and(
          eq(layers.datasetId, datasetId),
          isNull(objects.deletedAt),
          visibleObjectsSql(ctx, 'layer'),
        ),
      )
      .orderBy(objects.title)
    return rows
  },

  /** Слои по идентификаторам (для карты): несуществующие и удалённые пропускаются. */
  async many(ids: string[]): Promise<StoredLayer[]> {
    if (ids.length === 0) return []
    const rows = await db()
      .select({ id: layers.id })
      .from(layers)
      .innerJoin(objects, eq(objects.id, layers.id))
      .where(and(inArray(layers.id, ids), isNull(objects.deletedAt)))
    return Promise.all(rows.map((row) => load(row.id)))
  },
}
