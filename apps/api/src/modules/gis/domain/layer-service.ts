import {
  type LayerCreateInput,
  type LayerGeometryType,
  type LayerRecord,
  LayerStyle,
  type LayerUpdateInput,
} from '@kchs/contracts'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { authorize, visibleObjectsSql } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import { DatasetGeo, datasetRecord } from '~/modules/data/public.js'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { layers, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { defaultStyle, styleFields } from './style-fields.js'

/** Строка слоя с объектом реестра — всё, что нужно тайлам и карточке. */
export interface StoredLayer {
  id: string
  name: string
  spaceId: string
  parentId: string | null
  datasetId: string
  geometryField: string
  geometryType: LayerGeometryType
  style: LayerStyle
  tileFields: string[]
  editable: boolean
  moderated: boolean
  version: number
  updatedAt: string
}

/** Поля стиля и поля тайла должны быть полями датасета (не геометрией слоя). */
async function assertFields(
  datasetId: string,
  geometryField: string,
  style: LayerStyle,
  tileFields: string[],
): Promise<void> {
  const record = await datasetRecord(datasetId)
  const keys = new Set(record.fields.map((field) => field.key))
  for (const key of [...styleFields(style), ...tileFields]) {
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

/**
 * Слои (07-gis-engine.md §1–4, ADR-0064): объект реестра `layer` — представление
 * датасета; права на слой не открывают данные — тайлы и объекты читаются с
 * политиками смотрящего.
 */
export const LayerService = {
  load,

  async create(tx: Executor, ctx: Ctx, input: LayerCreateInput): Promise<string> {
    // Автор слоя должен видеть датасет, иначе слой ссылался бы на недоступное
    await authorize(ctx, 'view', input.datasetId)
    const geo = await DatasetGeo.describe(input.datasetId, input.geometryField)
    const style = input.style ?? defaultStyle(geo.geometryType)
    const tileFields = input.tileFields ?? []
    await assertFields(input.datasetId, geo.field.key, style, tileFields)
    const object = await ObjectService.create(tx, ctx, {
      type: 'layer',
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      title: input.name,
      meta: { datasetId: input.datasetId, geometryType: geo.geometryType },
    })
    await tx.insert(layers).values({
      id: object.id,
      datasetId: input.datasetId,
      geometryField: geo.field.key,
      geometryType: geo.geometryType,
      style: style as unknown as Record<string, unknown>,
      tileFields,
      editable: input.editable,
      moderated: input.moderated,
    })
    await LinkService.setDependencies(tx, object.id, [input.datasetId])
    await publishEvent(tx, ctx, {
      type: 'layer.published',
      object: { id: object.id, type: 'layer', spaceId: object.spaceId, title: input.name },
      payload: { datasetId: input.datasetId, geometryType: geo.geometryType },
    })
    return object.id
  },

  async get(ctx: Ctx, id: string): Promise<LayerRecord> {
    const layer = await load(id)
    const access = await authorize(ctx, 'view', layer.datasetId, { soft: true })
    const geo = access.allowed
      ? await DatasetGeo.describe(layer.datasetId, layer.geometryField)
      : null
    return {
      id: layer.id,
      name: layer.name,
      spaceId: layer.spaceId,
      parentId: layer.parentId,
      datasetId: layer.datasetId,
      geometryField: layer.geometryField,
      geometryType: layer.geometryType,
      style: layer.style,
      tileFields: layer.tileFields,
      editable: layer.editable,
      moderated: layer.moderated,
      dataAccess: access.allowed,
      extent: geo?.extent ?? null,
      featureCount: geo?.rowCount ?? 0,
      datasetVersion: geo?.version ?? 0,
      version: layer.version,
      updatedAt: layer.updatedAt,
    }
  },

  async update(tx: Executor, ctx: Ctx, id: string, input: LayerUpdateInput): Promise<void> {
    const layer = await load(id, tx)
    const changed: string[] = []
    if (input.name !== undefined) {
      await ObjectService.update(tx, ctx, id, { title: input.name })
      changed.push('name')
    }
    const style = input.style ?? layer.style
    const tileFields = input.tileFields ?? layer.tileFields
    if (input.style || input.tileFields) {
      await assertFields(layer.datasetId, layer.geometryField, style, tileFields)
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
