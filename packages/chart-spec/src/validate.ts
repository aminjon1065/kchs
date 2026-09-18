import type { ChartIssue, Ctx, FieldRef } from './model.js'
import { isNumericField } from './table.js'
import { toNumber } from './values.js'

/** Поле числовое по типу — или его значения читаются как числа (numeric строками). */
function numericLike(ctx: Ctx, ref: FieldRef): boolean {
  if (isNumericField(ref.def)) return true
  let seen = 0
  for (const row of ctx.result.rows) {
    const value = row[ref.index]
    if (value === null || value === undefined || value === '') continue
    if (toNumber(value) === null) return false
    seen += 1
    if (seen >= 20) break
  }
  return seen > 0
}

/**
 * Спецификация против результата: все поля кодировки есть в результате, у типа
 * есть обязательные каналы, показатели числовые. Сообщения — для автора графика.
 */
export function validateSpec(ctx: Ctx): ChartIssue[] {
  const { spec, t } = ctx
  const enc = spec.encoding
  const issues: ChartIssue[] = []
  const exists = (field: string | undefined, path: (string | number)[]) => {
    if (field && !ctx.field(field)) {
      issues.push({ path, message: t('ui.chart.issues.missingField', { field }) })
    }
  }
  exists(enc.x?.field, ['encoding', 'x', 'field'])
  enc.y.forEach((y, i) => {
    exists(y.field, ['encoding', 'y', i, 'field'])
  })
  if (enc.color && 'field' in enc.color) exists(enc.color.field, ['encoding', 'color', 'field'])
  exists(enc.size?.field, ['encoding', 'size', 'field'])
  exists(enc.text?.field, ['encoding', 'text', 'field'])
  enc.tooltip.forEach((field, i) => {
    exists(field, ['encoding', 'tooltip', i])
  })
  if (issues.length) return issues

  const needX = () => {
    if (!enc.x) issues.push({ path: ['encoding', 'x'], message: t('ui.chart.issues.needX') })
  }
  const needY = () => {
    if (enc.y.length === 0)
      issues.push({ path: ['encoding', 'y'], message: t('ui.chart.issues.needY') })
  }
  const numeric = (field: string | undefined, path: (string | number)[]) => {
    const ref = ctx.field(field)
    if (ref && !numericLike(ctx, ref)) {
      issues.push({
        path,
        message: t('ui.chart.issues.numeric', { field: ctx.label({ field: ref.def.name }) }),
      })
    }
  }
  const measures = () => {
    enc.y.forEach((y, i) => {
      numeric(y.field, ['encoding', 'y', i, 'field'])
    })
  }
  const colorField = enc.color && 'field' in enc.color ? enc.color.field : undefined

  switch (spec.type) {
    case 'bar':
    case 'line':
    case 'area':
    case 'combo':
      needX()
      needY()
      measures()
      break
    case 'pie':
    case 'donut':
    case 'funnel':
    case 'treemap':
      if (!enc.x && !colorField) needX()
      needY()
      measures()
      break
    case 'scatter':
    case 'bubble':
      needX()
      needY()
      numeric(enc.x?.field, ['encoding', 'x', 'field'])
      measures()
      if (spec.type === 'bubble') numeric(enc.size?.field, ['encoding', 'size', 'field'])
      break
    case 'heatmap':
      needX()
      needY()
      break
    case 'histogram':
      if (!enc.x && enc.y.length === 0) needX()
      numeric(
        enc.x?.field ?? enc.y[0]?.field,
        enc.x ? ['encoding', 'x', 'field'] : ['encoding', 'y', 0, 'field'],
      )
      break
    case 'number':
    case 'gauge':
      needY()
      numeric(enc.y[0]?.field, ['encoding', 'y', 0, 'field'])
      break
    default:
      break
  }
  return issues
}
