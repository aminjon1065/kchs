import {
  type LayerFeature,
  type LayerFeatureCollection,
  type LayerFeaturesQuery,
  QuerySpec,
} from '@kchs/contracts'
import { DatasetQueries } from '~/modules/data/public.js'
import type { Ctx } from '~/shared/context.js'
import { errors } from '~/shared/errors.js'
import { layerConditions, parseBbox } from './layer-filter.js'
import { LayerService } from './layer-service.js'
import { styleFields } from './style-fields.js'

type Geometry = Record<string, unknown>

const asGeometry = (value: unknown): Geometry | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Geometry) : null

/**
 * Объекты слоя GeoJSON (07-gis-engine.md §3): мелкие слои, правка и выделение —
 * те же условия, что у тайлов, через компилятор с политиками смотрящего.
 * Карточка объекта — строка датасета со всеми видимыми полями.
 */
export const FeatureService = {
  async features(
    ctx: Ctx,
    layerId: string,
    query: LayerFeaturesQuery,
  ): Promise<LayerFeatureCollection> {
    const layer = await LayerService.load(layerId)
    const visible = await DatasetQueries.visibleFields(ctx, layer.datasetId)
    if (!visible.has(layer.geometryField)) throw errors.forbidden()
    // Поля стиля, карточки и тайла — чтобы клиент рисовал и подписывал без дозапросов
    const fields = [...new Set([...styleFields(layer.style), ...layer.tileFields])].filter(
      (key) => key !== layer.geometryField && visible.has(key),
    )
    const where = layerConditions(layer, query)
    const spec = QuerySpec.parse({
      version: 1,
      source: { kind: 'dataset', id: layer.datasetId },
      steps: [
        ...(where ? [{ type: 'filter', where }] : []),
        { type: 'select', fields: [layer.geometryField, ...fields] },
      ],
      options: { cache: false },
    })
    // Охват — пространственное окно компилятора: рамка рядом с политикой строк, по индексу
    const result = await DatasetQueries.run(ctx, spec, {
      rowMeta: true,
      maxRows: query.limit,
      ...(query.bbox
        ? {
            spatialWindow: {
              datasetId: layer.datasetId,
              field: layer.geometryField,
              bbox: parseBbox(query.bbox),
            },
          }
        : {}),
    })
    const names = result.fields.map((field) => field.name)
    const idIndex = names.indexOf('_id')
    const geometryIndex = names.indexOf(layer.geometryField)
    return {
      type: 'FeatureCollection',
      features: result.rows.map((row) => {
        const properties: Record<string, unknown> = {}
        names.forEach((name, index) => {
          if (index !== idIndex && index !== geometryIndex) properties[name] = row[index]
        })
        return {
          type: 'Feature' as const,
          id: String(row[idIndex]),
          geometry: asGeometry(row[geometryIndex]),
          properties,
        }
      }),
      truncated: result.truncated,
    }
  },

  /** Карточка объекта по щелчку: строка с политиками смотрящего. */
  async feature(ctx: Ctx, layerId: string, rowId: string): Promise<LayerFeature> {
    const layer = await LayerService.load(layerId)
    const row = await DatasetQueries.row(ctx, layer.datasetId, rowId)
    const { [layer.geometryField]: geometry, ...values } = row.values
    return { id: row._id, ver: row._ver, values, geometry: asGeometry(geometry) }
  },
}
