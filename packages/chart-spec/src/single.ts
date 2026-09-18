import type { YChannel } from '@kchs/contracts'
import { formatCompactNumber, formatPercent } from '@kchs/fields'
import type { EChartsOption } from 'echarts'
import { baseOption, tokenColor } from './base.js'
import type { Built } from './cartesian.js'
import { categoryLabel, type MeasureFormat, measureFormat, periodLabel } from './format.js'
import type { ChartTableModel, Ctx, FieldRef, NumberTileModel } from './model.js'
import type { ChartColorToken } from './theme.js'
import { niceStep } from './transform.js'
import { detectBucket, previousYear, toNumber, toWallClock } from './values.js'

interface Series {
  y: YChannel
  ref: FieldRef
  format: MeasureFormat
  /** Значения по времени (если есть временная ось) или одно значение. */
  points: { wall: number | null; raw: unknown; value: number }[]
  /** Текущее значение: последняя точка ряда по времени, без оси — первая строка. */
  current: { wall: number | null; raw: unknown; value: number } | null
  /** Второй показатель — база сравнения, если задан. */
  base: number | null
}

/**
 * Ряд показателя: значение — последняя точка по времени (или первая строка),
 * искра — вся история. Второй показатель в `y` — база сравнения.
 */
function collect(ctx: Ctx): Series {
  const { spec } = ctx
  const y = spec.encoding.y[0] as YChannel
  const ref = ctx.field(y.field) as FieldRef
  const xRef = spec.encoding.x ? ctx.field(spec.encoding.x.field) : null
  const baseRef = spec.encoding.y[1] ? ctx.field(spec.encoding.y[1].field) : null
  const points: Series['points'] = []
  for (const row of ctx.result.rows) {
    const value = toNumber(row[ref.index])
    if (value === null) continue
    const raw = xRef ? row[xRef.index] : null
    points.push({ wall: xRef ? toWallClock(raw, ctx.fmt.timezone) : null, raw, value })
  }
  if (xRef) points.sort((a, b) => (a.wall ?? 0) - (b.wall ?? 0))
  const lastRow = xRef ? ctx.result.rows.at(-1) : ctx.result.rows[0]
  const base = baseRef && lastRow ? toNumber(lastRow[baseRef.index]) : null
  const current = (xRef ? points.at(-1) : points[0]) ?? null
  return { y, ref, format: measureFormat(ctx, ref.def, y.format), points, current, base }
}

/** Порог, в который попало значение: наибольший не выше значения. */
function statusOf(ctx: Ctx, value: number | null): ChartColorToken | null {
  if (value === null) return null
  const sorted = [...ctx.spec.options.thresholds].sort((a, b) => a.value - b.value)
  let status: ChartColorToken | null = null
  for (const th of sorted) if (value >= th.value) status = th.color
  return status
}

/** Показатель: значение, дельта со знаком, цель, порог, искра (contracts/chart-spec.md). */
export function buildNumber(ctx: Ctx): { model: NumberTileModel; table: ChartTableModel } {
  const { spec, t } = ctx
  const s = collect(ctx)
  const last = s.current
  const value = last?.value ?? null
  const mode = spec.options.comparison?.mode ?? null
  const target = spec.options.target ?? null

  // База сравнения: второй показатель, прошлый период ряда или тот же период год назад
  let base: number | null = s.base
  if (base === null && mode === 'previous_period' && s.points.length >= 2) {
    base = s.points.at(-2)?.value ?? null
  }
  if (base === null && mode === 'previous_year' && last?.wall != null) {
    const wanted = previousYear(last.wall)
    base = s.points.find((p) => p.wall === wanted)?.value ?? null
  }
  if (mode === 'target' && target !== null) base = target

  let delta: NumberTileModel['delta'] = null
  if (value !== null && base !== null && mode) {
    const diff = value - base
    const relative = base !== 0 ? diff / Math.abs(base) : null
    const direction = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat'
    const good =
      direction === 'flat' ? null : (direction === 'up') === (ctx.direction === 'higher_better')
    const sign = diff > 0 ? '+' : diff < 0 ? '−' : ''
    const formatted =
      relative !== null
        ? `${sign}${formatPercent(Math.abs(relative), { precision: 1 }, ctx.fmt)}`
        : `${sign}${s.format.full(Math.abs(diff))}`
    delta = {
      value: relative ?? diff,
      formatted,
      direction,
      good,
      label: t(`ui.chart.delta.${mode}`),
    }
  }

  const format = (v: number) =>
    Math.abs(v) >= 1_000_000 && s.ref.def.type !== 'percent'
      ? formatCompactNumber(v, ctx.fmt, {
          threshold: 1_000_000,
          format: spec.encoding.y[0]?.format,
        })
      : s.format.full(v)

  const model: NumberTileModel = {
    label: ctx.label(s.y),
    value,
    formatted: value === null ? t('ui.chart.none') : format(value),
    unit: spec.options.axes.y?.unit ?? null,
    delta,
    target:
      target !== null && value !== null
        ? {
            value: target,
            formatted: format(target),
            progress: target !== 0 ? value / target : 0,
            label: t('ui.chart.targetValue', { value: format(target) }),
          }
        : null,
    status: statusOf(ctx, value),
    spark: spec.encoding.x && s.points.length >= 2 ? s.points.map((p) => p.value) : [],
  }

  const bucket = detectBucket(s.points.map((p) => p.wall).filter((w): w is number => w !== null))
  const xRef = spec.encoding.x ? ctx.field(spec.encoding.x.field) : null
  const table: ChartTableModel = xRef
    ? {
        caption: '',
        columns: [
          { key: xRef.def.name, label: ctx.label(spec.encoding.x), numeric: false },
          { key: s.y.field, label: model.label, numeric: true },
        ],
        rows: s.points.map((p) => [
          bucket && p.wall !== null
            ? periodLabel(ctx, p.wall, bucket)
            : categoryLabel(ctx, p.raw, xRef.def),
          s.format.full(p.value),
        ]),
        total: s.points.length,
      }
    : {
        caption: '',
        columns: [
          { key: 'label', label: ctx.t('ui.chart.value'), numeric: false },
          { key: s.y.field, label: model.label, numeric: true },
        ],
        rows: [[model.label, value === null ? '' : s.format.full(value)]],
        total: 1,
      }
  return { model, table }
}

/**
 * Шкала: дуга с прогрессом до значения; с порогами — полосы цветов порогов и
 * стрелка. Максимум — из оси, иначе «круглое» число выше значения и цели.
 */
export function buildGauge(ctx: Ctx): Built {
  const { spec, theme, t } = ctx
  const s = collect(ctx)
  const value = s.current?.value ?? 0
  const target = spec.options.target ?? null
  const axes = spec.options.axes.y
  const min = axes?.min ?? 0
  const top = Math.max(value, target ?? 0, min + 1)
  const max = axes?.max ?? Math.ceil((top * 1.1) / niceStep(top / 5)) * niceStep(top / 5)
  const thresholds = [...spec.options.thresholds].sort((a, b) => a.value - b.value)
  const fraction = (v: number) => Math.min(1, Math.max(0, (v - min) / (max - min || 1)))
  const bands: [number, string][] = []
  if (thresholds.length) {
    let color = theme.grid
    for (const th of thresholds) {
      bands.push([fraction(th.value), color])
      color = theme.tokens[th.color]
    }
    bands.push([1, color])
  } else {
    bands.push([1, theme.grid])
  }
  const fill = tokenColor(ctx, s.y.color) ?? (theme.categorical[0] as string)
  const label = ctx.label(s.y)
  const option = {
    ...baseOption(ctx),
    series: [
      {
        type: 'gauge',
        min,
        max,
        startAngle: 210,
        endAngle: -30,
        radius: '88%',
        center: ['50%', '56%'],
        progress: {
          show: thresholds.length === 0,
          width: 12,
          roundCap: true,
          itemStyle: { color: fill },
        },
        axisLine: { roundCap: thresholds.length === 0, lineStyle: { width: 12, color: bands } },
        pointer: thresholds.length
          ? { show: true, length: '58%', width: 4, itemStyle: { color: theme.text } }
          : { show: false },
        anchor: thresholds.length
          ? {
              show: true,
              size: 12,
              itemStyle: { color: theme.text, borderColor: theme.surface, borderWidth: 2 },
            }
          : { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          show: true,
          distance: 18,
          color: theme.textMuted,
          fontSize: 11,
          formatter: (v: number) => (v === min || v === max ? s.format.axis(v) : ''),
        },
        splitNumber: 1,
        title: {
          show: true,
          offsetCenter: [0, '34%'],
          color: theme.textSecondary,
          fontSize: 12,
          fontFamily: theme.fontFamily,
        },
        detail: {
          valueAnimation: ctx.animation,
          offsetCenter: [0, '6%'],
          color: theme.text,
          fontSize: 28,
          fontWeight: 600,
          fontFamily: theme.fontFamily,
          formatter: () => s.format.full(value),
        },
        data: [
          {
            value,
            name:
              target !== null
                ? `${label}\n${t('ui.chart.targetValue', { value: s.format.full(target) })}`
                : label,
          },
        ],
      },
    ],
  } as unknown as EChartsOption

  const table: ChartTableModel = {
    caption: '',
    columns: [
      { key: 'label', label: t('ui.chart.value'), numeric: false },
      { key: s.y.field, label, numeric: true },
    ],
    rows: [
      [label, s.format.full(value)],
      ...(target !== null ? [[t('ui.chart.target'), s.format.full(target)]] : []),
    ],
    total: target !== null ? 2 : 1,
  }
  return { option, table, pick: () => null, brush: () => null }
}
