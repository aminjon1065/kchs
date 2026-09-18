import type { YChannel } from '@kchs/contracts'
import type { PeriodBucket } from '@kchs/fields'
import type { EChartsOption } from 'echarts'
import {
  type AxisOption,
  baseOption,
  categoryAxis,
  colorAssigner,
  gridOption,
  legendOption,
  MAX_SERIES,
  markLines,
  OTHER_KEY,
  timeAxis,
  tokenColor,
  valueAxis,
} from './base.js'
import {
  bucketForSpan,
  categoryLabel,
  type MeasureFormat,
  measureFormat,
  periodLabel,
  periodTick,
  shareFormat,
} from './format.js'
import type {
  BrushSelection,
  ChartFilter,
  ChartPick,
  ChartTableModel,
  Ctx,
  PickParams,
} from './model.js'
import { textOn, withAlpha } from './theme.js'
import { type TipRow, tipHtml, tooltipBase } from './tooltip.js'
import { compareValues, lttb, topN } from './transform.js'
import {
  addBucket,
  detectBucket,
  periodSequence,
  previousYear,
  toNumber,
  toWallClock,
} from './values.js'

type Mark = 'bar' | 'line' | 'area'
export type CartesianType = 'bar' | 'line' | 'area' | 'combo'

export interface Built {
  option: EChartsOption
  table: ChartTableModel
  pick: (params: PickParams) => ChartPick | null
  brush: (selection: readonly BrushSelection[]) => ChartFilter | null
}

interface SeriesDef {
  key: string
  name: string
  y: YChannel
  mark: Mark
  axis: 0 | 1
  color: string
  format: MeasureFormat
  /** Значение поля цвета (для фильтра при клике); undefined — серия показателя. */
  colorRaw?: unknown
  /** «Прочее»: значения поля цвета, сложенные в серию. */
  foldedRaw?: unknown[]
}

interface XEntry {
  key: string
  raw: unknown
  /** Настенное время (ось времени) или число (ось значений). */
  pos: number | null
  label: string
  title: string
  /** «Прочее»: исходные значения, сложенные в категорию. */
  foldedRaw?: unknown[]
}

/** Строка ECharts-серии для сопоставления событий с данными. */
interface Plotted {
  def: SeriesDef
  comparison: boolean
  /** Индекс данных серии → ключ категории. */
  keys: string[]
  values: (number | null)[]
  shares: (number | null)[] | null
}

const NULL_KEY = `${String.fromCharCode(0)}null`

function keyOf(value: unknown): string {
  if (value === null || value === undefined || value === '') return NULL_KEY
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

export function buildCartesian(ctx: Ctx, type: CartesianType): Built {
  const { spec, theme, t } = ctx
  const { encoding, options } = spec
  const x = encoding.x as NonNullable<typeof encoding.x>
  const xRef = ctx.field(x.field) as NonNullable<ReturnType<Ctx['field']>>
  const colorCh = encoding.color && 'field' in encoding.color ? encoding.color : null
  const colorRef = colorCh ? ctx.field(colorCh.field) : null
  const fixed = encoding.color && 'value' in encoding.color ? encoding.color.value : undefined
  const horizontal = type === 'bar' && options.horizontal
  const temporal = x.type === 'temporal' || xRef.def.type === 'date' || xRef.def.type === 'datetime'
  const onCategory = type === 'bar' || type === 'combo' || (!temporal && x.type !== 'quantitative')
  const xKind: 'category' | 'time' | 'value' = onCategory ? 'category' : temporal ? 'time' : 'value'
  const stacked = options.stacked || options.percent
  const percent =
    options.percent && (type === 'bar' || type === 'area' || (type === 'line' && options.area))

  // ─── Серии ─────────────────────────────────────────────────────────────────
  const markOf = (y: YChannel, i: number): Mark => {
    if (type === 'combo') return y.mark ?? (i === 0 ? 'bar' : 'line')
    if (type === 'line') return options.area ? 'area' : 'line'
    return type
  }
  const ys = colorRef ? encoding.y.slice(0, 1) : encoding.y
  if (colorRef && encoding.y.length > 1) ctx.notes.push(t('ui.chart.notes.firstMeasure'))
  const yRefs = ys.map((y) => ctx.field(y.field) as NonNullable<ReturnType<Ctx['field']>>)

  // ─── Ячейки: категория × серия ─────────────────────────────────────────────
  const cells = new Map<string, Map<string, number>>()
  const entries = new Map<string, XEntry>()
  const colorRaws = new Map<string, unknown>()
  const put = (xKey: string, sKey: string, value: number) => {
    let row = cells.get(xKey)
    if (!row) {
      row = new Map()
      cells.set(xKey, row)
    }
    row.set(sKey, (row.get(sKey) ?? 0) + value)
  }
  for (const row of ctx.result.rows) {
    const raw = row[xRef.index]
    let key: string
    let pos: number | null = null
    if (temporal) {
      pos = toWallClock(raw, ctx.fmt.timezone)
      if (pos === null) continue
      key = String(pos)
    } else if (xKind === 'value') {
      pos = toNumber(raw)
      if (pos === null) continue
      key = String(pos)
    } else {
      key = keyOf(raw)
    }
    if (!entries.has(key)) entries.set(key, { key, raw, pos, label: '', title: '' })
    if (colorRef) {
      const cRaw = row[colorRef.index]
      const sKey = keyOf(cRaw)
      if (!colorRaws.has(sKey)) colorRaws.set(sKey, cRaw)
      const v = toNumber(row[(yRefs[0] as { index: number }).index])
      if (v !== null) put(key, sKey, v)
    } else {
      yRefs.forEach((ref, i) => {
        const v = toNumber(row[ref.index])
        if (v !== null) put(key, `y:${i}`, v)
      })
    }
  }
  const cell = (xKey: string, sKey: string) => cells.get(xKey)?.get(sKey) ?? null

  // ─── Порядок категорий, top-N и «Прочее» ───────────────────────────────────
  let order = [...entries.values()]
  const bucket: PeriodBucket | null = temporal
    ? detectBucket(order.map((e) => e.pos as number))
    : null
  const seriesKeysAll = colorRef ? [...colorRaws.keys()] : ys.map((_, i) => `y:${i}`)
  const total = (xKey: string, only?: (sKey: string) => boolean) =>
    seriesKeysAll.reduce((sum, s) => (only && !only(s) ? sum : sum + (cell(xKey, s) ?? 0)), 0)

  const sort = options.sort ?? null
  const sortByMeasure = sort ? ys.findIndex((y) => y.field === sort.by) : -1
  if (temporal || xKind === 'value') {
    order.sort((a, b) => (a.pos as number) - (b.pos as number))
  }
  if (sort && sort.by === x.field && xKind === 'category' && !temporal) {
    order.sort((a, b) => compareValues(a.raw, b.raw, ctx.locale))
    if (sort.dir === 'desc') order.reverse()
  } else if (sort && sortByMeasure >= 0 && xKind === 'category') {
    const only = colorRef ? undefined : (s: string) => s === `y:${sortByMeasure}`
    order.sort((a, b) => total(a.key, only) - total(b.key, only))
    if (sort.dir === 'desc') order.reverse()
  } else if (options.limit && xKind === 'category' && !temporal) {
    order.sort((a, b) => total(b.key) - total(a.key))
  }

  // Пропущенные периоды на категориальной оси — пустые места, а не склейка
  if (
    temporal &&
    xKind === 'category' &&
    bucket &&
    !(sort && sortByMeasure >= 0) &&
    order.length > 1
  ) {
    const seq = periodSequence(
      order[0]?.pos as number,
      order[order.length - 1]?.pos as number,
      bucket,
    )
    if (seq) {
      order = seq.map(
        (pos) =>
          entries.get(String(pos)) ?? { key: String(pos), raw: null, pos, label: '', title: '' },
      )
    }
  }

  let limit = options.limit ?? null
  if (xKind === 'category' && order.length > ctx.maxPoints)
    limit = Math.min(limit ?? ctx.maxPoints, ctx.maxPoints)
  if (limit && order.length > limit) {
    const shown = order.length
    if (temporal) {
      // Для времени предел — последние N периодов
      order = order.slice(order.length - limit)
      ctx.notes.push(t('ui.chart.notes.limited', { shown: limit, total: shown }))
    } else {
      const kept = order.slice(0, limit)
      const folded = order.slice(limit)
      order = kept
      if (options.other) {
        const other: XEntry = {
          key: OTHER_KEY,
          raw: null,
          pos: null,
          label: t('ui.chart.other'),
          title: t('ui.chart.other'),
          foldedRaw: folded.map((e) => e.raw),
        }
        for (const s of seriesKeysAll) {
          let sum: number | null = null
          for (const e of folded) {
            const v = cell(e.key, s)
            if (v !== null) sum = (sum ?? 0) + v
          }
          if (sum !== null) put(OTHER_KEY, s, sum)
        }
        order.push(other)
      } else {
        ctx.notes.push(t('ui.chart.notes.limited', { shown: limit, total: shown }))
      }
    }
  }

  // Подписи категорий
  order.forEach((e, i) => {
    if (e.key === OTHER_KEY) return
    if (temporal && e.pos !== null) {
      if (bucket) {
        e.label = periodTick(ctx, e.pos, bucket, i === 0)
        e.title = periodLabel(ctx, e.pos, bucket)
      } else {
        e.label = categoryLabel(ctx, e.raw, xRef.def)
        e.title = e.label
      }
    } else if (xKind === 'value') {
      e.label = measureFormat(ctx, xRef.def, x.format).full(e.pos)
      e.title = e.label
    } else {
      e.label = categoryLabel(ctx, e.raw, xRef.def)
      e.title = e.label
    }
  })

  // ─── Серии: предел палитры ─────────────────────────────────────────────────
  let seriesKeys = seriesKeysAll
  let foldedSeries: string[] = []
  if (seriesKeys.length > MAX_SERIES) {
    const weight = (s: string) => order.reduce((sum, e) => sum + Math.abs(cell(e.key, s) ?? 0), 0)
    const room = options.other && colorRef ? MAX_SERIES - 1 : MAX_SERIES
    const top = topN(seriesKeys, weight, room)
    ctx.notes.push(
      t('ui.chart.notes.hiddenSeries', { shown: top.kept.length, total: seriesKeys.length }),
    )
    seriesKeys = top.kept
    if (options.other && colorRef) {
      foldedSeries = top.folded
      for (const e of order) {
        let sum: number | null = null
        for (const s of foldedSeries) {
          const v = cell(e.key, s)
          if (v !== null) sum = (sum ?? 0) + v
        }
        if (sum !== null) put(e.key, OTHER_KEY, sum)
      }
      seriesKeys = [...seriesKeys, OTHER_KEY]
    }
  }

  const assign = colorAssigner(ctx, seriesKeys)
  const defs: SeriesDef[] = seriesKeys.map((sKey) => {
    if (colorRef) {
      const y = ys[0] as YChannel
      const isOther = sKey === OTHER_KEY
      return {
        key: sKey,
        name: isOther ? t('ui.chart.other') : categoryLabel(ctx, colorRaws.get(sKey), colorRef.def),
        y,
        mark: markOf(y, 0),
        axis: type === 'combo' && y.axis === 'right' ? 1 : 0,
        color: isOther ? theme.other : assign(sKey),
        format: measureFormat(ctx, yRefs[0]?.def, y.format),
        ...(isOther
          ? { foldedRaw: foldedSeries.map((s) => colorRaws.get(s)) }
          : { colorRaw: colorRaws.get(sKey) }),
      }
    }
    const i = Number(sKey.slice(2))
    const y = ys[i] as YChannel
    const single = ys.length === 1
    return {
      key: sKey,
      name: ctx.label(y),
      y,
      mark: markOf(y, i),
      axis: type === 'combo' && y.axis === 'right' ? 1 : 0,
      color:
        tokenColor(ctx, y.color) ??
        (single ? tokenColor(ctx, fixed) : undefined) ??
        (theme.categorical[i % theme.categorical.length] as string),
      format: measureFormat(ctx, yRefs[i]?.def, y.format),
    }
  })
  if (defs.length === 0) {
    defs.push({
      key: 'y:0',
      name: '',
      y: ys[0] as YChannel,
      mark: markOf(ys[0] as YChannel, 0),
      axis: 0,
      color: theme.categorical[0] as string,
      format: measureFormat(ctx, yRefs[0]?.def, ys[0]?.format),
    })
  }

  // Доли для процентного режима — по оси, среди видимых серий
  const shareOf = (xKey: string, def: SeriesDef): number | null => {
    const v = cell(xKey, def.key)
    if (v === null) return null
    const sum = defs
      .filter((d) => d.axis === def.axis)
      .reduce((acc, d) => acc + Math.abs(cell(xKey, d.key) ?? 0), 0)
    return sum === 0 ? 0 : v / sum
  }

  // ─── Сравнение с прошлым периодом / годом ──────────────────────────────────
  const comparison = options.comparison?.mode
  const canCompare =
    (comparison === 'previous_period' || comparison === 'previous_year') &&
    temporal &&
    bucket !== null &&
    defs.length === 1 &&
    !colorRef &&
    type !== 'combo' &&
    !percent
  if (comparison && comparison !== 'target' && !canCompare) {
    ctx.notes.push(t('ui.chart.notes.noComparison'))
  }
  const shiftBack = (pos: number) =>
    comparison === 'previous_year' ? previousYear(pos) : addBucket(pos, bucket as PeriodBucket, -1)
  const comparedName = (def: SeriesDef) =>
    t('ui.chart.compared', {
      name: def.name,
      period: t(`ui.chart.period.${comparison as 'previous_period' | 'previous_year'}`),
    })

  // ─── Точки серий ───────────────────────────────────────────────────────────
  const plotted: Plotted[] = []
  const series: Record<string, unknown>[] = []
  const labelsMode = options.labels.show
  const autoBarLabels =
    labelsMode === 'auto' && !stacked && defs.length === 1 && order.length <= (horizontal ? 20 : 12)
  const pointsPerSeries = order.length
  const showSymbol =
    options.points === 'always' ||
    (options.points === 'auto' && pointsPerSeries <= 30 && defs.length <= 4)
  const endLabels = labelsMode !== 'never' && defs.length >= 2 && defs.length <= 4 && type !== 'bar'
  let sampledFrom = 0

  const pushBar = (def: SeriesDef, comparisonSeries: boolean) => {
    const keys = order.map((e) => e.key)
    const values = comparisonSeries
      ? order.map((e) => (e.pos === null ? null : cell(String(shiftBack(e.pos)), def.key)))
      : order.map((e) => cell(e.key, def.key))
    const shares = percent ? order.map((e) => shareOf(e.key, def)) : null
    const plottedValues = shares ?? values
    const lastInStack = (i: number, sign: number) => {
      // Скругляется только внешний конец стопки своего знака
      const own = defs.indexOf(def)
      for (let j = defs.length - 1; j > own; j -= 1) {
        const d = defs[j] as SeriesDef
        if (d.axis !== def.axis || d.mark !== 'bar') continue
        const v = cell(order[i]?.key as string, d.key)
        if (v !== null && Math.sign(v) === sign && v !== 0) return false
      }
      return true
    }
    const radius = (v: number, i: number): number[] => {
      const negative = v < 0
      if (stacked && !lastInStack(i, negative ? -1 : 1)) return [0, 0, 0, 0]
      if (horizontal) return negative ? [4, 0, 0, 4] : [0, 4, 4, 0]
      return negative ? [0, 0, 4, 4] : [4, 4, 0, 0]
    }
    const showLabels = !comparisonSeries && (labelsMode === 'always' || autoBarLabels)
    const labelText = (i: number) => {
      const share = shares?.[i]
      if (share !== undefined && share !== null) return shareFormat(ctx, share, 0)
      return def.format.full(values[i])
    }
    series.push({
      type: 'bar',
      name: comparisonSeries ? comparedName(def) : def.name,
      ...(horizontal ? { xAxisIndex: 0 } : { yAxisIndex: def.axis }),
      ...(stacked && !comparisonSeries ? { stack: `stack-${def.axis}` } : {}),
      barMaxWidth: 24,
      barMinHeight: 0,
      ...(canCompare ? { barGap: '-100%' } : { barGap: '10%' }),
      barCategoryGap: '32%',
      itemStyle: {
        color: comparisonSeries ? withAlpha(def.color, 0.3) : def.color,
        ...(stacked ? { borderColor: theme.surface, borderWidth: 1 } : {}),
      },
      emphasis: { focus: 'series', blurScope: 'coordinateSystem' },
      data: plottedValues.map((v, i) =>
        v === null
          ? '-'
          : {
              value: v,
              itemStyle: { borderRadius: radius(v, i) },
              ...(showLabels
                ? {
                    label: {
                      show: true,
                      position: stacked
                        ? 'inside'
                        : horizontal
                          ? v < 0
                            ? 'left'
                            : 'right'
                          : v < 0
                            ? 'bottom'
                            : 'top',
                      color: stacked ? textOn(def.color, theme) : theme.textSecondary,
                      fontSize: 11,
                      formatter: () => labelText(i),
                    },
                  }
                : {}),
            },
      ),
    })
    plotted.push({ def, comparison: comparisonSeries, keys, values, shares })
  }

  const pushLine = (def: SeriesDef, comparisonSeries: boolean) => {
    const area = def.mark === 'area'
    let keys: string[]
    let values: (number | null)[]
    let shares: (number | null)[] | null = null
    let data: unknown[]
    if (xKind === 'category') {
      keys = order.map((e) => e.key)
      values = comparisonSeries
        ? order.map((e) => (e.pos === null ? null : cell(String(shiftBack(e.pos)), def.key)))
        : order.map((e) => cell(e.key, def.key))
      shares = percent ? order.map((e) => shareOf(e.key, def)) : null
      data = [...(shares ?? values)]
    } else {
      // Ось времени или значений: пары [x, y], без пустых точек
      const pts = order
        .map((e) => ({
          e,
          v: comparisonSeries
            ? e.pos === null
              ? null
              : cell(String(shiftBack(e.pos)), def.key)
            : cell(e.key, def.key),
        }))
        .filter((p): p is { e: XEntry; v: number } => p.v !== null && p.e.pos !== null)
      let kept = pts
      if (pts.length > ctx.maxPoints) {
        const idx = lttb(
          pts.map((p) => p.e.pos as number),
          pts.map((p) => p.v),
          ctx.maxPoints,
        )
        kept = idx.map((i) => pts[i] as (typeof pts)[number])
        sampledFrom = Math.max(sampledFrom, pts.length)
      }
      keys = kept.map((p) => p.e.key)
      values = kept.map((p) => p.v)
      if (percent) {
        shares = kept.map((p) => shareOf(p.e.key, def))
        data = kept.map((p, i) => [p.e.pos, shares?.[i]])
      } else {
        data = kept.map((p) => [p.e.pos, p.v])
      }
    }
    const color = def.color
    series.push({
      type: 'line',
      name: comparisonSeries ? comparedName(def) : def.name,
      yAxisIndex: def.axis,
      ...(stacked && !comparisonSeries ? { stack: `stack-${def.axis}` } : {}),
      symbol: 'circle',
      symbolSize: 8,
      showSymbol: comparisonSeries ? false : showSymbol,
      smooth: options.smooth ? 0.3 : false,
      smoothMonotone: 'x',
      connectNulls: false,
      lineStyle: {
        width: 2,
        color,
        cap: 'round',
        join: 'round',
        type: comparisonSeries ? 'dashed' : 'solid',
        opacity: comparisonSeries ? 0.7 : 1,
      },
      itemStyle: { color, borderColor: theme.surface, borderWidth: 2 },
      ...(area && !comparisonSeries ? { areaStyle: { color, opacity: stacked ? 0.3 : 0.1 } } : {}),
      emphasis: { focus: 'series', blurScope: 'coordinateSystem', scale: false },
      ...(labelsMode === 'always' && !comparisonSeries
        ? {
            label: {
              show: true,
              position: 'top',
              color: theme.textSecondary,
              fontSize: 11,
              formatter: (p: { dataIndex: number }) => def.format.full(values[p.dataIndex]),
            },
          }
        : {}),
      ...(endLabels && !comparisonSeries
        ? {
            endLabel: {
              show: true,
              color: theme.textSecondary,
              fontSize: 11,
              distance: 6,
              formatter: () => def.name,
            },
          }
        : {}),
      data,
    })
    plotted.push({ def, comparison: comparisonSeries, keys, values, shares })
  }

  for (const def of defs) {
    if (canCompare) {
      if (def.mark === 'bar') pushBar(def, true)
      else pushLine(def, true)
    }
    if (def.mark === 'bar') pushBar(def, false)
    else pushLine(def, false)
  }
  if (sampledFrom > 0) {
    ctx.notes.push(t('ui.chart.notes.sampled', { shown: ctx.maxPoints, total: sampledFrom }))
  }

  // ─── Оси ───────────────────────────────────────────────────────────────────
  const axes = ctx.spec.options.axes
  const axisFormat = (axis: 0 | 1) => {
    if (percent) return (v: number) => shareFormat(ctx, v, 0)
    const def = defs.find((d) => d.axis === axis) ?? defs[0]
    return (v: number) => (def as SeriesDef).format.axis(v)
  }
  const hasRight = defs.some((d) => d.axis === 1)
  const axisName = (axis: 0 | 1) => {
    const opts = axis === 0 ? axes.y : axes.y2
    const explicit =
      (opts?.label ? ctx.label({ field: '', label: opts.label }) : null) ?? opts?.unit
    if (explicit) return explicit
    // Две оси — каждая подписана именами своих серий, иначе не понять, где чья шкала
    return hasRight
      ? defs
          .filter((d) => d.axis === axis)
          .map((d) => d.name)
          .join(', ')
      : undefined
  }
  const measureAxis = (axis: 0 | 1): AxisOption => {
    const opts = axis === 0 ? axes.y : axes.y2
    return valueAxis(ctx, {
      format: axisFormat(axis),
      min: percent ? 0 : opts?.min,
      max: percent ? 1 : opts?.max,
      log: opts?.log,
      grid: axis === 0 ? (opts?.grid ?? true) : false,
      name: axisName(axis),
      ...(hasRight ? { position: axis === 0 ? 'left' : 'right' } : {}),
    })
  }
  const xName = axes.x?.label ? ctx.label({ field: '', label: axes.x.label }) : undefined
  let dimensionAxis: AxisOption
  if (xKind === 'category') {
    dimensionAxis = categoryAxis(
      ctx,
      order.map((e) => e.label),
      {
        horizontal,
        boundaryGap: defs.some((d) => d.mark === 'bar'),
        grid: axes.x?.grid ?? false,
        name: xName,
      },
    )
  } else if (xKind === 'time') {
    const positions = order.map((e) => e.pos as number)
    const tickBucket =
      bucket ?? bucketForSpan((positions[positions.length - 1] ?? 0) - (positions[0] ?? 0))
    dimensionAxis = timeAxis(ctx, (v, first) => periodTick(ctx, v, tickBucket, first), {
      grid: axes.x?.grid ?? false,
    })
  } else {
    dimensionAxis = {
      ...valueAxis(ctx, {
        format: (v) => measureFormat(ctx, xRef.def, x.format).axis(v),
        grid: axes.x?.grid ?? false,
        name: xName,
        zeroBased: false,
      }),
      axisLine: { show: true, lineStyle: { color: theme.axis, width: 1 } },
    }
  }
  const measureAxes = hasRight ? [measureAxis(0), measureAxis(1)] : [measureAxis(0)]

  // ─── Опорные линии, аннотации, цель ────────────────────────────────────────
  const categoryIndex = (value: string | number) => {
    const i = order.findIndex(
      (e) => e.key !== OTHER_KEY && (String(e.raw) === String(value) || e.title === String(value)),
    )
    if (i >= 0) return i
    if (temporal) {
      const wall = toWallClock(value, ctx.fmt.timezone)
      const j = order.findIndex((e) => e.pos === wall)
      return j >= 0 ? j : null
    }
    return null
  }
  const xValue = (value: string | number): number | string | null => {
    if (xKind === 'category') return categoryIndex(value)
    if (xKind === 'time') return toWallClock(value, ctx.fmt.timezone)
    return toNumber(value)
  }
  const lines: Parameters<typeof markLines>[1] = []
  for (const ref of options.referenceLines) {
    const value = ref.axis === 'y' ? toNumber(ref.value) : xValue(ref.value)
    if (value === null) continue
    lines.push({
      axis: (ref.axis === 'y') !== horizontal ? 'y' : 'x',
      value,
      label: ref.label,
      style: ref.style,
      color: theme.tokens[ref.color],
    })
  }
  if (comparison === 'target' && options.target !== null && options.target !== undefined) {
    lines.push({
      axis: horizontal ? 'x' : 'y',
      value: options.target,
      label: t('ui.chart.target'),
      style: 'dashed',
      color: theme.tokens.neutral,
    })
  }
  const annotations = options.annotations
    .map((a) => ({ value: xValue(a.x), text: a.text }))
    .filter((a): a is { value: number | string; text: string } => a.value !== null)
  for (const a of annotations) {
    lines.push({
      axis: horizontal ? 'y' : 'x',
      value: a.value,
      label: a.text,
      style: 'dotted',
      color: theme.axis,
    })
  }
  const firstMain = series.findIndex((_, i) => !(plotted[i] as Plotted).comparison)
  const mark = markLines(ctx, lines)
  if (mark && firstMain >= 0) (series[firstMain] as Record<string, unknown>).markLine = mark

  // ─── Сборка ────────────────────────────────────────────────────────────────
  const legendShown = series.length >= 2
  const endLabelRoom = endLabels
    ? Math.min(140, 12 + 7 * Math.max(...defs.map((d) => d.name.length)))
    : 0
  const grid = gridOption(ctx, {
    legend: legendShown,
    endLabels: endLabelRoom,
    annotations: annotations.length > 0,
    axisNames: hasRight || Boolean(axisName(0)),
  })
  const zoomAxis = horizontal ? { yAxisIndex: 0 } : { xAxisIndex: 0 }
  const dataZoom = options.zoom
    ? [
        { type: 'inside', ...zoomAxis, filterMode: 'none' },
        ...(horizontal
          ? []
          : [
              {
                type: 'slider',
                ...zoomAxis,
                height: 16,
                bottom: (grid.bottom as number) + 0,
                borderColor: 'transparent',
                backgroundColor: 'transparent',
                fillerColor: withAlpha(theme.tokens.accent, 0.12),
                dataBackground: {
                  lineStyle: { color: theme.axis, width: 1 },
                  areaStyle: { color: theme.grid, opacity: 1 },
                },
                selectedDataBackground: {
                  lineStyle: { color: theme.tokens.accent, width: 1 },
                  areaStyle: { color: withAlpha(theme.tokens.accent, 0.2) },
                },
                handleStyle: { color: theme.surface, borderColor: theme.axis },
                moveHandleStyle: { color: theme.grid },
                textStyle: { color: theme.textSecondary, fontSize: 11 },
                labelFormatter: () => '',
                brushSelect: false,
              },
            ]),
      ]
    : undefined
  if (dataZoom && !horizontal) grid.bottom = (grid.bottom as number) + 28

  const titleAt = (p: Plotted, dataIndex: number) => {
    const key = p.keys[dataIndex]
    const entry = key === undefined ? undefined : entries.get(key)
    if (key === OTHER_KEY) return t('ui.chart.other')
    return entry?.title ?? order.find((e) => e.key === key)?.title ?? ''
  }
  const rowFor = (p: Plotted, dataIndex: number): TipRow | null => {
    const value = p.values[dataIndex]
    if (value === null || value === undefined) return null
    const share = p.shares?.[dataIndex]
    const formatted = p.def.format.full(value)
    return {
      color: p.def.color,
      dashed: p.comparison,
      name: p.comparison ? comparedName(p.def) : p.def.name,
      value:
        share !== undefined && share !== null
          ? `${shareFormat(ctx, share)} · ${formatted}`
          : formatted,
    }
  }
  type TipParam = { seriesIndex: number; dataIndex: number }
  const tooltip =
    type === 'bar'
      ? {
          ...tooltipBase(ctx, 'item'),
          formatter: (params: TipParam | TipParam[]) => {
            const p0 = Array.isArray(params) ? params[0] : params
            if (!p0) return ''
            const p = plotted[p0.seriesIndex]
            if (!p) return ''
            const rows: TipRow[] = []
            const main = rowFor(p, p0.dataIndex)
            if (main) rows.push(main)
            if (stacked && defs.length > 1) {
              const key = p.keys[p0.dataIndex] as string
              const sum = defs
                .filter((d) => d.axis === p.def.axis)
                .reduce((acc, d) => acc + (cell(key, d.key) ?? 0), 0)
              rows.push({ name: t('ui.chart.total'), value: p.def.format.full(sum) })
            }
            return tipHtml(titleAt(p, p0.dataIndex), rows)
          },
        }
      : {
          ...tooltipBase(ctx, 'axis'),
          formatter: (params: TipParam | TipParam[]) => {
            const list = Array.isArray(params) ? params : [params]
            const first = list[0]
            if (!first) return ''
            const p = plotted[first.seriesIndex]
            const title = p ? titleAt(p, first.dataIndex) : ''
            const rows = list
              .map((item) => {
                const q = plotted[item.seriesIndex]
                return q ? rowFor(q, item.dataIndex) : null
              })
              .filter((r): r is TipRow => r !== null)
            return tipHtml(title, rows)
          },
        }

  const option = {
    ...baseOption(ctx),
    grid,
    tooltip,
    ...(legendShown ? { legend: legendOption(ctx, true) } : {}),
    xAxis: horizontal ? measureAxes : dimensionAxis,
    yAxis: horizontal ? { ...dimensionAxis } : measureAxes,
    series,
    ...(dataZoom ? { dataZoom } : {}),
    ...(options.brush
      ? {
          brush: {
            ...(horizontal ? { yAxisIndex: 0 } : { xAxisIndex: 0 }),
            brushType: horizontal ? 'lineY' : 'lineX',
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

  // ─── Таблица данных ────────────────────────────────────────────────────────
  const tableSeries = plotted
  const columns = [
    { key: x.field, label: ctx.label(x), numeric: xKind === 'value' },
    ...tableSeries.map((p, i) => ({
      key: `s${i}`,
      label: p.comparison ? comparedName(p.def) : p.def.name,
      numeric: true,
    })),
  ]
  const tableRows = order.map((e) => [
    e.title,
    ...tableSeries.map((p) => {
      const value = p.comparison
        ? e.pos === null
          ? null
          : cell(String(shiftBack(e.pos)), p.def.key)
        : cell(e.key, p.def.key)
      if (value === null) return ''
      const share = percent ? shareOf(e.key, p.def) : null
      return share !== null
        ? `${p.def.format.full(value)} (${shareFormat(ctx, share)})`
        : p.def.format.full(value)
    }),
  ])
  const table: ChartTableModel = {
    caption: '',
    columns,
    rows: tableRows.slice(0, 1000),
    total: tableRows.length,
  }

  // ─── События ───────────────────────────────────────────────────────────────
  const xFilter = (entry: XEntry | undefined): ChartFilter | null => {
    if (!entry) return null
    if (entry.key === OTHER_KEY) {
      return {
        field: x.field,
        op: 'not_in',
        value: order.filter((e) => e.key !== OTHER_KEY).map((e) => e.raw),
      }
    }
    return { field: x.field, op: 'eq', value: entry.raw }
  }
  const seriesFilter = (def: SeriesDef): ChartFilter | null => {
    if (!colorCh) return null
    if (def.key === OTHER_KEY) {
      return {
        field: colorCh.field,
        op: 'not_in',
        value: defs.filter((d) => d.key !== OTHER_KEY).map((d) => d.colorRaw),
      }
    }
    return { field: colorCh.field, op: 'eq', value: def.colorRaw }
  }
  const pick = (params: PickParams): ChartPick | null => {
    if (params.seriesIndex === undefined || params.dataIndex === undefined) return null
    const p = plotted[params.seriesIndex]
    if (!p || p.comparison) return null
    const key = p.keys[params.dataIndex]
    const entry =
      key === OTHER_KEY
        ? order.find((e) => e.key === OTHER_KEY)
        : key
          ? entries.get(key)
          : undefined
    const filters = [xFilter(entry), seriesFilter(p.def)].filter(
      (f): f is ChartFilter => f !== null,
    )
    if (filters.length === 0) return null
    const title = titleAt(p, params.dataIndex)
    return { label: colorCh || defs.length > 1 ? `${title} · ${p.def.name}` : title, filters }
  }
  const brush = (selection: readonly BrushSelection[]): ChartFilter | null => {
    const picked = new Map<string, XEntry>()
    for (const sel of selection) {
      const p = plotted[sel.seriesIndex]
      if (!p) continue
      for (const i of sel.dataIndex) {
        const key = p.keys[i]
        const entry = key ? entries.get(key) : undefined
        if (entry) picked.set(entry.key, entry)
      }
    }
    const list = [...picked.values()]
    if (list.length === 0) return null
    if (temporal || xKind === 'value') {
      const sorted = list.sort((a, b) => (a.pos as number) - (b.pos as number))
      return {
        field: x.field,
        op: 'between',
        value: [sorted[0]?.raw, sorted[sorted.length - 1]?.raw],
      }
    }
    return { field: x.field, op: 'in', value: list.map((e) => e.raw) }
  }

  return { option, table, pick, brush }
}
