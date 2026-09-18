import {
  ASK_CHART_TYPES,
  type ChartType,
  type DatasetField,
  type ExploreGroup,
  type ExploreMeasure,
  ExplorePlan,
  type FilterCondition,
  type FilterNode,
  measureAlias,
  TIME_BUCKETS,
} from '@kchs/contracts'
import { z } from 'zod'

/**
 * «Спросить данные» v1 (P1-E09 S03, ADR-0061): ответ модели — плоский план
 * без рекурсии (структурированный вывод провайдеров её не поддерживает):
 * условия через И, разрезы, меры, сортировка, лимит и тип графика. Сервер
 * переводит его в план «Исследования» и проверяет по схеме, видимой
 * пользователю; дальше — компилятор запросов с политиками.
 */
export const ASK_AGGREGATES = [
  'count',
  'count_distinct',
  'sum',
  'avg',
  'min',
  'max',
  'median',
] as const

export const ASK_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
  'in',
  'not_in',
  'is_empty',
  'not_empty',
  'is_true',
  'is_false',
  'relative',
] as const

const Scalar = z.union([z.string(), z.number(), z.boolean()])

const AskCondition = z.object({
  field: z.string(),
  op: z.enum(ASK_OPERATORS),
  /** Одно значение сравнения; `null` — для операций без значения и списков. */
  value: Scalar.nullable(),
  /** Список для `in`/`not_in` и пара [от, до] для `between`. */
  values: z.array(Scalar).nullable(),
  /** Период относительно текущего для `relative`: 0 — текущий, -1 — прошлый. */
  relative: z
    .object({
      unit: z.enum(['day', 'week', 'month', 'quarter', 'year']),
      from: z.number().int(),
      to: z.number().int(),
    })
    .nullable(),
})

export const AskAnswer = z.object({
  answerable: z.boolean(),
  /** Почему на вопрос не ответить по этому датасету; пусто, если можно. */
  reason: z.string(),
  title: z.string(),
  explanation: z.string(),
  conditions: z.array(AskCondition),
  groups: z.array(z.object({ field: z.string(), bucket: z.enum(TIME_BUCKETS).nullable() })),
  measures: z.array(z.object({ agg: z.enum(ASK_AGGREGATES), field: z.string().nullable() })),
  sort: z.object({ by: z.string(), dir: z.enum(['asc', 'desc']) }).nullable(),
  limit: z.number().int().nullable(),
  chart: z.enum(ASK_CHART_TYPES),
})
export type AskAnswer = z.infer<typeof AskAnswer>

export type AskConversion =
  | { ok: true; plan: ExplorePlan; chart: ChartType; title: string; explanation: string }
  | { ok: false; kind: 'unanswerable'; message: string }
  | { ok: false; kind: 'invalid'; issues: string[] }

const NUMERIC = new Set<string>(['integer', 'number', 'decimal', 'money', 'percent'])
const TEMPORAL = new Set<string>(['date', 'datetime'])
/** Типы, которые модель не видит: значения не сравниваются и не группируются осмысленно. */
const UNASKABLE = new Set<string>([
  'geometry',
  'json',
  'file',
  'signature',
  'formula',
  'lookup',
  'rollup',
])
const NO_VALUE = new Set<string>(['is_empty', 'not_empty', 'is_true', 'is_false'])
const MAX_LIMIT = 50_000

/** Поля, о которых можно спрашивать: не скрытые и не маскированные политикой. */
export function askableFields(
  fields: readonly DatasetField[],
  hidden: ReadonlySet<string>,
  masked: ReadonlySet<string>,
): DatasetField[] {
  return fields.filter(
    (field) => !hidden.has(field.key) && !masked.has(field.key) && !UNASKABLE.has(field.type),
  )
}

/**
 * Ответ модели → план «Исследования». Поля — только из видимой схемы: чужое
 * имя поля (в том числе скрытого политикой) — «нет такого поля», без подсказок.
 */
export function answerToPlan(answer: AskAnswer, fields: readonly DatasetField[]): AskConversion {
  if (!answer.answerable) {
    return { ok: false, kind: 'unanswerable', message: answer.reason.trim().slice(0, 500) }
  }
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const issues: string[] = []
  const fieldOf = (key: string, path: string): DatasetField | undefined => {
    const field = byKey.get(key)
    if (!field) issues.push(`${path}: нет поля «${key.slice(0, 64)}»`)
    return field
  }

  const conditions: FilterCondition[] = []
  answer.conditions.forEach((condition, index) => {
    const path = `conditions.${index}`
    const field = fieldOf(condition.field, path)
    if (!field) return
    const { op } = condition
    if (NO_VALUE.has(op)) {
      conditions.push({ field: field.key, op })
    } else if (op === 'in' || op === 'not_in') {
      const values = condition.values ?? (condition.value === null ? [] : [condition.value])
      if (values.length === 0) issues.push(`${path}: для «${op}» нужен список значений`)
      else conditions.push({ field: field.key, op, value: values })
    } else if (op === 'between') {
      if (condition.values?.length !== 2) issues.push(`${path}: для «between» нужна пара [от, до]`)
      else conditions.push({ field: field.key, op, value: condition.values })
    } else if (op === 'relative') {
      if (!condition.relative) issues.push(`${path}: для «relative» нужен период`)
      else conditions.push({ field: field.key, op, value: condition.relative })
    } else if (condition.value === null) {
      issues.push(`${path}: для «${op}» нужно значение`)
    } else {
      conditions.push({ field: field.key, op, value: condition.value })
    }
  })

  const groups: ExploreGroup[] = []
  answer.groups.forEach((group, index) => {
    const field = fieldOf(group.field, `groups.${index}`)
    if (!field) return
    // Интервал — только у дат; у остальных полей модель могла указать его по ошибке
    const bucket = TEMPORAL.has(field.type) ? group.bucket : null
    if (groups.some((item) => item.field === field.key && item.bucket === (bucket ?? undefined))) {
      return
    }
    groups.push(bucket ? { field: field.key, bucket } : { field: field.key })
  })

  const measures: ExploreMeasure[] = []
  answer.measures.forEach((measure, index) => {
    const path = `measures.${index}`
    if (!measure.field) {
      if (measure.agg === 'count') measures.push({ agg: 'count' })
      else issues.push(`${path}: для «${measure.agg}» нужно поле`)
      return
    }
    const field = fieldOf(measure.field, path)
    if (!field) return
    const numeric = NUMERIC.has(field.type)
    if (['sum', 'avg', 'median'].includes(measure.agg) && !numeric) {
      issues.push(`${path}: «${measure.agg}» считается только по числовому полю`)
      return
    }
    if (['min', 'max'].includes(measure.agg) && !numeric && !TEMPORAL.has(field.type)) {
      issues.push(`${path}: «${measure.agg}» — только для чисел и дат`)
      return
    }
    measures.push({ agg: measure.agg, field: field.key })
  })
  // Разрез без меры — это количество строк в каждой группе
  if (groups.length > 0 && measures.length === 0) measures.push({ agg: 'count' })

  if (issues.length > 0) return { ok: false, kind: 'invalid', issues }

  const aggregated = groups.length > 0 || measures.length > 0
  let sort: ExplorePlan['sort'] = null
  if (answer.sort) {
    const aliases = new Set(measures.map(measureAlias))
    let by: string | null = answer.sort.by
    if (aggregated) {
      if (!aliases.has(by) && !groups.some((group) => group.field === by)) {
        // Модель назвала поле меры вместо её алиаса: «amount» → «sum_amount»
        const measure = measures.find((item) => item.field === by)
        by = measure ? measureAlias(measure) : null
      }
    } else if (!byKey.has(by)) {
      by = null
    }
    if (by) sort = { field: by, dir: answer.sort.dir }
  }

  const limit = answer.limit === null ? null : Math.min(Math.max(answer.limit, 1), MAX_LIMIT)

  const parsed = ExplorePlan.safeParse({
    filter:
      conditions.length === 0
        ? null
        : conditions.length === 1
          ? conditions[0]
          : ({ and: conditions } satisfies FilterNode),
    groups,
    measures,
    sort,
    limit,
  })
  if (!parsed.success) {
    return {
      ok: false,
      kind: 'invalid',
      issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    }
  }

  return {
    ok: true,
    plan: parsed.data,
    chart: chartFor(answer.chart, groups.length, measures.length, aggregated),
    title: answer.title.trim().slice(0, 200),
    explanation: answer.explanation.trim().slice(0, 1000),
  }
}

/** График, который можно построить из такого результата. */
function chartFor(
  wanted: AskAnswer['chart'],
  groups: number,
  measures: number,
  aggregated: boolean,
): ChartType {
  if (!aggregated) return 'table'
  if (groups === 0) return measures === 1 ? 'number' : 'table'
  if (wanted === 'number') return 'bar'
  return wanted
}
