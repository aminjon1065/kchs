import type { Channel } from '@kchs/contracts'
import type { EChartsOption } from 'echarts'
import { baseOption, categoryAxis, gridOption } from './base.js'
import type { Built } from './cartesian.js'
import {
  categoryLabel,
  type MeasureFormat,
  measureFormat,
  periodLabel,
  periodTick,
} from './format.js'
import type { ChartFilter, ChartTableModel, Ctx, FieldRef } from './model.js'
import { rampColor, textOn } from './theme.js'
import { type TipRow, tipHtml, tooltipBase } from './tooltip.js'
import { compareValues, topN } from './transform.js'
import { detectBucket, toNumber, toWallClock } from './values.js'

/** Предел строк и столбцов матрицы — дальше ячейки нечитаемы. */
const MAX_SIDE = 60
/** Разделитель ключа ячейки — не встречается в данных. */
const SEP = String.fromCharCode(1)

interface Axis {
  channel: Channel
  ref: FieldRef
  keys: string[]
  raws: Map<string, unknown>
  labels: string[]
  titles: string[]
}

function axisOf(ctx: Ctx, channel: Channel, weight: (key: string) => number): Axis {
  const ref = ctx.field(channel.field) as FieldRef
  const temporal =
    channel.type === 'temporal' || ref.def.type === 'date' || ref.def.type === 'datetime'
  const raws = new Map<string, unknown>()
  const walls = new Map<string, number>()
  for (const row of ctx.result.rows) {
    const raw = row[ref.index]
    const key = raw === null || raw === undefined ? '' : String(raw)
    if (raws.has(key)) continue
    raws.set(key, raw)
    if (temporal) {
      const wall = toWallClock(raw, ctx.fmt.timezone)
      if (wall !== null) walls.set(key, wall)
    }
  }
  let keys = [...raws.keys()]
  if (temporal) keys.sort((a, b) => (walls.get(a) ?? 0) - (walls.get(b) ?? 0))
  else if (channel.type === 'ordinal' || channel.type === 'quantitative') {
    keys.sort((a, b) => compareValues(raws.get(a), raws.get(b), ctx.locale))
  }
  if (keys.length > MAX_SIDE) {
    keys = topN(keys, weight, MAX_SIDE).kept
    ctx.notes.push(ctx.t('ui.chart.notes.limited', { shown: MAX_SIDE, total: raws.size }))
  }
  const bucket = temporal ? detectBucket([...walls.values()]) : null
  const labels = keys.map((key, i) => {
    const wall = walls.get(key)
    if (bucket && wall !== undefined) return periodTick(ctx, wall, bucket, i === 0)
    return categoryLabel(ctx, raws.get(key), ref.def)
  })
  const titles = keys.map((key) => {
    const wall = walls.get(key)
    if (bucket && wall !== undefined) return periodLabel(ctx, wall, bucket)
    return categoryLabel(ctx, raws.get(key), ref.def)
  })
  return { channel, ref, keys, raws, labels, titles }
}

/**
 * Тепловая карта x × y. Значение ячейки — поле цвета (последовательная шкала,
 * расходящаяся — если значения по обе стороны нуля или так задано); без поля
 * цвета — число строк. Допустима и обратная запись: y — число, цвет — измерение.
 */
export function buildHeatmap(ctx: Ctx): Built {
  const { spec, theme, t } = ctx
  const enc = spec.encoding
  const colorCh = enc.color && 'field' in enc.color ? enc.color : null
  let rowCh = enc.y[0] as Channel
  let valueCh: Channel | null = colorCh
  if (rowCh.type === 'quantitative' && colorCh && colorCh.type !== 'quantitative') {
    rowCh = colorCh
    valueCh = enc.y[0] as Channel
  }
  const valueRef = valueCh ? ctx.field(valueCh.field) : null
  const format: MeasureFormat = valueRef
    ? measureFormat(ctx, valueRef.def, valueCh?.format)
    : measureFormat(ctx, null, { precision: 0 })
  const valueLabel = valueCh ? ctx.label(valueCh) : t('ui.chart.count')

  // Суммы по ячейкам
  const xRef = ctx.field((enc.x as Channel).field) as FieldRef
  const yRef = ctx.field(rowCh.field) as FieldRef
  const cells = new Map<string, number>()
  const xWeight = new Map<string, number>()
  const yWeight = new Map<string, number>()
  const keyOf = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  for (const row of ctx.result.rows) {
    const value = valueRef ? toNumber(row[valueRef.index]) : 1
    if (value === null) continue
    const xk = keyOf(row[xRef.index])
    const yk = keyOf(row[yRef.index])
    const key = `${xk}${SEP}${yk}`
    cells.set(key, (cells.get(key) ?? 0) + value)
    xWeight.set(xk, (xWeight.get(xk) ?? 0) + Math.abs(value))
    yWeight.set(yk, (yWeight.get(yk) ?? 0) + Math.abs(value))
  }
  const xAxis = axisOf(ctx, enc.x as Channel, (k) => xWeight.get(k) ?? 0)
  const yAxis = axisOf(ctx, rowCh, (k) => yWeight.get(k) ?? 0)

  const data: { value: [number, number, number]; label?: { color: string } }[] = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  xAxis.keys.forEach((xk, xi) => {
    yAxis.keys.forEach((yk, yi) => {
      const v = cells.get(`${xk}${SEP}${yk}`)
      if (v === undefined) return
      min = Math.min(min, v)
      max = Math.max(max, v)
      data.push({ value: [xi, yi, v] })
    })
  })
  if (!Number.isFinite(min)) {
    min = 0
    max = 0
  }
  const palette = colorCh && 'palette' in colorCh ? colorCh.palette : 'sequential'
  const diverging = palette === 'diverging' || (min < 0 && max > 0)
  const ramp = diverging ? theme.diverging : theme.sequential
  // Расходящаяся шкала симметрична: ноль — нейтральная середина
  const bound = Math.max(Math.abs(min), Math.abs(max))
  const lo = diverging ? -bound : min
  const hi = diverging ? bound : max === min ? min + 1 : max
  const position = (v: number) => (hi === lo ? 0 : (v - lo) / (hi - lo))

  const labelsMode = spec.options.labels.show
  const showLabels = labelsMode === 'always' || (labelsMode === 'auto' && data.length <= 150)
  if (showLabels) {
    for (const item of data)
      item.label = { color: textOn(rampColor(ramp, position(item.value[2])), theme) }
  }

  const option = {
    ...baseOption(ctx),
    grid: { ...gridOption(ctx, { legend: false }), bottom: 48 },
    tooltip: {
      ...tooltipBase(ctx, 'item'),
      formatter: (params: { data?: { value: [number, number, number] } }) => {
        const value = params.data?.value
        if (!value) return ''
        const [xi, yi, v] = value
        const rows: TipRow[] = [
          { color: rampColor(ramp, position(v)), name: valueLabel, value: format.full(v) },
        ]
        return tipHtml(`${xAxis.titles[xi] ?? ''} · ${yAxis.titles[yi] ?? ''}`, rows)
      },
    },
    xAxis: { ...categoryAxis(ctx, xAxis.labels, {}), splitArea: { show: false } },
    yAxis: {
      ...categoryAxis(ctx, yAxis.labels, { horizontal: true }),
      splitArea: { show: false },
    },
    visualMap: {
      type: 'continuous',
      min: lo,
      max: hi,
      dimension: 2,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemWidth: 10,
      itemHeight: 160,
      text: [format.axis(hi), format.axis(lo)],
      textGap: 8,
      textStyle: { color: theme.textSecondary, fontSize: 11 },
      inRange: { color: [...ramp] },
      // Шкала — не фильтр: клик по ней не должен прятать ячейки
      hoverLink: false,
      realtime: false,
    },
    series: [
      {
        type: 'heatmap',
        name: valueLabel,
        itemStyle: { borderColor: theme.surface, borderWidth: 2, borderRadius: 2 },
        emphasis: { itemStyle: { borderColor: theme.text, borderWidth: 1 } },
        label: showLabels
          ? {
              show: true,
              fontSize: 11,
              formatter: (p: { data?: { value: [number, number, number] } }) =>
                p.data ? format.axis(p.data.value[2]) : '',
            }
          : { show: false },
        data,
      },
    ],
  } as unknown as EChartsOption

  const columns = [
    { key: xAxis.channel.field, label: ctx.label(xAxis.channel), numeric: false },
    { key: yAxis.channel.field, label: ctx.label(yAxis.channel), numeric: false },
    { key: 'value', label: valueLabel, numeric: true },
  ]
  const rows = data.map((d) => [
    xAxis.titles[d.value[0]] ?? '',
    yAxis.titles[d.value[1]] ?? '',
    format.full(d.value[2]),
  ])
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
      const item = params.dataIndex === undefined ? undefined : data[params.dataIndex]
      if (!item) return null
      const [xi, yi] = item.value
      const xk = xAxis.keys[xi] as string
      const yk = yAxis.keys[yi] as string
      const filters: ChartFilter[] = [
        { field: xAxis.channel.field, op: 'eq', value: xAxis.raws.get(xk) },
        { field: yAxis.channel.field, op: 'eq', value: yAxis.raws.get(yk) },
      ]
      return { label: `${xAxis.titles[xi] ?? ''} · ${yAxis.titles[yi] ?? ''}`, filters }
    },
    brush: () => null,
  }
}
