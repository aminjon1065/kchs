import type { Channel } from '@kchs/contracts'
import type { EChartsOption } from 'echarts'
import { baseOption, categoryAxis, gridOption, markLines, tokenColor, valueAxis } from './base.js'
import type { Built } from './cartesian.js'
import { measureFormat } from './format.js'
import type { ChartTableModel, Ctx, FieldRef } from './model.js'
import { tipHtml, tooltipBase } from './tooltip.js'
import { histogramBins } from './transform.js'
import { toNumber } from './values.js'

/**
 * Гистограмма: корзины считаются на клиенте из сырых значений поля оси X
 * (или первого показателя). Столбцы смыкаются — зазор 2px цвета поверхности.
 */
export function buildHistogram(ctx: Ctx): Built {
  const { spec, theme, t } = ctx
  const channel = (spec.encoding.x ?? spec.encoding.y[0]) as Channel
  const ref = ctx.field(channel.field) as FieldRef
  const format = measureFormat(ctx, ref.def, channel.format)
  const values = ctx.result.rows
    .map((row) => toNumber(row[ref.index]))
    .filter((v): v is number => v !== null)
  const bins = histogramBins(values)
  const labels = bins.map((b) =>
    t('ui.chart.bin', { from: format.axis(b.from), to: format.axis(b.to) }),
  )
  const titles = bins.map((b) =>
    t('ui.chart.bin', { from: format.full(b.from), to: format.full(b.to) }),
  )
  const fixed =
    spec.encoding.color && 'value' in spec.encoding.color ? spec.encoding.color.value : undefined
  const fill = tokenColor(ctx, fixed) ?? (theme.categorical[0] as string)
  const count = measureFormat(ctx, null, { precision: 0 })

  // Опорные линии по оси значений (среднее, норматив) — в долях шкалы корзин
  const lines: Parameters<typeof markLines>[1] = []
  const first = bins[0]
  const step = first ? first.to - first.from : 0
  for (const ref of spec.options.referenceLines) {
    const value = toNumber(ref.value)
    if (value === null) continue
    if (ref.axis === 'y') {
      lines.push({
        axis: 'y',
        value,
        label: ref.label,
        style: ref.style,
        color: theme.tokens[ref.color],
      })
    } else if (first && step > 0) {
      // Категориальная ось: позиция внутри корзины — дробный индекс
      lines.push({
        axis: 'x',
        value: (value - first.from) / step - 0.5,
        label: ref.label,
        style: ref.style,
        color: theme.tokens[ref.color],
      })
    }
  }

  const option = {
    ...baseOption(ctx),
    grid: gridOption(ctx, { legend: false }),
    tooltip: {
      ...tooltipBase(ctx, 'item'),
      formatter: (params: { dataIndex: number }) => {
        const bin = bins[params.dataIndex]
        if (!bin) return ''
        return tipHtml(titles[params.dataIndex] ?? '', [
          { color: fill, name: t('ui.chart.count'), value: count.full(bin.count) },
        ])
      },
    },
    xAxis: {
      ...categoryAxis(ctx, labels, { name: ctx.label(channel) }),
      nameLocation: 'middle',
      nameGap: 28,
    },
    yAxis: valueAxis(ctx, {
      format: (v) => count.axis(v),
      grid: spec.options.axes.y?.grid ?? true,
    }),
    series: [
      {
        type: 'bar',
        name: t('ui.chart.count'),
        barCategoryGap: 2,
        itemStyle: { color: fill, borderRadius: [2, 2, 0, 0] },
        emphasis: { focus: 'self' },
        ...(lines.length ? { markLine: markLines(ctx, lines) } : {}),
        data: bins.map((b) => b.count),
      },
    ],
  } as unknown as EChartsOption

  const table: ChartTableModel = {
    caption: '',
    columns: [
      { key: channel.field, label: ctx.label(channel), numeric: false },
      { key: 'count', label: t('ui.chart.count'), numeric: true },
    ],
    rows: bins.map((b, i) => [titles[i] ?? '', count.full(b.count)]),
    total: bins.length,
  }

  return {
    option,
    table,
    pick: (params) => {
      const bin = params.dataIndex === undefined ? undefined : bins[params.dataIndex]
      if (!bin) return null
      return {
        label: titles[params.dataIndex as number] ?? '',
        filters: [{ field: channel.field, op: 'between', value: [bin.from, bin.to] }],
      }
    },
    brush: () => null,
  }
}
