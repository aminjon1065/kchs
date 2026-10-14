import {
  type DatasetRecord,
  DatasetSettings,
  FieldDef,
  type LayerRecord,
  type QuerySource,
  type SystemDatasetSchema,
} from '@kchs/contracts'
import { queryOptions } from '@tanstack/react-query'
import { dataKeys } from '~/features/data/index.js'
import { http } from '~/shared/api/client.js'

type LayerSource = Pick<LayerRecord, 'id' | 'name' | 'spaceId' | 'datasetId' | 'systemSource'>

/**
 * Схема системного датасета в виде датасета (ADR-0223): стилю, подписям и карточке
 * объекта слоя нужны только поля. Таблицы нет — строки не правятся.
 */
function asDataset(layer: LayerSource, schema: SystemDatasetSchema): DatasetRecord {
  const now = new Date(0).toISOString()
  return {
    id: layer.id,
    name: layer.name,
    description: null,
    kind: 'table',
    spaceId: layer.spaceId,
    parentId: null,
    fields: schema.fields.map((field) => ({
      ...FieldDef.parse({ key: field.key, label: field.label, type: field.type }),
      ...(field.semantic ? { semantic: field.semantic } : {}),
      id: field.key,
    })),
    primaryKey: [],
    timeField: schema.timeField,
    territoryField: schema.fields.find((field) => field.type === 'territory')?.key ?? null,
    rowCount: 0,
    currentVersion: 0,
    schemaVersion: 0,
    lastImportAt: null,
    settings: DatasetSettings.parse({ editable: false }),
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Поля источника слоя: датасет реестра (общий ключ кэша с «Данными») или системный
 * датасет с правами смотрящего (ADR-0223).
 */
export const layerDatasetQuery = (layer: LayerSource) =>
  queryOptions({
    queryKey: layer.datasetId
      ? dataKeys.dataset(layer.datasetId)
      : (['system-dataset', layer.systemSource, 'layer', layer.id] as const),
    queryFn: async (): Promise<DatasetRecord> => {
      if (layer.datasetId) return http.get('/datasets/:id', { params: { id: layer.datasetId } })
      const name = layer.systemSource ?? 'document_places'
      return asDataset(layer, await http.get('/system-datasets/:name', { params: { name } }))
    },
    ...(layer.datasetId ? {} : { staleTime: 5 * 60_000 }),
  })

/** Источник запросов слоя (время, категории стиля): датасет реестра или системный датасет. */
export function layerQuerySource(
  layer: Pick<LayerRecord, 'datasetId' | 'systemSource'>,
): QuerySource {
  if (layer.datasetId) return { kind: 'dataset', id: layer.datasetId }
  return { kind: 'system', name: layer.systemSource ?? 'document_places' }
}
