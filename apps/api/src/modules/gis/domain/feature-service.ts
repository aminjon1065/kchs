import {
  type LayerFeature,
  type LayerFeatureCollection,
  type LayerFeaturesQuery,
  layerStyleFields,
  QuerySpec,
} from '@kchs/contracts'
import { DatasetQueries } from '~/modules/data/public.js'
import type { Ctx } from '~/shared/context.js'
import { errors } from '~/shared/errors.js'
import { layerConditions, parseBbox, tilePreview } from './layer-filter.js'
import { LayerService } from './layer-service.js'
import {
  layerQuerySource,
  layerVisibleFields,
  layerWindowSource,
  SYSTEM_ROW_ID,
  systemLayerRow,
} from './layer-source.js'

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
    const visible = await layerVisibleFields(ctx, layer)
    if (!visible.has(layer.geometryField)) throw errors.forbidden()
    // Поля стиля, карточки и тайла — чтобы клиент рисовал и подписывал без дозапросов;
    // у предпросмотра рабочей копии стиля — ещё и её поля (ADR-0075)
    const preview = tilePreview(query.p)
    const fields = [
      ...new Set([
        ...layerStyleFields(layer.style),
        ...(preview?.fields ?? []),
        ...layer.tileFields,
      ]),
    ].filter((key) => key !== layer.geometryField && visible.has(key))
    const where = layerConditions(layer, query, preview)
    const spec = QuerySpec.parse({
      version: 1,
      source: layerQuerySource(layer),
      steps: [
        ...(where ? [{ type: 'filter', where }] : []),
        {
          type: 'select',
          // У системного источника номер объекта — обычное поле `_id` (ADR-0223)
          fields: [
            ...(layer.systemSource ? [SYSTEM_ROW_ID] : []),
            layer.geometryField,
            ...fields.filter((key) => key !== SYSTEM_ROW_ID),
          ],
        },
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
              datasetId: layerWindowSource(layer),
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
    if (layer.systemSource) {
      const row = await systemLayerRow(ctx, layer.systemSource, rowId)
      const { [layer.geometryField]: geometry, [SYSTEM_ROW_ID]: _id, ...values } = row
      return { id: rowId, ver: 0, values, geometry: asGeometry(geometry) }
    }
    const row = await DatasetQueries.row(ctx, layer.datasetId as string, rowId)
    const { [layer.geometryField]: geometry, ...values } = row.values
    return { id: row._id, ver: row._ver, values, geometry: asGeometry(geometry) }
  },
}
