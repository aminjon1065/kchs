import { z } from 'zod'
import { FilterNode } from '../common/filter.js'
import { Aggregate, type QuerySpec, type QueryStep, TimeBucket } from './query.js'

/**
 * План «Исследования» (03-screens.md §7): фильтр → сводка (разрезы и меры) →
 * сравнение двух периодов или расчёты над мерами → сортировка → лимит. Его строит
 * конструктор на экране и «Спросить данные» (ADR-0061); QuerySpec из плана — одна
 * функция для клиента и сервера, чтобы одинаковый план давал одинаковый запрос (и
 * попадал в один кэш). Сравнение и расчёты — ADR-0217.
 */
export const ExploreGroup = z.object({
  field: z.string().min(1).max(64),
  bucket: TimeBucket.optional(),
})
export type ExploreGroup = z.infer<typeof ExploreGroup>

export const ExploreMeasure = z
  .object({
    agg: Aggregate,
    /** Без поля — количество строк. */
    field: z.string().min(1).max(64).optional(),
    /** Вычисляемая мера (`agg: 'expr'`): выражение над агрегатами — `sum(damage) / count()`. */
    expr: z.string().trim().min(1).max(2000).optional(),
    /** Подпись вычисляемой меры в таблице и легенде. */
    name: z.string().trim().max(120).optional(),
    /** Расчёт над мерой (ADR-0217) — дополнительный столбец рядом с ней. */
    calc: z.enum(['share', 'running', 'rank', 'change', 'change_pct']).optional(),
  })
  .refine((measure) => measure.agg !== 'expr' || Boolean(measure.expr), {
    message: 'Для вычисляемой меры нужно выражение',
    path: ['expr'],
  })
export type ExploreMeasure = z.infer<typeof ExploreMeasure>

/** Расчёты над мерой: доля от итога, накопительный итог, ранг, изменение к предыдущей строке. */
export const EXPLORE_CALCS = ['share', 'running', 'rank', 'change', 'change_pct'] as const
export type ExploreCalc = (typeof EXPLORE_CALCS)[number]

/** Период сравнения: даты включительно, `ГГГГ-ММ-ДД`. */
export const ExplorePeriod = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .refine((period) => period.from <= period.to, {
    message: 'Начало периода позже конца',
    path: ['to'],
  })
export type ExplorePeriod = z.infer<typeof ExplorePeriod>

/**
 * Сравнение двух периодов по полю даты (ADR-0217): каждая мера даёт значение
 * текущего периода, базы сравнения, разницу и изменение в процентах.
 */
export const ExploreCompare = z.object({
  field: z.string().min(1).max(64),
  current: ExplorePeriod,
  previous: ExplorePeriod,
})
export type ExploreCompare = z.infer<typeof ExploreCompare>

export const ExplorePlan = z.object({
  filter: FilterNode.nullable(),
  groups: z.array(ExploreGroup).max(8),
  measures: z.array(ExploreMeasure).max(12),
  /** Сравнение двух периодов; расчёты над мерами при сравнении не применяются. */
  compare: ExploreCompare.nullable().optional(),
  /** Разрез или алиас меры (`measureAlias`); без сводки — любое поле. */
  sort: z.object({ field: z.string().min(1).max(160), dir: z.enum(['asc', 'desc']) }).nullable(),
  limit: z.number().int().min(1).max(50_000).nullable(),
})
export type ExplorePlan = z.infer<typeof ExplorePlan>

/** Строк без сводки — чтобы «сырое» исследование не тянуло весь датасет. */
export const EXPLORE_RAW_LIMIT = 1000

/** Короткий устойчивый отпечаток текста (FNV-1a, 32 бита): один и тот же на клиенте и сервере. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/** Имя столбца разреза в результате: с интервалом — `поле_интервал`, как у компилятора. */
export function groupAlias(group: ExploreGroup): string {
  return group.bucket ? `${group.field}_${group.bucket}` : group.field
}

/** Имя столбца меры в результате: латиница, как требует алиас QuerySpec. */
export function measureAlias(measure: ExploreMeasure): string {
  if (measure.agg === 'expr') return `expr_${fingerprint(measure.expr ?? '')}`
  return measure.field ? `${measure.agg}_${measure.field}` : measure.agg
}

/** Алиас QuerySpec — не длиннее 32 символов: длинное имя укорачивается с отпечатком. */
const MAX_ALIAS = 32

function suffixed(base: string, suffix: string): string {
  const name = `${base}${suffix}`
  if (name.length <= MAX_ALIAS) return name
  const tail = `_${fingerprint(base).slice(0, 5)}${suffix}`
  return `${base.slice(0, MAX_ALIAS - tail.length)}${tail}`
}

/** Части меры при сравнении периодов: текущий, база, разница, изменение в процентах. */
export const COMPARE_PARTS = ['cur', 'prev', 'diff', 'pct'] as const
export type ComparePart = (typeof COMPARE_PARTS)[number]

export function compareAlias(measure: ExploreMeasure, part: ComparePart): string {
  return suffixed(measureAlias(measure), `_${part}`)
}

/** Столбец расчёта над мерой (доля, накопительный итог, ранг, изменение). */
export function calcAlias(measure: ExploreMeasure): string {
  return suffixed(measureAlias(measure), `_${measure.calc ?? 'calc'}`)
}

/** Значение меры в предыдущей строке — основа расчёта изменения. */
export function lagAlias(measure: ExploreMeasure): string {
  return suffixed(measureAlias(measure), '_lag')
}

/**
 * Применим ли расчёт: накопительный итог и изменение идут по порядку первого разреза
 * и без разреза не считаются; при сравнении периодов расчёты не применяются.
 */
export function calcApplies(plan: ExplorePlan, measure: ExploreMeasure): boolean {
  if (!measure.calc || plan.compare) return false
  if (measure.calc === 'share' || measure.calc === 'rank') return true
  return plan.groups.length > 0
}

/** Меры плана без повторов: одна и та же функция над тем же полем дала бы одинаковые алиасы. */
function uniqueMeasures(measures: readonly ExploreMeasure[]): ExploreMeasure[] {
  return [...new Map(measures.map((measure) => [measureAlias(measure), measure])).values()]
}

/** Столбцы результата сводки по порядку; без сводки — пусто (в результате любые поля). */
export function planColumns(plan: ExplorePlan): string[] {
  if (plan.groups.length === 0 && plan.measures.length === 0) return []
  const columns = plan.groups.map(groupAlias)
  for (const measure of uniqueMeasures(plan.measures)) {
    if (plan.compare) {
      columns.push(...COMPARE_PARTS.map((part) => compareAlias(measure, part)))
      continue
    }
    columns.push(measureAlias(measure))
    if (!calcApplies(plan, measure)) continue
    if (measure.calc === 'change' || measure.calc === 'change_pct') columns.push(lagAlias(measure))
    columns.push(calcAlias(measure))
  }
  return columns
}

/** Следующий день после даты `ГГГГ-ММ-ДД` — правая граница периода, не включительно. */
function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}

/** Условие «дата в периоде»: с первого дня включительно до следующего за последним. */
export function periodWhere(field: string, period: ExplorePeriod): FilterNode {
  return {
    and: [
      { field, op: 'gte', value: period.from },
      { field, op: 'lt', value: nextDay(period.to) },
    ],
  }
}

/** Поле в выражении — в кавычках: алиас может совпасть с именем функции (`count`). */
const quoted = (name: string) => `"${name}"`

type WindowField = Extract<QueryStep, { type: 'window' }>['fields'][number]
type ComputeField = Extract<QueryStep, { type: 'compute' }>['fields'][number]

/**
 * Расчёты над мерами (ADR-0217): доля от итога и ранг — по всему результату,
 * накопительный итог и изменение — по порядку первого разреза.
 */
function calcSteps(plan: ExplorePlan, measures: ExploreMeasure[], steps: QueryStep[]): void {
  const first = plan.groups[0]
  const order = first ? [groupAlias(first)] : []
  const window: WindowField[] = []
  const compute: ComputeField[] = []
  for (const measure of measures) {
    if (!calcApplies(plan, measure)) continue
    const alias = measureAlias(measure)
    switch (measure.calc) {
      case 'share':
        window.push({
          alias: calcAlias(measure),
          fn: 'share',
          field: alias,
          partitionBy: [],
          orderBy: [],
        })
        break
      case 'rank':
        window.push({
          alias: calcAlias(measure),
          fn: 'rank',
          partitionBy: [],
          orderBy: [`${alias} desc`],
        })
        break
      case 'running':
        window.push({
          alias: calcAlias(measure),
          fn: 'running_sum',
          field: alias,
          partitionBy: [],
          orderBy: order,
        })
        break
      case 'change':
      case 'change_pct': {
        window.push({
          alias: lagAlias(measure),
          fn: 'lag',
          field: alias,
          n: 1,
          partitionBy: [],
          orderBy: order,
        })
        const value = quoted(alias)
        const previous = quoted(lagAlias(measure))
        compute.push(
          measure.calc === 'change'
            ? { name: calcAlias(measure), expr: `${value} - ${previous}` }
            : {
                name: calcAlias(measure),
                expr: `(${value} - ${previous}) / ${previous}`,
                type: 'percent',
              },
        )
        break
      }
    }
  }
  if (window.length > 0) steps.push({ type: 'window', fields: window })
  if (compute.length > 0) steps.push({ type: 'compute', fields: compute })
}

export function explorePlanSpec(datasetId: string, plan: ExplorePlan): QuerySpec {
  const steps: QueryStep[] = []
  if (plan.filter) steps.push({ type: 'filter', where: plan.filter })
  const aggregated = plan.groups.length > 0 || plan.measures.length > 0
  const compare = aggregated ? (plan.compare ?? null) : null
  if (aggregated) {
    const measures = uniqueMeasures(plan.measures)
    const target = (measure: ExploreMeasure) => ({
      agg: measure.agg,
      ...(measure.agg === 'expr' ? { expr: measure.expr } : {}),
      ...(measure.agg !== 'expr' && measure.field ? { field: measure.field } : {}),
    })
    if (compare) {
      // Строки вне обоих периодов в сводку не попадают — и запрос легче
      steps.push({
        type: 'filter',
        where: {
          or: [
            periodWhere(compare.field, compare.current),
            periodWhere(compare.field, compare.previous),
          ],
        },
      })
    }
    steps.push({
      type: 'aggregate',
      groupBy: plan.groups.map((group) => ({
        field: group.field,
        ...(group.bucket ? { bucket: group.bucket } : {}),
      })),
      measures: compare
        ? measures.flatMap((measure) => [
            {
              alias: compareAlias(measure, 'cur'),
              ...target(measure),
              filter: periodWhere(compare.field, compare.current),
            },
            {
              alias: compareAlias(measure, 'prev'),
              ...target(measure),
              filter: periodWhere(compare.field, compare.previous),
            },
          ])
        : measures.map((measure) => ({ alias: measureAlias(measure), ...target(measure) })),
    })
    if (compare) {
      steps.push({
        type: 'compute',
        fields: measures.flatMap((measure): ComputeField[] => {
          const cur = quoted(compareAlias(measure, 'cur'))
          const prev = quoted(compareAlias(measure, 'prev'))
          return [
            { name: compareAlias(measure, 'diff'), expr: `${cur} - ${prev}` },
            {
              name: compareAlias(measure, 'pct'),
              expr: `(${cur} - ${prev}) / ${prev}`,
              type: 'percent',
            },
          ]
        }),
      })
    } else {
      calcSteps(plan, measures, steps)
    }
  }
  if (plan.sort) steps.push({ type: 'sort', by: [{ field: plan.sort.field, dir: plan.sort.dir }] })
  const limit = plan.limit ?? (aggregated ? null : EXPLORE_RAW_LIMIT)
  if (limit !== null) steps.push({ type: 'limit', limit, offset: 0 })
  return {
    version: 1,
    source: { kind: 'dataset', id: datasetId },
    steps,
    params: {},
    options: { cache: true, approxCount: true },
  }
}
