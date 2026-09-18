import type { FieldFormat, QueryResultField } from '@kchs/contracts'
import {
  formatCompactNumber,
  formatDuration,
  formatNumber,
  formatPercent,
  formatPeriod,
  formatValue,
  type PeriodBucket,
} from '@kchs/fields'
import type { Ctx } from './model.js'

/** Форматы значения показателя: полный (тултип, таблица) и компактный (ось). */
export interface MeasureFormat {
  full(value: number | null | undefined): string
  axis(value: number): string
}

/**
 * Формат показателя по полю результата и каналу: формат канала важнее формата
 * поля. Проценты, длительности, деньги — форматтерами `@kchs/fields`.
 */
export function measureFormat(
  ctx: Ctx,
  field: QueryResultField | null | undefined,
  channelFormat?: FieldFormat | null,
): MeasureFormat {
  const format: FieldFormat = { ...(field?.format ?? {}), ...(channelFormat ?? {}) }
  const type = field?.type
  if (type === 'percent') {
    return {
      full: (v) => (v === null || v === undefined ? '' : formatPercent(v, format, ctx.fmt)),
      axis: (v) => formatPercent(v, { ...format, precision: 0 }, ctx.fmt),
    }
  }
  if (type === 'duration') {
    return {
      full: (v) => (v === null || v === undefined ? '' : formatDuration(v, ctx.fmt)),
      axis: (v) => formatDuration(v, ctx.fmt),
    }
  }
  return {
    full: (v) => (v === null || v === undefined ? '' : formatNumber(v, format, ctx.fmt)),
    axis: (v) =>
      formatCompactNumber(v, ctx.fmt, { format: { prefix: format.prefix, suffix: format.suffix } }),
  }
}

/** Доля 0…1 → «42,5 %». */
export function shareFormat(ctx: Ctx, value: number, precision = 1): string {
  return formatPercent(value, { precision }, ctx.fmt)
}

/** Подпись значения измерения: даты, логические, числа — по типу поля. */
export function categoryLabel(
  ctx: Ctx,
  value: unknown,
  field: QueryResultField | null | undefined,
): string {
  if (value === null || value === undefined || value === '') return ctx.t('ui.chart.none')
  if (field) {
    const out = formatValue(value, { type: field.type, format: field.format ?? undefined }, ctx.fmt)
    if (out) return out
  }
  return String(value)
}

/** Полная подпись периода (тултип, таблица) по настенному моменту. */
export function periodLabel(ctx: Ctx, wall: number, bucket: PeriodBucket): string {
  return formatPeriod(new Date(wall), bucket, { locale: ctx.locale, timezone: 'UTC' })
}

/**
 * Подпись деления оси времени: старший разряд — только на первом делении и на
 * границе (январь показывает год, полночь — дату), остальные — коротко.
 */
export function periodTick(ctx: Ctx, wall: number, bucket: PeriodBucket, first: boolean): string {
  const d = new Date(wall)
  const utc = { locale: ctx.locale, timezone: 'UTC' }
  switch (bucket) {
    case 'year':
      return formatPeriod(d, 'year', utc)
    case 'quarter':
      return formatPeriod(d, 'quarter', utc, { compact: !first && d.getUTCMonth() !== 0 })
    case 'month':
      if (first) return formatPeriod(d, 'month', utc)
      return d.getUTCMonth() === 0
        ? formatPeriod(d, 'year', utc)
        : formatPeriod(d, 'month', utc, { compact: true })
    case 'week':
    case 'day':
      return formatPeriod(d, 'day', utc, { compact: !first })
    case 'hour':
      if (first || d.getUTCHours() === 0) return formatPeriod(d, 'hour', utc)
      return formatPeriod(d, 'hour', utc, { compact: true })
  }
}

/** Гранулярность подписей оси по охвату непериодического ряда. */
export function bucketForSpan(span: number): PeriodBucket {
  const day = 86_400_000
  if (span > 3 * 365 * day) return 'year'
  if (span > 90 * day) return 'month'
  if (span > 3 * day) return 'day'
  return 'hour'
}
