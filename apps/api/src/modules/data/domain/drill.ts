import type { DashboardDrillPick, FilterNode, QuerySpec } from '@kchs/contracts'
import { errors } from '~/shared/errors.js'

type Step = QuerySpec['steps'][number]
type AggregateStep = Extract<Step, { type: 'aggregate' }>

/** Шаги до агрегации, которые сохраняют строки источника: условия и вычисляемые поля. */
const ROW_STEPS = new Set<Step['type']>(['filter', 'compute'])
/** Шаги, после которых строка результата уже не строка датасета. */
const ROW_BREAKING = new Set<Step['type']>([
  'join',
  'union',
  'window',
  'pivot',
  'spatial',
  'unnest',
  'sample',
])
/** Префикс служебных вычисляемых полей детализации — экран их не показывает. */
export const DRILL_PREFIX = '__drill_'

/** Имя столбца разреза в результате агрегации (как у компилятора). */
function groupName(group: AggregateStep['groupBy'][number]): string {
  return group.alias ?? (group.bucket ? `${group.field}_${group.bucket}` : group.field)
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

/** Интервал разреза — тем же усечением, что у агрегации: локальная дата или час. */
function bucketExpression(field: string, bucket: string): string {
  return bucket === 'hour'
    ? `date_trunc('hour', ${quote(field)})`
    : `date_trunc('${bucket}', date(${quote(field)}))`
}

function condition(field: string, pick: DashboardDrillPick): FilterNode {
  if (pick.op === 'eq' && (pick.value === null || pick.value === undefined)) {
    return { field, op: 'is_empty' }
  }
  return { field, op: pick.op, value: pick.value }
}

/**
 * Детализация плитки до строк (06-analytics-engine.md «Дашборды»): строки
 * источника графика под условиями до агрегации (и фильтрами дашборда, если
 * они уже применены), плюс выбранный элемент — значения разрезов. Интервал
 * времени сравнивается через то же усечение, что у агрегации, поэтому строки
 * совпадают с точкой графика без арифметики дат. Меры и неизвестные поля
 * выбранного элемента не сужают строки.
 */
export function drillSpec(
  query: QuerySpec,
  picks: readonly DashboardDrillPick[],
  limit: number,
): { spec: QuerySpec; datasetId: string } {
  if (query.source.kind !== 'dataset') {
    throw errors.validation('Детализация до строк доступна для графиков по датасету')
  }
  const at = query.steps.findIndex((step) => step.type === 'aggregate')
  const before = at < 0 ? query.steps : query.steps.slice(0, at)
  if (before.some((step) => ROW_BREAKING.has(step.type))) {
    throw errors.validation('Детализация до строк недоступна для графиков с соединениями и окнами')
  }
  const aggregate = at < 0 ? null : (query.steps[at] as AggregateStep)
  const computes: Step[] = []
  const conditions: FilterNode[] = []
  picks.forEach((pick, index) => {
    const group = aggregate?.groupBy.find((item) => groupName(item) === pick.field)
    if (aggregate && !group) return
    if (group?.bucket) {
      const name = `${DRILL_PREFIX}${index}`
      computes.push({
        type: 'compute',
        fields: [{ name, expr: bucketExpression(group.field, group.bucket) }],
      })
      conditions.push(condition(name, pick))
      return
    }
    conditions.push(condition(group?.field ?? pick.field, pick))
  })
  const steps: Step[] = [
    ...before.filter((step) => ROW_STEPS.has(step.type)),
    ...computes,
    ...(conditions.length > 0
      ? [
          {
            type: 'filter' as const,
            where: conditions.length === 1 ? (conditions[0] as FilterNode) : { and: conditions },
          },
        ]
      : []),
    { type: 'sort', by: [{ field: '_id', dir: 'asc' }] },
    { type: 'limit', limit, offset: 0 },
  ]
  return {
    spec: { ...query, steps, options: { ...query.options, cache: true } },
    datasetId: query.source.id,
  }
}
