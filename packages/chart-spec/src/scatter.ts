import type { Channel, YChannel } from '@kchs/contracts'
import type { EChartsOption } from 'echarts'
import {
  baseOption,
  colorAssigner,
  gridOption,
  legendOption,
  OTHER_KEY,
  tokenColor,
  valueAxis,
} from './base.js'
import type { Built } from './cartesian.js'
import { categoryLabel, measureFormat } from './format.js'
import type { ChartFilter, ChartTableModel, Ctx, FieldRef } from './model.js'
import { withAlpha } from './theme.js'
import { type TipRow, tipHtml, tooltipBase } from './tooltip.js'
import { topN } from './transform.js'
import { toNumber } from './values.js'

/** Все пары групп перекрываются — различимы не больше трёх оттенков, остальное «Прочее». */
const MAX_GROUPS = 3

interface Point {
  x: number
  y: number
  size: number | null
  row: number
}

/** Точечная и пузырьковая: x и y — числа, размер пузырька — площадью. */
export function buildScatter(ctx: Ctx, bubble: boolean): Built {
  const { spec, theme, t } = ctx
  const enc = spec.encoding
  const x = enc.x as Channel
  const y = enc.y[0] as YChannel
  const xRef = ctx.field(x.field) as FieldRef
  const yRef = ctx.field(y.field) as FieldRef
  const sizeRef = bubble && enc.size ? ctx.field(enc.size.field) : null
  const colorCh = enc.color && 'field' in enc.color ? enc.color : null
  const colorRef = colorCh ? ctx.field(colorCh.field) : null
  const textRef = enc.text ? ctx.field(enc.text.field) : null
  const fixed = enc.color && 'value' in enc.color ? enc.color.value : undefined
  const xFormat = measureFormat(ctx, xRef.def, x.format)
  const yFormat = measureFormat(ctx, yRef.def, y.format)
  const sizeFormat = sizeRef ? measureFormat(ctx, sizeRef.def, enc.size?.format) : null

  const groups = new Map<string, { raw: unknown; points: Point[] }>()
  ctx.result.rows.forEach((row, i) => {
    const px = toNumber(row[xRef.index])
    const py = toNumber(row[yRef.index])
    if (px === null || py === null) return
    const raw = colorRef ? row[colorRef.index] : null
    const key = colorRef ? String(raw ?? '') : ''
    let group = groups.get(key)
    if (!group) {
      group = { raw, points: [] }
      groups.set(key, group)
    }
    group.points.push({ x: px, y: py, size: sizeRef ? toNumber(row[sizeRef.index]) : null, row: i })
  })

  let keys = [...groups.keys()]
  if (keys.length > MAX_GROUPS) {
    const top = topN(keys, (k) => groups.get(k)?.points.length ?? 0, MAX_GROUPS)
    const other: Point[] = top.folded.flatMap((k) => groups.get(k)?.points ?? [])
    groups.set(OTHER_KEY, { raw: null, points: other })
    keys = [...top.kept, OTHER_KEY]
    ctx.notes.push(
      t('ui.chart.notes.foldedGroups', {
        shown: MAX_GROUPS,
        total: top.kept.length + top.folded.length,
      }),
    )
  }
  const assign = colorAssigner(ctx, keys)
  const colorOf = (key: string) =>
    key === OTHER_KEY
      ? theme.other
      : colorRef
        ? assign(key)
        : (tokenColor(ctx, y.color ?? fixed) ?? (theme.categorical[0] as string))

  // Размер пузырька: площадь пропорциональна значению, 6…36 px
  const sizes = [...groups.values()].flatMap((g) => g.points.map((p) => p.size ?? 0))
  const minSize = sizes.length ? Math.min(...sizes, 0) : 0
  const maxSize = sizes.length ? Math.max(...sizes) : 1
  const radius = (v: number | null) =>
    v === null || maxSize === minSize
      ? 8
      : 6 + 30 * Math.sqrt(Math.max(0, (v - minSize) / (maxSize - minSize)))

  const plotted = keys.map((key) => ({
    key,
    group: groups.get(key) as { raw: unknown; points: Point[] },
  }))
  const nameOf = (key: string, raw: unknown) =>
    key === OTHER_KEY
      ? t('ui.chart.other')
      : colorRef
        ? categoryLabel(ctx, raw, colorRef.def)
        : ctx.label(y)
  const total = plotted.reduce((n, p) => n + p.group.points.length, 0)
  const large = total > 2000

  const series = plotted.map(({ key, group }) => {
    const color = colorOf(key)
    return {
      type: 'scatter',
      name: nameOf(key, group.raw),
      symbol: 'circle',
      symbolSize: bubble ? (value: number[]) => radius(value[2] ?? null) : 8,
      large,
      largeThreshold: 2000,
      itemStyle: {
        color: bubble ? withAlpha(color, 0.72) : color,
        borderColor: theme.surface,
        borderWidth: large ? 0 : 1,
      },
      emphasis: { focus: 'series', blurScope: 'coordinateSystem', scale: 1.2 },
      data: group.points.map((p) => (bubble ? [p.x, p.y, p.size] : [p.x, p.y])),
    }
  })

  const textOf = (p: Point) =>
    textRef ? categoryLabel(ctx, ctx.result.rows[p.row]?.[textRef.index], textRef.def) : null
  const legendShown = series.length >= 2
  const axes = spec.options.axes
  const option = {
    ...baseOption(ctx),
    grid: gridOption(ctx, { legend: legendShown }),
    ...(legendShown ? { legend: legendOption(ctx, true) } : {}),
    tooltip: {
      ...tooltipBase(ctx, 'item'),
      formatter: (params: { seriesIndex: number; dataIndex: number }) => {
        const entry = plotted[params.seriesIndex]
        const p = entry?.group.points[params.dataIndex]
        if (!entry || !p) return ''
        const color = colorOf(entry.key)
        const rows: TipRow[] = [
          { color, name: ctx.label(y), value: yFormat.full(p.y) },
          { name: ctx.label(x), value: xFormat.full(p.x) },
        ]
        if (sizeFormat && enc.size)
          rows.push({ name: ctx.label(enc.size), value: sizeFormat.full(p.size) })
        const title =
          textOf(p) ??
          (colorRef || entry.key === OTHER_KEY ? nameOf(entry.key, entry.group.raw) : null)
        return tipHtml(title, rows)
      },
    },
    xAxis: {
      ...valueAxis(ctx, {
        format: (v) => xFormat.axis(v),
        min: axes.x?.min,
        max: axes.x?.max,
        log: axes.x?.log,
        grid: axes.x?.grid ?? false,
        name: ctx.label(x),
        zeroBased: false,
      }),
      axisLine: { show: true, lineStyle: { color: theme.axis, width: 1 } },
      nameLocation: 'middle',
      nameGap: 28,
    },
    yAxis: valueAxis(ctx, {
      format: (v) => yFormat.axis(v),
      min: axes.y?.min,
      max: axes.y?.max,
      log: axes.y?.log,
      grid: axes.y?.grid ?? true,
      name: ctx.label(y),
      zeroBased: false,
    }),
    series,
    ...(spec.options.brush
      ? {
          brush: {
            xAxisIndex: 0,
            brushType: 'lineX',
            brushMode: 'single',
            transformable: false,
            throttleType: 'debounce',
            throttleDelay: 300,
            brushStyle: {
              color: withAlpha(theme.tokens.accent, 0.12),
              borderColor: withAlpha(theme.tokens.accent, 0.6),
              borderWidth: 1,
            },
            outOfBrush: { colorAlpha: 0.3 },
            toolbox: [],
          },
        }
      : {}),
  } as unknown as EChartsOption

  const columns = [
    ...(textRef && enc.text
      ? [{ key: enc.text.field, label: ctx.label(enc.text), numeric: false }]
      : []),
    ...(colorCh ? [{ key: colorCh.field, label: ctx.label(colorCh), numeric: false }] : []),
    { key: x.field, label: ctx.label(x), numeric: true },
    { key: y.field, label: ctx.label(y), numeric: true },
    ...(sizeFormat && enc.size
      ? [{ key: enc.size.field, label: ctx.label(enc.size), numeric: true }]
      : []),
  ]
  const rows = plotted.flatMap(({ key, group }) =>
    group.points.map((p) => [
      ...(textRef ? [textOf(p) ?? ''] : []),
      ...(colorCh ? [nameOf(key, group.raw)] : []),
      xFormat.full(p.x),
      yFormat.full(p.y),
      ...(sizeFormat ? [sizeFormat.full(p.size)] : []),
    ]),
  )
  const table: ChartTableModel = {
    caption: '',
    columns,
    rows: rows.slice(0, 1000),
    total: rows.length,
  }

  return {
    option,
    table,
    pick: (params) => {
      const entry = params.seriesIndex === undefined ? undefined : plotted[params.seriesIndex]
      const p = params.dataIndex === undefined ? undefined : entry?.group.points[params.dataIndex]
      if (!entry || !p) return null
      const filters: ChartFilter[] = []
      if (textRef && enc.text) {
        filters.push({
          field: enc.text.field,
          op: 'eq',
          value: ctx.result.rows[p.row]?.[textRef.index],
        })
      } else {
        filters.push({ field: x.field, op: 'eq', value: ctx.result.rows[p.row]?.[xRef.index] })
        filters.push({ field: y.field, op: 'eq', value: ctx.result.rows[p.row]?.[yRef.index] })
      }
      if (colorCh && entry.key !== OTHER_KEY)
        filters.push({ field: colorCh.field, op: 'eq', value: entry.group.raw })
      return { label: textOf(p) ?? `${xFormat.full(p.x)} · ${yFormat.full(p.y)}`, filters }
    },
    brush: (selection) => {
      let lo = Number.POSITIVE_INFINITY
      let hi = Number.NEGATIVE_INFINITY
      for (const sel of selection) {
        const entry = plotted[sel.seriesIndex]
        for (const i of sel.dataIndex) {
          const p = entry?.group.points[i]
          if (!p) continue
          lo = Math.min(lo, p.x)
          hi = Math.max(hi, p.x)
        }
      }
      return Number.isFinite(lo) ? { field: x.field, op: 'between', value: [lo, hi] } : null
    },
  }
}
