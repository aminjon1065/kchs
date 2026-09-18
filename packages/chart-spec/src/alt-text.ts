import type { ChartSpec, Locale, QueryResult } from '@kchs/contracts'
import { categoryLabel, measureFormat, periodLabel } from './format.js'
import { type CompileOptions, type Ctx, createCtx } from './model.js'
import type { ChartTheme } from './theme.js'
import { detectBucket, toNumber, toWallClock } from './values.js'

/** Описанию цвета не нужны — тема-заглушка для контекста. */
const NO_THEME: ChartTheme = {
  mode: 'light',
  fontFamily: '',
  categorical: [],
  other: '',
  sequential: [],
  diverging: [],
  tokens: { accent: '', success: '', warning: '', danger: '', info: '', neutral: '', purple: '' },
  text: '',
  textSecondary: '',
  textMuted: '',
  textInverse: '',
  surface: '',
  overlay: '',
  grid: '',
  axis: '',
  shadow: '',
}

/** Подпись значения оси X в строке: период, дата или категория. */
function xTitle(ctx: Ctx, raw: unknown, bucket: ReturnType<typeof detectBucket>): string {
  const x = ctx.spec.encoding.x
  const ref = ctx.field(x?.field)
  if (!ref) return ''
  const wall = bucket ? toWallClock(raw, ctx.fmt.timezone) : null
  if (bucket && wall !== null) return periodLabel(ctx, wall, bucket)
  return categoryLabel(ctx, raw, ref.def)
}

/** Описание для экранных дикторов в контексте компиляции. */
export function describe(ctx: Ctx): string {
  const { spec, result, t } = ctx
  const enc = spec.encoding
  const type = t(`ui.chart.types.${spec.type}`)
  if (result.rows.length === 0) return t('ui.chart.alt.empty', { type })

  if (spec.type === 'table' || spec.type === 'pivot') {
    return t('ui.chart.alt.table', {
      type,
      count: result.rowCount ?? result.rows.length,
      columns: result.fields.map((f) => ctx.label({ field: f.name })).join(', '),
    })
  }

  const y = enc.y[0]
  const yRef = ctx.field(y?.field)
  const format = measureFormat(ctx, yRef?.def, y?.format)

  if (spec.type === 'number' || spec.type === 'gauge') {
    const values = yRef
      ? result.rows.map((row) => toNumber(row[yRef.index])).filter((v): v is number => v !== null)
      : []
    const value = spec.encoding.x ? values.at(-1) : values[0]
    return t('ui.chart.alt.number', {
      type,
      label: ctx.label(y),
      value: value === undefined ? t('ui.chart.none') : format.full(value),
    })
  }

  const measureChannels = spec.type === 'histogram' ? [enc.x ?? y] : enc.y
  const measures = measureChannels
    .filter((c) => c !== undefined && c !== null)
    .map((c) => ctx.label(c))
    .join(', ')
  const parts: string[] = []
  let head = t('ui.chart.alt.summary', { type, measures })
  if (enc.x && spec.type !== 'histogram')
    head += ` ${t('ui.chart.alt.axis', { field: ctx.label(enc.x) })}`
  parts.push(head)

  const colorCh = enc.color && 'field' in enc.color ? enc.color : null
  const colorRef = ctx.field(colorCh?.field)
  if (colorCh && colorRef) {
    const distinct = new Set(result.rows.map((row) => String(row[colorRef.index] ?? '')))
    parts.push(t('ui.chart.alt.series', { count: distinct.size, field: ctx.label(colorCh) }))
  }

  if (yRef && spec.type !== 'histogram') {
    let min: number | null = null
    let max: number | null = null
    let maxRow: unknown[] | null = null
    let count = 0
    for (const row of result.rows) {
      const v = toNumber(row[yRef.index])
      if (v === null) continue
      count += 1
      if (min === null || v < min) min = v
      if (max === null || v > max) {
        max = v
        maxRow = row
      }
    }
    if (count > 0 && min !== null && max !== null) {
      parts.push(
        `${t('ui.chart.alt.points', { count })} ${t('ui.chart.alt.range', {
          min: format.full(min),
          max: format.full(max),
        })}`,
      )
      const xRef = ctx.field(enc.x?.field)
      if (maxRow && (xRef || colorRef)) {
        const walls = xRef
          ? result.rows.map((row) => toWallClock(row[xRef.index], ctx.fmt.timezone))
          : []
        const temporal =
          enc.x?.type === 'temporal' || xRef?.def.type === 'date' || xRef?.def.type === 'datetime'
        const bucket = temporal ? detectBucket(walls.filter((w): w is number => w !== null)) : null
        const where = [
          xRef ? xTitle(ctx, maxRow[xRef.index], bucket) : null,
          colorRef ? categoryLabel(ctx, maxRow[colorRef.index], colorRef.def) : null,
        ]
          .filter(Boolean)
          .join(', ')
        parts.push(t('ui.chart.alt.max', { label: where, value: format.full(max) }))
      }
    }
  } else if (spec.type === 'histogram') {
    parts.push(t('ui.chart.alt.points', { count: result.rows.length }))
  }
  return `${parts.join('; ')}.`
}

/**
 * Alt-текст графика из спецификации и данных (contracts/chart-spec.md, доступность):
 * тип, показатели, ось, серии, число значений, диапазон и наибольшее значение.
 */
export function chartAltText(
  spec: ChartSpec,
  result: QueryResult,
  locale: Locale = 'ru',
  options: Pick<CompileOptions, 'timezone'> = {},
): string {
  return describe(createCtx(spec, result, NO_THEME, { locale, timezone: options.timezone }))
}
