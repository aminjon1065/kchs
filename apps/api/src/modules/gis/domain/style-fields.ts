import type { FilterNode, LayerGeometryType, LayerStyle } from '@kchs/contracts'
import { LayerStyle as LayerStyleSchema } from '@kchs/contracts'

/** Поля условий фильтра (правила стиля считаются на клиенте — поля нужны в тайле). */
export function filterFields(
  node: FilterNode | null | undefined,
  out = new Set<string>(),
): Set<string> {
  if (!node) return out
  if ('and' in node) for (const item of node.and) filterFields(item, out)
  else if ('or' in node) for (const item of node.or) filterFields(item, out)
  else if ('not' in node) filterFields(node.not, out)
  else out.add(node.field)
  return out
}

const TEMPLATE_FIELD = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g

/** Поля шаблона подписи или заголовка карточки: `{{name}} — {{kind}}`. */
function templateFields(template: string | null | undefined, out: Set<string>): void {
  if (!template) return
  for (const match of template.matchAll(TEMPLATE_FIELD)) {
    if (match[1]) out.add(match[1])
  }
}

/**
 * Поля, которые стиль читает из тайла: поле рендерера и нормализации, вес
 * тепловой карты, условия правил, размер точек, подпись (поле и шаблон), время.
 * Фильтр слоя применяется на сервере, карточка читается по щелчку.
 */
export function styleTileFields(style: LayerStyle): string[] {
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
  if (style.point.sizeBy) fields.add(style.point.sizeBy.field)
  if (style.label?.field) fields.add(style.label.field)
  templateFields(style.label?.template, fields)
  if (style.time) fields.add(style.time.field)
  // Служебное поле кластеров в схеме датасета не живёт
  fields.delete('point_count')
  return [...fields]
}

/** Все поля датасета, на которые ссылается стиль (для проверки при сохранении). */
export function styleFields(style: LayerStyle): string[] {
  const fields = new Set(styleTileFields(style))
  filterFields(style.filter, fields)
  for (const field of style.popup?.fields ?? []) fields.add(field)
  templateFields(style.popup?.title, fields)
  return [...fields]
}

/** Стиль по умолчанию: простой, по типу геометрии; точки — с кластерами. */
export function defaultStyle(geometryType: LayerGeometryType): LayerStyle {
  const geometry = geometryType === 'mixed' ? 'point' : geometryType
  return LayerStyleSchema.parse({
    version: 1,
    geometry,
    renderer: { kind: 'simple', color: 'categorical.1' },
    cluster: geometry === 'point' ? { enabled: true } : null,
  })
}
