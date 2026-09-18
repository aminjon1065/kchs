import { z } from 'zod'
import { FilterNode } from '../common/filter.js'
import { Aggregate, type QuerySpec, type QueryStep, TimeBucket } from './query.js'

/**
 * План «Исследования» (03-screens.md §7): фильтр → сводка (разрезы и меры) →
 * сортировка → лимит. Его строит конструктор на экране и «Спросить данные»
 * (ADR-0061); QuerySpec из плана — одна функция для клиента и сервера, чтобы
 * одинаковый план давал одинаковый запрос (и попадал в один кэш).
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
  })
  .refine((measure) => measure.agg !== 'expr' || Boolean(measure.expr), {
    message: 'Для вычисляемой меры нужно выражение',
    path: ['expr'],
  })
export type ExploreMeasure = z.infer<typeof ExploreMeasure>

export const ExplorePlan = z.object({
  filter: FilterNode.nullable(),
  groups: z.array(ExploreGroup).max(8),
  measures: z.array(ExploreMeasure).max(12),
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

export function explorePlanSpec(datasetId: string, plan: ExplorePlan): QuerySpec {
  const steps: QueryStep[] = []
  if (plan.filter) steps.push({ type: 'filter', where: plan.filter })
  const aggregated = plan.groups.length > 0 || plan.measures.length > 0
  if (aggregated) {
    // Повторы меры (одна и та же функция над тем же полем) дали бы одинаковые алиасы
    const measures = new Map(plan.measures.map((measure) => [measureAlias(measure), measure]))
    steps.push({
      type: 'aggregate',
      groupBy: plan.groups.map((group) => ({
        field: group.field,
        ...(group.bucket ? { bucket: group.bucket } : {}),
      })),
      measures: [...measures].map(([alias, measure]) => ({
        alias,
        agg: measure.agg,
        ...(measure.agg === 'expr' ? { expr: measure.expr } : {}),
        ...(measure.agg !== 'expr' && measure.field ? { field: measure.field } : {}),
      })),
    })
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
