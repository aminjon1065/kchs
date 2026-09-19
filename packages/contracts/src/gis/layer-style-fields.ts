import type { FilterNode } from '../common/filter.js'
import type { LayerStyle } from './layer-style.js'

/**
 * Поля датасета, которые читает стиль слоя, — общие для сервера тайлов
 * (ADR-0064) и компилятора стиля MapLibre (`@kchs/map-style`, ADR-0065).
 */

const TEMPLATE_FIELD = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g

/** Служебное поле кластеров сервера: в схеме датасета его нет. */
export const LAYER_CLUSTER_COUNT_FIELD = 'point_count'

/** Поля условий фильтра. */
function filterFields(node: FilterNode | null | undefined, out: Set<string>): Set<string> {
  if (!node) return out
  if ('and' in node) for (const child of node.and) filterFields(child, out)
  else if ('or' in node) for (const child of node.or) filterFields(child, out)
  else if ('not' in node) filterFields(node.not, out)
  else out.add(node.field)
  return out
}

/** Поля шаблона подписи или заголовка карточки `{{name}} ({{capacity}})` по порядку появления. */
export function layerTemplateFields(template: string): string[] {
  const out: string[] = []
  for (const match of template.matchAll(TEMPLATE_FIELD)) {
    if (match[1] && !out.includes(match[1])) out.push(match[1])
  }
  return out
}

/**
 * Поля, которые стиль читает из тайла: поле рендерера и нормализации, вес
 * тепловой карты, условия правил, размер точек, подпись, время. Фильтр слоя
 * применяет сервер, карточку объекта — запрос по щелчку.
 */
export function layerStyleTileFields(style: LayerStyle): string[] {
  const fields = new Set<string>()
  const renderer = style.renderer
  switch (renderer.kind) {
    case 'categorized':
    case 'proportional':
      fields.add(renderer.field)
      break
    case 'graduated':
      fields.add(renderer.field)
      if (renderer.normalizeBy) fields.add(renderer.normalizeBy)
      break
    case 'heatmap':
      if (renderer.weightField) fields.add(renderer.weightField)
      break
    case 'rule':
      for (const rule of renderer.rules) filterFields(rule.filter, fields)
      break
    case 'simple':
      break
  }
  if (style.geometry === 'point' && style.point.sizeBy) fields.add(style.point.sizeBy.field)
  if (style.label?.field) fields.add(style.label.field)
  if (style.label?.template) {
    for (const field of layerTemplateFields(style.label.template)) fields.add(field)
  }
  if (style.time) fields.add(style.time.field)
  fields.delete(LAYER_CLUSTER_COUNT_FIELD)
  return [...fields]
}

/** Все поля датасета, на которые ссылается стиль: тайл, фильтр слоя, карточка объекта. */
export function layerStyleFields(style: LayerStyle): string[] {
  const fields = new Set(layerStyleTileFields(style))
  filterFields(style.filter, fields)
  for (const field of style.popup?.fields ?? []) fields.add(field)
  if (style.popup?.title) {
    for (const field of layerTemplateFields(style.popup.title)) fields.add(field)
  }
  fields.delete(LAYER_CLUSTER_COUNT_FIELD)
  return [...fields]
}
