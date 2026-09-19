import {
  type Bbox,
  FilterNode,
  type LayerStyle,
  LayerTilePreview,
  type LayerTileQuery,
} from '@kchs/contracts'
import { errors } from '~/shared/errors.js'
import type { StoredLayer } from './layer-service.js'

/** Охват из строки запроса «запад,юг,восток,север». */
export function parseBbox(text: string): Bbox {
  const [w = 0, s = 0, e = 0, n = 0] = text.split(',').map(Number)
  if (w >= e || s >= n || w < -180 || e > 180 || s < -90 || n > 90) {
    throw errors.validation('Охват: ожидается «запад,юг,восток,север» в градусах WGS 84')
  }
  return [w, s, e, n]
}

/** Фильтр карты `f`: FilterNode в JSON, base64url. */
function mapFilter(encoded: string | undefined): FilterNode | null {
  if (!encoded) return null
  try {
    const parsed = FilterNode.safeParse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    )
    if (parsed.success) return parsed.data
  } catch {
    // ниже — общий ответ
  }
  throw errors.validation('Фильтр карты не разобран: ожидается FilterNode в base64url')
}

/**
 * Предпросмотр рабочей копии стиля `p` (редактор стиля, ADR-0075): поля, фильтр
 * слоя, кластеры, масштабы и время вместо сохранённых. Права те же: строки и
 * поля — с политиками смотрящего, как у любого тайла.
 */
export function tilePreview(encoded: string | undefined): LayerTilePreview | null {
  if (!encoded) return null
  try {
    const parsed = LayerTilePreview.safeParse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
    )
    if (parsed.success) return parsed.data
  } catch {
    // ниже — общий ответ
  }
  throw errors.validation('Предпросмотр стиля не разобран: ожидается LayerTilePreview в base64url')
}

/** Интервал времени `t=from/to` — для слоя со временем. */
function timeFilter(time: LayerStyle['time'], range: string | undefined): FilterNode | null {
  if (!range || !time) return null
  const [from, to] = range.split('/')
  if (!from || !to) throw errors.validation('Интервал времени: ожидается «from/to» в ISO 8601')
  return { field: time.field, op: 'between', value: [from, to] }
}

/**
 * Условия строк слоя: фильтр слоя (у предпросмотра — рабочей копии стиля),
 * фильтр карты (связанные представления, дашборд) и время. Охват —
 * пространственное окно компилятора, политики строк смотрящего добавляет компилятор.
 */
export function layerConditions(
  layer: StoredLayer,
  query: LayerTileQuery,
  preview: LayerTilePreview | null = null,
): FilterNode | null {
  const style = preview ?? layer.style
  const conditions = [style.filter, mapFilter(query.f), timeFilter(style.time, query.t)].filter(
    (node): node is FilterNode => node !== null && node !== undefined,
  )
  if (conditions.length === 0) return null
  return conditions.length === 1 ? (conditions[0] as FilterNode) : { and: conditions }
}
