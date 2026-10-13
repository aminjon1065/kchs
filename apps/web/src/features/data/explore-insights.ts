import type {
  ChartType,
  DatasetField,
  ExploreCompare,
  ExploreGroup,
  ExplorePeriod,
  ExplorePlan,
  FilterNode,
  TimeBucket,
} from '@kchs/contracts'
import { NUMERIC_TYPES } from './field-types.js'

/**
 * Подсказки «Исследования» для аналитика (ADR-0217): с чего начать по схеме
 * датасета, готовые вопросы, периоды сравнения и условия детализации. Чистые
 * функции — их проверяют unit-тесты и ими пользуются обзор и конструктор.
 */

/** Вид поля для аналитика: от него зависят мини-профиль, вопрос и разрез. */
export type FieldKind = 'number' | 'time' | 'territory' | 'category' | 'geometry' | 'other'

// Идентификатор строки в разрез не годится: у каждой строки своё значение
const CATEGORY_TYPES = new Set(['select', 'text', 'boolean', 'user', 'unit', 'object_ref'])

export function fieldKind(field: DatasetField): FieldKind {
  if (NUMERIC_TYPES.has(field.type)) return 'number'
  if (field.type === 'date' || field.type === 'datetime') return 'time'
  if (field.type === 'territory') return 'territory'
  if (field.type === 'geometry') return 'geometry'
  if (CATEGORY_TYPES.has(field.type) || field.lookup) return 'category'
  return 'other'
}

/** Поля, которые аналитик видит в обзоре: служебные — нет. */
export function analysisFields(fields: readonly DatasetField[]): DatasetField[] {
  return fields.filter((field) => field.semantic !== 'system' && !field.key.startsWith('_'))
}

type DatasetShape = {
  fields: readonly DatasetField[]
  timeField: string | null
  territoryField: string | null
  primaryKey?: readonly string[]
}

/** Поле времени датасета: объявленное или первое поле даты. */
export function timeFieldOf(dataset: DatasetShape): DatasetField | null {
  const fields = analysisFields(dataset.fields)
  return (
    fields.find((field) => field.key === dataset.timeField && fieldKind(field) === 'time') ??
    fields.find((field) => fieldKind(field) === 'time') ??
    null
  )
}

export function territoryFieldOf(dataset: DatasetShape): DatasetField | null {
  const fields = analysisFields(dataset.fields)
  return (
    fields.find((field) => field.key === dataset.territoryField && field.type === 'territory') ??
    fields.find((field) => field.type === 'territory') ??
    null
  )
}

/**
 * Категории для разреза: не идентификаторы и не поля ключа строки. Первыми — размеченные
 * категорией, справочные и с вариантами значений: свободный текст реже годится в разрез.
 */
export function categoryFieldsOf(dataset: DatasetShape): DatasetField[] {
  const key = new Set(dataset.primaryKey ?? [])
  const fields = analysisFields(dataset.fields).filter(
    (field) =>
      fieldKind(field) === 'category' && field.semantic !== 'identifier' && !key.has(field.key),
  )
  const rank = (field: DatasetField) =>
    field.semantic === 'category' ||
    field.type === 'select' ||
    field.lookup ||
    (field.options?.length ?? 0) > 0
      ? 0
      : 1
  return [...fields].sort((a, b) => rank(a) - rank(b))
}

export function numericFieldsOf(dataset: DatasetShape): DatasetField[] {
  return analysisFields(dataset.fields).filter(
    (field) => fieldKind(field) === 'number' && field.semantic !== 'identifier',
  )
}

const plan = (patch: Partial<ExplorePlan>): ExplorePlan => ({
  filter: null,
  groups: [],
  measures: [{ agg: 'count' }],
  sort: null,
  limit: null,
  ...patch,
})

/**
 * Умный старт конструктора: по времени — количество по месяцам, иначе — первая
 * категория или территория, топ-20 по убыванию. Голое «количество» — только у
 * датасета без подходящих полей.
 */
export function smartPlan(dataset: DatasetShape): ExplorePlan {
  const time = timeFieldOf(dataset)
  if (time) {
    return plan({
      groups: [{ field: time.key, bucket: 'month' }],
      sort: { field: `${time.key}_month`, dir: 'asc' },
    })
  }
  const by = territoryFieldOf(dataset) ?? categoryFieldsOf(dataset)[0]
  if (by)
    return plan({ groups: [{ field: by.key }], sort: { field: 'count', dir: 'desc' }, limit: 20 })
  return plan({})
}

/** Готовый вопрос обзора: план, вид результата и подпись (ключ словаря с полями). */
export interface ExploreQuestion {
  id: string
  title: { key: string; params: Record<string, string> }
  plan: ExplorePlan
  view: 'chart' | 'table' | 'map'
  chartType: ChartType | null
}

type Label = (field: DatasetField) => string

/**
 * Вопросы из схемы: динамика, топ по категории, по районам (и на карте), сравнение
 * периода с предыдущим, главный числовой показатель по времени. `anchor` — последняя
 * дата в данных: сравнение берётся у конца данных, а не у сегодняшнего дня.
 */
export function exploreQuestions(
  dataset: DatasetShape,
  label: Label,
  anchor: string | null,
): ExploreQuestion[] {
  const questions: ExploreQuestion[] = []
  const time = timeFieldOf(dataset)
  const territory = territoryFieldOf(dataset)
  const categories = categoryFieldsOf(dataset)
  const numbers = numericFieldsOf(dataset)
  if (time) {
    questions.push({
      id: 'trend',
      title: { key: 'data.explore.questions.trend', params: { field: label(time) } },
      plan: smartPlan(dataset),
      view: 'chart',
      chartType: 'line',
    })
  }
  for (const category of categories.slice(0, 2)) {
    questions.push({
      id: `top:${category.key}`,
      title: { key: 'data.explore.questions.top', params: { field: label(category) } },
      plan: plan({
        groups: [{ field: category.key }],
        sort: { field: 'count', dir: 'desc' },
        limit: 10,
      }),
      view: 'chart',
      chartType: 'bar',
    })
  }
  if (territory) {
    const byTerritory = plan({
      groups: [{ field: territory.key }],
      sort: { field: 'count', dir: 'desc' },
    })
    questions.push({
      id: 'territory',
      title: { key: 'data.explore.questions.territory', params: { field: label(territory) } },
      plan: byTerritory,
      view: 'chart',
      chartType: 'bar',
    })
    questions.push({
      id: 'map',
      title: { key: 'data.explore.questions.map', params: { field: label(territory) } },
      plan: byTerritory,
      view: 'map',
      chartType: null,
    })
  }
  if (time) {
    const by = territory ?? categories[0]
    const periods = comparePeriods('year', anchor ?? today())
    questions.push({
      id: 'compare',
      title: {
        key: by ? 'data.explore.questions.compareBy' : 'data.explore.questions.compare',
        params: { field: by ? label(by) : '', period: periods.current.from.slice(0, 4) },
      },
      plan: plan({
        groups: by ? [{ field: by.key }] : [],
        compare: { field: time.key, ...periods },
        sort: by ? { field: 'count_cur', dir: 'desc' } : null,
      }),
      view: 'table',
      chartType: null,
    })
  }
  const number = numbers[0]
  if (number) {
    const groups: ExploreGroup[] = time
      ? [{ field: time.key, bucket: 'month' }]
      : territory
        ? [{ field: territory.key }]
        : []
    questions.push({
      id: `sum:${number.key}`,
      title: { key: 'data.explore.questions.sum', params: { field: label(number) } },
      plan: plan({
        groups,
        measures: [
          { agg: 'sum', field: number.key },
          { agg: 'avg', field: number.key },
        ],
        sort: time ? { field: `${time.key}_month`, dir: 'asc' } : null,
      }),
      view: 'chart',
      chartType: time ? 'line' : 'bar',
    })
  }
  return questions
}

/** Вопрос по карточке поля в обзоре: разрез по нему или его сумма. */
export function fieldQuestionPlan(dataset: DatasetShape, field: DatasetField): ExplorePlan {
  const kind = fieldKind(field)
  if (kind === 'time') {
    return plan({
      groups: [{ field: field.key, bucket: 'month' }],
      sort: { field: `${field.key}_month`, dir: 'asc' },
    })
  }
  if (kind === 'number') {
    const time = timeFieldOf(dataset)
    return plan({
      groups: time ? [{ field: time.key, bucket: 'month' }] : [],
      measures: [
        { agg: 'sum', field: field.key },
        { agg: 'avg', field: field.key },
      ],
      sort: time ? { field: `${time.key}_month`, dir: 'asc' } : null,
    })
  }
  if (kind === 'territory' || kind === 'category') {
    return plan({
      groups: [{ field: field.key }],
      sort: { field: 'count', dir: 'desc' },
      limit: 20,
    })
  }
  return smartPlan(dataset)
}

// ─── Периоды сравнения ────────────────────────────────────────────────────────

export const COMPARE_PRESETS = ['month', 'quarter', 'year', 'ytd'] as const
export type ComparePreset = (typeof COMPARE_PRESETS)[number]

const iso = (date: Date) => date.toISOString().slice(0, 10)

export function today(): string {
  return iso(new Date())
}

const utc = (year: number, month: number, day: number) => new Date(Date.UTC(year, month, day))

/**
 * Периоды пресета у даты-якоря (последней даты в данных): последний полный месяц,
 * квартал или год к предыдущему; «с начала года» — к тому же отрезку прошлого года.
 * Неполный текущий месяц с полным прошлым не сравнивается: это вводит в заблуждение.
 */
export function comparePeriods(
  preset: ComparePreset,
  anchor: string,
): { current: ExplorePeriod; previous: ExplorePeriod } {
  const at = new Date(`${anchor.slice(0, 10)}T00:00:00Z`)
  const y = at.getUTCFullYear()
  const m = at.getUTCMonth()
  const lastDay = (year: number, month: number) => iso(utc(year, month + 1, 0))
  // Отрезок «целиком» — если якорь стоит на последнем дне периода, иначе берётся предыдущий
  const complete = (end: Date) => iso(end) <= iso(at)
  switch (preset) {
    case 'month': {
      const endsHere = complete(utc(y, m + 1, 0))
      const cm = endsHere ? m : m - 1
      return {
        current: { from: iso(utc(y, cm, 1)), to: lastDay(y, cm) },
        previous: { from: iso(utc(y, cm - 1, 1)), to: iso(utc(y, cm, 0)) },
      }
    }
    case 'quarter': {
      const q = Math.floor(m / 3)
      const endsHere = complete(utc(y, q * 3 + 3, 0))
      const cq = endsHere ? q : q - 1
      return {
        current: { from: iso(utc(y, cq * 3, 1)), to: iso(utc(y, cq * 3 + 3, 0)) },
        previous: { from: iso(utc(y, cq * 3 - 3, 1)), to: iso(utc(y, cq * 3, 0)) },
      }
    }
    case 'year': {
      const endsHere = complete(utc(y, 12, 0))
      const cy = endsHere ? y : y - 1
      return {
        current: { from: `${cy}-01-01`, to: `${cy}-12-31` },
        previous: { from: `${cy - 1}-01-01`, to: `${cy - 1}-12-31` },
      }
    }
    case 'ytd': {
      const day = at.getUTCDate()
      // 29 февраля в прошлом году — последний день февраля
      const prevEnd = utc(y - 1, m, m === 1 && day === 29 ? 28 : day)
      return {
        current: { from: `${y}-01-01`, to: iso(at) },
        previous: { from: `${y - 1}-01-01`, to: iso(prevEnd) },
      }
    }
  }
}

/** Пресет, которому соответствуют периоды сравнения; иначе — «произвольно». */
export function presetOf(compare: ExploreCompare, anchor: string): ComparePreset | 'custom' {
  for (const preset of COMPARE_PRESETS) {
    const periods = comparePeriods(preset, anchor)
    if (
      periods.current.from === compare.current.from &&
      periods.current.to === compare.current.to &&
      periods.previous.from === compare.previous.from &&
      periods.previous.to === compare.previous.to
    ) {
      return preset
    }
  }
  return 'custom'
}

// ─── Детализация ─────────────────────────────────────────────────────────────

/** Начало следующего интервала — правая граница детализации по времени. */
function bucketEnd(bucket: TimeBucket, start: Date): Date {
  const next = new Date(start)
  switch (bucket) {
    case 'year':
      next.setUTCFullYear(next.getUTCFullYear() + 1)
      break
    case 'quarter':
      next.setUTCMonth(next.getUTCMonth() + 3)
      break
    case 'month':
      next.setUTCMonth(next.getUTCMonth() + 1)
      break
    case 'week':
      next.setUTCDate(next.getUTCDate() + 7)
      break
    case 'day':
      next.setUTCDate(next.getUTCDate() + 1)
      break
    case 'hour':
      next.setUTCHours(next.getUTCHours() + 1)
      break
  }
  return next
}

/**
 * Условие для значения разреза: интервал времени — диапазоном, территория —
 * «внутри» с вложенными (область → её районы), прочее — равенством; пусто — «не задано».
 */
export function groupValueFilter(
  group: ExploreGroup,
  field: DatasetField | undefined,
  value: unknown,
): FilterNode {
  if (value === null || value === undefined || value === '') {
    return { field: group.field, op: 'is_empty' }
  }
  if (group.bucket) {
    const start = new Date(String(value))
    if (!Number.isNaN(start.getTime())) {
      const end = bucketEnd(group.bucket, start)
      return {
        and: [
          { field: group.field, op: 'gte', value: start.toISOString() },
          { field: group.field, op: 'lt', value: end.toISOString() },
        ],
      }
    }
  }
  if (field?.type === 'territory') {
    return { field: group.field, op: 'within', value: { id: String(value), includeChildren: true } }
  }
  return { field: group.field, op: 'eq', value: value as string | number | boolean }
}

/** Добавить условие к фильтру плана — через «и». */
export function andFilter(current: FilterNode | null, next: FilterNode): FilterNode {
  if (!current) return next
  if ('and' in current) return { and: [...current.and, next] }
  return { and: [current, next] }
}
