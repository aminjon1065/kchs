import { type Bbox, FilterNode, type LayerTileQuery } from '@kchs/contracts'
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

/** Интервал времени `t=from/to` — для слоя со временем. */
function timeFilter(layer: StoredLayer, range: string | undefined): FilterNode | null {
  const time = layer.style.time
  if (!range || !time) return null
  const [from, to] = range.split('/')
  if (!from || !to) throw errors.validation('Интервал времени: ожидается «from/to» в ISO 8601')
  return { field: time.field, op: 'between', value: [from, to] }
}

/**
 * Условия строк слоя: фильтр слоя, фильтр карты (связанные представления,
 * дашборд) и время. Охват — пространственное окно компилятора, политики строк
 * смотрящего добавляет компилятор.
 */
export function layerConditions(layer: StoredLayer, query: LayerTileQuery): FilterNode | null {
  const conditions = [layer.style.filter, mapFilter(query.f), timeFilter(layer, query.t)].filter(
    (node): node is FilterNode => node !== null && node !== undefined,
  )
  if (conditions.length === 0) return null
  return conditions.length === 1 ? (conditions[0] as FilterNode) : { and: conditions }
}
