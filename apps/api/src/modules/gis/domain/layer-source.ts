import type { FieldType, LayerGeometryType, LayerSystemSource, QuerySource } from '@kchs/contracts'
import { QuerySpec } from '@kchs/contracts'
import { systemDataset } from '~/kernel/system-datasets.js'
import { DatasetQueries } from '~/modules/data/public.js'
import type { Ctx } from '~/shared/context.js'
import { errors } from '~/shared/errors.js'

/** Источник слоя: датасет реестра или системный датасет с правами смотрящего (ADR-0223). */
export interface LayerSourceRef {
  datasetId: string | null
  systemSource: LayerSystemSource | null
}

/** Номер объекта тайла у системного источника — поле `_id` представления. */
export const SYSTEM_ROW_ID = '_id'

function systemDefinition(name: string) {
  const definition = systemDataset(name)
  if (!definition?.geometry) throw errors.validation(`Системный датасет «${name}» не для карты`)
  return { ...definition, geometry: definition.geometry }
}

/** Источник спецификации запроса слоя. */
export function layerQuerySource(layer: LayerSourceRef): QuerySource {
  if (layer.systemSource) return { kind: 'system', name: layer.systemSource }
  return { kind: 'dataset', id: layer.datasetId as string }
}

/**
 * Идентификатор источника в компиляторе — ключ пространственного окна (ADR-0064):
 * у системного датасета — `system:<имя>`, как его называет определение модуля.
 */
export function layerWindowSource(layer: LayerSourceRef): string {
  return layer.systemSource ? `system:${layer.systemSource}` : (layer.datasetId as string)
}

/** Поля источника, видимые смотрящему, с типами (скрытые политикой столбцов — нет). */
export async function layerVisibleFields(
  ctx: Ctx,
  layer: LayerSourceRef,
): Promise<Map<string, FieldType>> {
  if (!layer.systemSource) return DatasetQueries.visibleFields(ctx, layer.datasetId as string)
  const resolved = await systemDefinition(layer.systemSource).resolve(ctx)
  const hidden = new Set(resolved.columnPolicy.hide)
  return new Map(
    resolved.fields
      .filter((field) => !hidden.has(field.key))
      .map((field) => [field.key, field.type as FieldType]),
  )
}

/** Поле геометрии и вид системного источника; поля, которые может назвать стиль. */
export async function systemLayerGeometry(
  ctx: Ctx,
  name: LayerSystemSource,
): Promise<{ field: string; geometryType: LayerGeometryType; fields: Set<string> }> {
  const definition = systemDefinition(name)
  const resolved = await definition.resolve(ctx)
  return {
    field: definition.geometry.field,
    geometryType: definition.geometry.type,
    fields: new Set(resolved.fields.map((field) => field.key)),
  }
}

/** Строка системного источника по номеру объекта тайла — с политикой смотрящего. */
export async function systemLayerRow(
  ctx: Ctx,
  name: LayerSystemSource,
  rowId: string,
): Promise<Record<string, unknown>> {
  if (!/^\d{1,19}$/.test(rowId)) throw errors.notFound('Объект слоя')
  const spec = QuerySpec.parse({
    version: 1,
    source: { kind: 'system', name },
    steps: [{ type: 'filter', where: { field: SYSTEM_ROW_ID, op: 'eq', value: Number(rowId) } }],
    options: { cache: false },
  })
  const result = await DatasetQueries.run(ctx, spec, { maxRows: 1 })
  const row = result.rows[0]
  if (!row) throw errors.notFound('Объект слоя')
  const values: Record<string, unknown> = {}
  result.fields.forEach((field, index) => {
    values[field.name] = row[index]
  })
  return values
}
