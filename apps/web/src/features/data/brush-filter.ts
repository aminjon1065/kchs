import type { ChartFilter } from '@kchs/chart-spec'
import type {
  ChartSpec,
  FieldDef,
  FilterNode,
  Locale,
  QuerySpec,
  TimeBucket,
} from '@kchs/contracts'
import { formatDate, formatDateTime, formatNumber } from '@kchs/fields'

type AggregateStep = Extract<QuerySpec['steps'][number], { type: 'aggregate' }>

/** Имя столбца разреза в результате агрегации — как у компилятора. */
function groupName(group: AggregateStep['groupBy'][number]): string {
  return group.alias ?? (group.bucket ? `${group.field}_${group.bucket}` : group.field)
}

const pad = (n: number) => String(n).padStart(2, '0')
const isoDay = (date: Date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`

/** Последний день интервала, который начинается с `start` (ГГГГ-ММ-ДД). */
export function bucketLastDay(start: string, bucket: Exclude<TimeBucket, 'hour'>): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(start)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
  switch (bucket) {
    case 'day':
      return isoDay(new Date(Date.UTC(year, month, day)))
    case 'week':
      return isoDay(new Date(Date.UTC(year, month, day + 6)))
    case 'month':
      return isoDay(new Date(Date.UTC(year, month + 1, 0)))
    case 'quarter':
      return isoDay(new Date(Date.UTC(year, Math.floor(month / 3) * 3 + 3, 0)))
    case 'year':
      return isoDay(new Date(Date.UTC(year, 12, 0)))
  }
}

/** Начало следующего часа в той же записи (с поясом или без). */
export function nextHour(start: string): string | null {
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(start)
  const time = Date.parse(zoned ? start : `${start}Z`)
  if (Number.isNaN(time)) return null
  const next = new Date(time + 3_600_000).toISOString()
  return zoned ? next : next.replace(/\.\d{3}Z$/, '').replace(/Z$/, '')
}

/**
 * Кисть графика → условие строк датасета для связанных представлений
 * (ADR-0073): диапазон по оси — это разрез агрегации, он переводится в поле
 * датасета; интервал времени (месяц, неделя…) — в даты от начала первого до
 * конца последнего интервала, час — в полуоткрытый интервал моментов.
 * График не по датасету, поле не из датасета, меры — null.
 */
export function brushFilter(
  spec: ChartSpec,
  filter: ChartFilter,
  fields: readonly Pick<FieldDef, 'key'>[],
): FilterNode | null {
  const query = 'query' in spec.data ? spec.data.query : null
  if (query?.source.kind !== 'dataset') return null
  const aggregate = query.steps.find((step): step is AggregateStep => step.type === 'aggregate')
  const group = aggregate?.groupBy.find((item) => groupName(item) === filter.field)
  if (aggregate && !group) return null
  const field = group?.field ?? filter.field
  if (!fields.some((item) => item.key === field)) return null
  const bucket = group?.bucket
  const values = Array.isArray(filter.value) ? filter.value : [filter.value]

  if (filter.op === 'between') {
    const [from, to] = values
    if (from === undefined || to === undefined || from === null || to === null) return null
    if (bucket === 'hour') {
      const end = typeof to === 'string' ? nextHour(to) : null
      if (!end) return null
      return {
        and: [
          { field, op: 'gte', value: from },
          { field, op: 'lt', value: end },
        ],
      }
    }
    if (bucket) {
      const end = typeof to === 'string' ? bucketLastDay(to, bucket) : null
      return end ? { field, op: 'between', value: [from, end] } : null
    }
    return { field, op: 'between', value: [from, to] }
  }
  if (filter.op === 'in' || filter.op === 'eq') {
    if (bucket) {
      // Отдельные интервалы времени — от первого до конца последнего
      const days = values.filter((value): value is string => typeof value === 'string').sort()
      const first = days[0]
      const last = days[days.length - 1]
      if (!first || !last || bucket === 'hour') return null
      const end = bucketLastDay(last, bucket)
      return end ? { field, op: 'between', value: [first, end] } : null
    }
    return { field, op: 'in', value: values }
  }
  return null
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MOMENT = /^\d{4}-\d{2}-\d{2}T/

/** Значение условия для подписи: дата, момент, число или текст. */
function valueText(value: unknown, locale: Locale): string {
  if (typeof value === 'number') return formatNumber(value, {}, { locale })
  if (typeof value === 'string') {
    // Дата без времени — календарный день, без сдвига поясом браузера
    if (DAY.test(value)) return formatDate(value, { locale, timezone: 'UTC' })
    if (MOMENT.test(value)) return formatDateTime(value, { locale })
    return value
  }
  if (value === null || value === undefined) return '—'
  return String(value)
}

/** Подпись условия кисти для чипа потребителя: «Дата: 01.03.2026 – 31.05.2026». */
export function brushLabel(where: FilterNode, name: string, locale: Locale): string {
  const range = (from: unknown, to: unknown) =>
    `${name}: ${valueText(from, locale)} – ${valueText(to, locale)}`
  if ('and' in where) {
    const [from, to] = where.and
    if (from && to && 'value' in from && 'value' in to) return range(from.value, to.value)
  }
  if ('op' in where && Array.isArray(where.value)) {
    if (where.op === 'between') return range(where.value[0], where.value[1])
    const shown = where.value.slice(0, 3).map((value) => valueText(value, locale))
    return `${name}: ${shown.join(', ')}${where.value.length > 3 ? ', …' : ''}`
  }
  return name
}
