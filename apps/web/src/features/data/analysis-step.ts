import type { AnalysisKind, QueryStep, TerritoryLevel } from '@kchs/contracts'

/** Операции с целью: отбор по отношению к цели, ближайший, соединение, вырезание. */
export const TARGET_OPS = new Set<AnalysisKind>([
  'intersects',
  'within',
  'dwithin',
  'nearest',
  'spatial_join',
  'clip',
])

/** Отбор, который можно обратить: «не пересекает», «не в радиусе». */
export const NEGATABLE = new Set<AnalysisKind>(['intersects', 'within', 'dwithin'])

export type AnalysisTarget =
  | { kind: 'dataset'; id: string | null; hasGeometry: boolean }
  | { kind: 'territory'; id: string | null; level: TerritoryLevel | null }

/** Значения формы запуска анализа (поля ввода — строками, как их набрал пользователь). */
export interface AnalysisForm {
  op: AnalysisKind
  /** Поле геометрии — если их в датасете несколько. */
  field: string | null
  distance: string
  size: string
  limit: string
  maxDistance: string
  inside: boolean
  negate: boolean
  level: TerritoryLevel
  /** Поле растворения; null — все объекты вместе. */
  by: string | null
  target: AnalysisTarget
}

type SpatialStep = Extract<QueryStep, { type: 'spatial' }>

/** Число из поля ввода (запятая — десятичный разделитель); пусто или не число — null. */
function numberOf(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value.replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

function targetOf(target: AnalysisTarget): Record<string, unknown> | null {
  if (target.kind === 'dataset') {
    // Алиас цели различает её поля и поля источника (ближайший объект)
    return target.id && target.hasGeometry ? { kind: 'dataset', id: target.id, alias: 't' } : null
  }
  if (target.id) return { kind: 'territory', id: target.id }
  if (target.level) return { kind: 'territory', level: target.level }
  return null
}

/**
 * Шаг `spatial` из формы (contracts/query-spec.md, ADR-0069); null — форма не
 * заполнена. Сервер проверяет шаг компилятором ещё раз при создании анализа.
 */
export function analysisStep(form: AnalysisForm): SpatialStep | null {
  const params: Record<string, unknown> = form.field ? { field: form.field } : {}
  if (NEGATABLE.has(form.op) && form.negate) params.negate = true
  switch (form.op) {
    case 'buffer':
    case 'dwithin': {
      const meters = numberOf(form.distance)
      if (meters === null || meters <= 0) return null
      params.distance = meters
      break
    }
    case 'nearest': {
      const count = numberOf(form.limit)
      if (count === null || !Number.isInteger(count) || count < 1 || count > 100) return null
      params.limit = count
      const bound = numberOf(form.maxDistance)
      if (form.maxDistance.trim() && (bound === null || bound <= 0)) return null
      if (bound !== null) params.maxDistance = bound
      break
    }
    case 'centroid':
      if (form.inside) params.inside = true
      break
    case 'assign_territory':
      params.level = form.level
      break
    case 'grid':
    case 'hexgrid': {
      const meters = numberOf(form.size)
      if (meters === null || meters < 10) return null
      params.size = meters
      break
    }
    case 'dissolve':
      if (form.by) params.by = [form.by]
      break
    default:
      break
  }
  if (!TARGET_OPS.has(form.op)) return { type: 'spatial', op: form.op, params }
  const target = targetOf(form.target)
  return target ? { type: 'spatial', op: form.op, params, target } : null
}
