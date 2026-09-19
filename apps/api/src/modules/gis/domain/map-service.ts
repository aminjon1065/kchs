import {
  type Bbox,
  type MapCreateInput,
  type MapRecord,
  MapSpec,
  type MapUpdateInput,
} from '@kchs/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import { authorize } from '~/kernel/access/authorize.js'
import { publishEvent } from '~/kernel/events/publisher.js'
import { LinkService } from '~/kernel/links/service.js'
import { ObjectService } from '~/kernel/objects/service.js'
import type { Ctx } from '~/shared/context.js'
import { db, type Executor } from '~/shared/db/client.js'
import { maps, objects } from '~/shared/db/schema/index.js'
import { errors } from '~/shared/errors.js'
import { logger } from '~/shared/logger/index.js'
import { LayerService } from './layer-service.js'

/** Слои карты — зависимости («Используется в»); на недоступный автору слой карта не ссылается. */
async function assertLayers(ctx: Ctx, spec: MapSpec): Promise<string[]> {
  const ids = [...new Set(spec.layers.map((entry) => entry.layerId))]
  for (const id of ids) await authorize(ctx, 'view', id)
  return ids
}

/** Общий экстент видимых слоёв карты — по слоям, данные которых видит смотрящий. */
async function extentOf(ctx: Ctx, spec: MapSpec): Promise<Bbox | null> {
  let extent: Bbox | null = null
  for (const entry of spec.layers) {
    if (!entry.visible) continue
    try {
      if (!(await authorize(ctx, 'view', entry.layerId, { soft: true })).allowed) continue
      const layer = await LayerService.get(ctx, entry.layerId)
      if (!layer.extent) continue
      extent = extent
        ? [
            Math.min(extent[0], layer.extent[0]),
            Math.min(extent[1], layer.extent[1]),
            Math.max(extent[2], layer.extent[2]),
            Math.max(extent[3], layer.extent[3]),
          ]
        : layer.extent
    } catch (error) {
      // Слой удалён или датасет недоступен — карта открывается без него
      logger().debug({ err: error, layerId: entry.layerId }, 'слой карты не прочитан')
    }
  }
  return extent
}

/**
 * Карты (07-gis-engine.md §1, §6; ADR-0064): объект реестра `map` — композиция
 * слоёв. Права на карту не открывают слоёв и данных: студия запрашивает слои и
 * тайлы с правами смотрящего, недоступный слой показывается как «нет доступа».
 */
export const MapService = {
  async create(tx: Executor, ctx: Ctx, input: MapCreateInput): Promise<string> {
    const layerIds = await assertLayers(ctx, input.spec)
    const object = await ObjectService.create(tx, ctx, {
      type: 'map',
      spaceId: input.spaceId,
      parentId: input.parentId ?? null,
      title: input.name,
      meta: { layers: input.spec.layers.length },
    })
    await tx.insert(maps).values({
      id: object.id,
      spec: input.spec as unknown as Record<string, unknown>,
    })
    await LinkService.setDependencies(tx, object.id, layerIds)
    return object.id
  },

  async get(ctx: Ctx, id: string): Promise<MapRecord> {
    const [row] = await db()
      .select({ map: maps, object: objects })
      .from(maps)
      .innerJoin(objects, eq(objects.id, maps.id))
      .where(and(eq(maps.id, id), isNull(objects.deletedAt)))
      .limit(1)
    if (!row?.object.spaceId) throw errors.notFound('Карта')
    const spec = MapSpec.parse(row.map.spec)
    return {
      id,
      name: row.object.title,
      spaceId: row.object.spaceId,
      parentId: row.object.parentId,
      spec,
      extent: await extentOf(ctx, spec),
      version: row.object.version,
    }
  },

  async update(tx: Executor, ctx: Ctx, id: string, input: MapUpdateInput): Promise<void> {
    const changed: string[] = []
    if (input.name !== undefined) {
      await ObjectService.update(tx, ctx, id, { title: input.name })
      changed.push('name')
    }
    if (input.spec) {
      const layerIds = await assertLayers(ctx, input.spec)
      await tx
        .update(maps)
        .set({ spec: input.spec as unknown as Record<string, unknown> })
        .where(eq(maps.id, id))
      await LinkService.setDependencies(tx, id, layerIds)
      await ObjectService.update(
        tx,
        ctx,
        id,
        { meta: { layers: input.spec.layers.length }, mergeMeta: true },
        { silent: true },
      )
      changed.push('spec')
    }
    if (changed.length === 0) return
    const [object] = await tx
      .select({ spaceId: objects.spaceId, title: objects.title })
      .from(objects)
      .where(eq(objects.id, id))
      .limit(1)
    await publishEvent(tx, ctx, {
      type: 'map.updated',
      object: { id, type: 'map', spaceId: object?.spaceId ?? null, title: object?.title },
      payload: { changed },
    })
  },
}
