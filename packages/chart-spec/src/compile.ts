import type { ChartSpec, QueryResult } from '@kchs/contracts'
import { describe } from './alt-text.js'
import { type Built, buildCartesian } from './cartesian.js'
import { buildHeatmap } from './heatmap.js'
import { buildHistogram } from './histogram.js'
import { type CompiledChart, type CompileOptions, createCtx } from './model.js'
import { buildFunnel, buildPie, buildTreemap } from './parts.js'
import { buildScatter } from './scatter.js'
import { buildGauge, buildNumber } from './single.js'
import { buildTable } from './table.js'
import type { ChartTheme } from './theme.js'
import { validateSpec } from './validate.js'

/**
 * ChartSpec + результат запроса + тема → то, что рисует компонент `Chart`.
 * Графики ECharts получают опцию; показатель и таблица — свои модели (их рисует
 * дизайн-система без ECharts); пустой результат, неподходящая спецификация и
 * тип следующей фазы — объяснение вместо графика.
 */
export function compileChart(
  spec: ChartSpec,
  result: QueryResult,
  theme: ChartTheme,
  options: CompileOptions = {},
): CompiledChart {
  const ctx = createCtx(spec, result, theme, options)
  const alt = describe(ctx)
  const meta = () => ({ notes: [...new Set(ctx.notes)] })

  if (spec.type === 'map') {
    const table = result.rows.length ? { ...buildTable(ctx), caption: alt } : null
    return { kind: 'unsupported', alt, message: ctx.t('ui.chart.unsupported.map'), table }
  }
  const issues = validateSpec(ctx)
  if (issues.length) return { kind: 'invalid', alt, message: ctx.t('ui.chart.invalid'), issues }
  if (result.rows.length === 0) return { kind: 'empty', alt, message: ctx.t('ui.chart.empty') }
  if (spec.encoding.facet) ctx.notes.push(ctx.t('ui.chart.notes.facet'))

  let built: Built
  switch (spec.type) {
    case 'table':
    case 'pivot':
      return { kind: 'table', table: { ...buildTable(ctx), caption: alt }, alt, meta: meta() }
    case 'number': {
      const { model, table } = buildNumber(ctx)
      return { kind: 'number', model, table: { ...table, caption: alt }, alt, meta: meta() }
    }
    case 'bar':
    case 'line':
    case 'area':
    case 'combo':
      built = buildCartesian(ctx, spec.type)
      break
    case 'pie':
    case 'donut':
      built = buildPie(ctx, spec.type === 'donut')
      break
    case 'scatter':
    case 'bubble':
      built = buildScatter(ctx, spec.type === 'bubble')
      break
    case 'heatmap':
      built = buildHeatmap(ctx)
      break
    case 'histogram':
      built = buildHistogram(ctx)
      break
    case 'funnel':
      built = buildFunnel(ctx)
      break
    case 'gauge':
      built = buildGauge(ctx)
      break
    case 'treemap':
      built = buildTreemap(ctx)
      break
  }
  return {
    kind: 'echarts',
    option: built.option,
    table: { ...built.table, caption: alt },
    alt,
    meta: meta(),
    pick: built.pick,
    brush: built.brush,
  }
}
