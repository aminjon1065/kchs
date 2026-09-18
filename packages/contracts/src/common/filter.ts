import { z } from 'zod'

/**
 * Общий формат фильтра (contracts/field-types.md).
 * Один формат для: QuerySpec.filter, списков объектов, политик строк,
 * условий правил автоматизации и сохранённых представлений.
 */
export const FILTER_OPERATORS = [
  // текст
  'eq',
  'neq',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'regex',
  // пустота
  'is_empty',
  'not_empty',
  // числа и даты
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
  'before',
  'after',
  'relative',
  // множества
  'in',
  'not_in',
  // булево
  'is_true',
  'is_false',
  // пользователь / подразделение
  'is_me',
  'is_my_subordinate',
  'in_my_unit',
  // территория
  'within',
  // геометрия
  'intersects',
  'dwithin',
] as const

export const FilterOperator = z.enum(FILTER_OPERATORS)
export type FilterOperator = z.infer<typeof FilterOperator>

/** Макросы значений: @me, @my_unit, @my_territories, @today, @now, @param:<name>. */
export const FilterMacro = z
  .string()
  .regex(/^@(me|my_unit|my_units|my_territories|today|now|param:[a-zA-Z0-9_]+)$/)

export const RelativeRange = z.object({
  unit: z.enum(['day', 'week', 'month', 'quarter', 'year']),
  from: z.number().int(),
  to: z.number().int(),
})

export const WithinValue = z.object({
  id: z.string(),
  includeChildren: z.boolean().default(true),
})

export const FilterValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    RelativeRange,
    WithinValue,
    z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])),
    z.record(z.string(), z.unknown()),
  ]),
)

export interface FilterCondition {
  field: string
  op: FilterOperator
  value?: unknown
}

export type FilterNode =
  | FilterCondition
  | { and: FilterNode[] }
  | { or: FilterNode[] }
  | { not: FilterNode }

export const FilterCondition: z.ZodType<FilterCondition> = z.object({
  field: z.string().min(1).max(128),
  op: FilterOperator,
  value: FilterValue.optional(),
})

export const FilterNode: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    FilterCondition,
    z.object({ and: z.array(FilterNode).min(1) }),
    z.object({ or: z.array(FilterNode).min(1) }),
    z.object({ not: FilterNode }),
  ]),
)

export function isGroup(node: FilterNode): node is { and: FilterNode[] } | { or: FilterNode[] } {
  return 'and' in node || 'or' in node
}

export function isNot(node: FilterNode): node is { not: FilterNode } {
  return 'not' in node
}

export function isCondition(node: FilterNode): node is FilterCondition {
  return 'field' in node && 'op' in node
}
