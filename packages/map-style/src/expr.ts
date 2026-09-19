import type { ExpressionSpecification } from '@maplibre/maplibre-gl-style-spec'

/**
 * Выражения MapLibre собираются из массивов: типы style-spec — строгие кортежи,
 * а компилятор строит выражения по данным. Приведение — в одном месте; каждое
 * выражение проверяет `validateStyleMin` в тестах пакета.
 */
export type Expr = ExpressionSpecification

export const expr = (...parts: unknown[]): Expr => parts as unknown as Expr

export const get = (field: string): Expr => expr('get', field)

/** Значения нет: в MVT пустые поля не кодируются, в GeoJSON — null. */
export const isNull = (field: string): Expr => expr('==', get(field), null)

export const present = (field: string): Expr => expr('!=', get(field), null)

/** Число из свойства: строки с числом тоже (numeric без приведения в тайле). */
export const num = (field: string): Expr => expr('to-number', get(field))

export const str = (field: string): Expr => expr('to-string', get(field))

export type Condition = Expr | boolean

/** Конъюнкция с упрощением: false поглощает, true выпадает. */
export function all(parts: readonly Condition[]): Condition {
  if (parts.some((part) => part === false)) return false
  const rest = parts.filter((part): part is Expr => part !== true)
  if (rest.length === 0) return true
  return rest.length === 1 ? (rest[0] as Expr) : expr('all', ...rest)
}

export function any(parts: readonly Condition[]): Condition {
  if (parts.some((part) => part === true)) return true
  const rest = parts.filter((part): part is Expr => part !== false)
  if (rest.length === 0) return false
  return rest.length === 1 ? (rest[0] as Expr) : expr('any', ...rest)
}

export function not(part: Condition): Condition {
  if (typeof part === 'boolean') return !part
  return expr('!', part)
}

/** Условие как выражение: литерал true/false — тоже выражение MapLibre. */
export const condition = (part: Condition): Expr => part as unknown as Expr

/** Значение, зависящее от данных: постоянное, по категориям, по правилам, по классам. */
export type Plan<T extends string | number> =
  | { kind: 'constant'; value: T }
  | {
      kind: 'match'
      input: Expr
      cases: ReadonlyArray<{ labels: readonly (string | number)[]; value: T }>
      fallback: T
      /** Пустое значение проверяется до `match`: to-number пустого — 0. */
      missing: { when: Expr; value: T } | null
    }
  | { kind: 'case'; cases: ReadonlyArray<{ when: Expr; value: T }>; fallback: T }
  | {
      kind: 'step'
      input: Expr
      base: T
      stops: ReadonlyArray<{ at: number; value: T }>
      /** Нет значения (или деление на ноль) — отдельный цвет, до классов. */
      missing: { when: Expr; value: T } | null
    }
  | {
      kind: 'interpolate'
      input: Expr
      stops: ReadonlyArray<{ at: number; value: number }>
      missing: { when: Expr; value: number } | null
    }

/**
 * План → выражение. `map` переводит каждое значение (цвет заливки → цвет обводки,
 * диаметр → радиус); у интерполяции — значения опорных точек.
 */
export function planExpr<T extends string | number, R extends string | number>(
  plan: Plan<T>,
  map: (value: T) => R,
): R | Expr {
  switch (plan.kind) {
    case 'constant':
      return map(plan.value)
    case 'match': {
      const branches = plan.cases.flatMap((c) => [
        c.labels.length === 1 ? c.labels[0] : [...c.labels],
        map(c.value),
      ])
      const matched =
        branches.length === 0
          ? map(plan.fallback)
          : expr('match', plan.input, ...branches, map(plan.fallback))
      return plan.missing
        ? expr('case', plan.missing.when, map(plan.missing.value), matched)
        : matched
    }
    case 'case': {
      if (plan.cases.length === 0) return map(plan.fallback)
      return expr('case', ...plan.cases.flatMap((c) => [c.when, map(c.value)]), map(plan.fallback))
    }
    case 'step': {
      const step =
        plan.stops.length === 0
          ? map(plan.base)
          : expr(
              'step',
              plan.input,
              map(plan.base),
              ...plan.stops.flatMap((s) => [s.at, map(s.value)]),
            )
      return plan.missing ? expr('case', plan.missing.when, map(plan.missing.value), step) : step
    }
    case 'interpolate': {
      const mapped = plan.stops.map((s) => ({ at: s.at, value: map(s.value as T) }))
      const body =
        mapped.length === 1
          ? (mapped[0]?.value as R)
          : expr('interpolate', ['linear'], plan.input, ...mapped.flatMap((s) => [s.at, s.value]))
      return plan.missing
        ? expr('case', plan.missing.when, map(plan.missing.value as T), body)
        : body
    }
  }
}
