import type { Bbox, FilterNode, LayerRecord, MapSpec } from '@kchs/contracts'
import type { MapInstance } from '@kchs/ui'
import type { FeatureRef } from './context.js'

/**
 * Объекты слоёв на карте для инструментов (ADR-0073): какие слои MapLibre —
 * данные студии, как объект под курсором превращается в ссылку «слой + строка»,
 * какие условия у объектов слоя на сервере (фильтр карты и время — как у тайлов).
 */

/** Префикс слоёв и источников данных `MapCanvas` (ADR-0072). */
const DATA_PREFIX = 'kchs-data:'
/** Источник слоя студии — `layer-<id>` (layerSourceId). */
const SOURCE_PREFIX = `${DATA_PREFIX}layer-`
/** Роли слоёв стиля, объекты которых выбираются (подписи и подсветка — нет). */
const PICKABLE = new Set(['fill', 'line', 'point', 'cluster', 'heatmap'])

/** Объект, как его отдаёт `queryRenderedFeatures`: слой, источник, id и свойства. */
export interface RenderedHit {
  source: string
  id?: string | number | null
  properties?: Record<string, unknown> | null
  layer?: { id: string }
}

/** Слои MapLibre с объектами данных студии — для выборки рамкой и в точке. */
export function pickableLayerIds(map: MapInstance): string[] {
  return map
    .getStyle()
    .layers.filter((layer) => {
      if (!layer.id.startsWith(DATA_PREFIX)) return false
      const role = (layer.metadata as Record<string, unknown> | undefined)?.['kchs:role']
      return typeof role === 'string' && PICKABLE.has(role)
    })
    .map((layer) => layer.id)
}

/** Идентификатор слоя студии по источнику MapLibre; не слой студии — null. */
export function layerIdOfSource(source: string): string | null {
  return source.startsWith(SOURCE_PREFIX) ? source.slice(SOURCE_PREFIX.length) : null
}

/** Скопление сервера: у одного объекта тайла — много точек. */
export function isCluster(hit: RenderedHit): boolean {
  return Number(hit.properties?.point_count ?? 1) > 1
}

/**
 * Объекты в рамке или точке → ссылки без повторов (объект на стыке тайлов
 * приходит дважды) и слои, где попались скопления: их строки — с сервера.
 */
export function refsOfHits(hits: readonly RenderedHit[]): {
  refs: FeatureRef[]
  clustered: string[]
} {
  const seen = new Set<string>()
  const refs: FeatureRef[] = []
  const clustered = new Set<string>()
  for (const hit of hits) {
    const layerId = layerIdOfSource(hit.source)
    if (!layerId) continue
    if (isCluster(hit)) {
      clustered.add(layerId)
      continue
    }
    if (hit.id === null || hit.id === undefined) continue
    const key = `${layerId}:${hit.id}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ layerId, rowId: String(hit.id) })
  }
  return { refs, clustered: [...clustered] }
}

/** Ссылки без повторов; `add` — дополнить выделение, а не заменить. */
export function mergeRefs(
  current: readonly FeatureRef[],
  next: readonly FeatureRef[],
  add: boolean,
  limit: number,
): FeatureRef[] {
  const out: FeatureRef[] = []
  const seen = new Set<string>()
  for (const ref of add ? [...current, ...next] : next) {
    const key = `${ref.layerId}:${ref.rowId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
    if (out.length >= limit) break
  }
  return out
}

/** Строки выделения одного слоя. */
export function rowIdsOf(selection: readonly FeatureRef[], layerId: string): string[] {
  return selection.filter((ref) => ref.layerId === layerId).map((ref) => ref.rowId)
}

/** FilterNode → base64url для параметра `f` тайлов и объектов слоя (ADR-0064). */
export function encodeFilter(filter: FilterNode): string {
  const bytes = new TextEncoder().encode(JSON.stringify(filter))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Параметры `/gis/layers/{id}/features`, как у тайлов слоя на этой карте. */
export function featuresQuery(
  options: { bbox?: Bbox | null; filter?: FilterNode | null; time?: MapSpec['time'] },
  limit: number,
): Record<string, string> {
  const query: Record<string, string> = { limit: String(limit) }
  if (options.bbox) query.bbox = options.bbox.map((value) => value.toFixed(6)).join(',')
  if (options.filter) query.f = encodeFilter(options.filter)
  if (options.time) query.t = `${options.time.from}/${options.time.to}`
  return query
}

/**
 * Условия строк слоя для таблицы датасета — те же, что у тайлов на сервере
 * (`layerConditions`): фильтр слоя, фильтр карты (связанные представления,
 * дашборд) и интервал времени для слоя со временем.
 */
export function layerRowConditions(
  layer: Pick<LayerRecord, 'style'>,
  options: { filter?: FilterNode | null; time?: MapSpec['time'] },
): FilterNode[] {
  const out: FilterNode[] = []
  if (layer.style.filter) out.push(layer.style.filter)
  if (options.filter) out.push(options.filter)
  const time = layer.style.time
  if (time && options.time) {
    out.push({ field: time.field, op: 'between', value: [options.time.from, options.time.to] })
  }
  return out
}

/** Условия через И; нет условий — undefined. */
export function allOf(conditions: readonly FilterNode[]): FilterNode | undefined {
  if (conditions.length === 0) return undefined
  return conditions.length === 1 ? conditions[0] : { and: [...conditions] }
}
