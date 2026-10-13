import {
  type FieldType,
  type LangText,
  type QuerySource,
  type QueryStep,
  SYSTEM_DATASETS,
  type TerritoryLevel,
} from '@kchs/contracts'
import { fail, type IssuePath } from '../../errors.js'
import { isOrderable, VALUE_TYPE_LABELS, type ValueType } from '../../value-types.js'
import {
  type Column,
  type ColumnMeta,
  columnSql,
  findColumn,
  type Relation,
  resolveColumn,
} from '../scope.js'
import type { CompileState } from '../state.js'

/** Шаг spatial: операции, допустимые параметры, пределы, подписи и SQL мер. */

export type SpatialStep = Extract<QueryStep, { type: 'spatial' }>

export type SpatialOp = SpatialStep['op']

export type Predicate = 'intersects' | 'within' | 'contains' | 'dwithin'

/** Что шагу spatial нужно от конвейера (pipeline.ts) — без циклического импорта. */
export interface SpatialHost {
  readonly state: CompileState
  /** Текущее отношение конвейера. */
  readonly relation: Relation
  /**
   * Новое отношение после шага. `restructured` — строки другие (ячейки сетки,
   * растворение): порядок сбрасывается, режим таблицы не применяется — как у сводки.
   */
  update(relation: Relation, restructured: boolean): void
  /** Имя следующего CTE конвейера. */
  nextName(): string
  /** Источник цели с политиками смотрящего — как источник соединения. */
  source(source: QuerySource, path: IssuePath): Relation
}

/** Системный датасет справочника территорий: поля `id`, `code`, `level`, `geom` (ADR-0069). */
export const TERRITORIES_DATASET = 'territories'

/** Операции с целью: фильтры по отношению, ближайший, соединение, вырезание. */
export const TARGET_OPS = new Set<SpatialOp>([
  'intersects',
  'within',
  'dwithin',
  'nearest',
  'spatial_join',
  'clip',
])

export const PARAMS: Record<SpatialOp, readonly string[]> = {
  buffer: ['field', 'distance', 'distanceField'],
  intersects: ['field', 'negate'],
  within: ['field', 'negate'],
  dwithin: ['field', 'distance', 'negate'],
  nearest: ['field', 'limit', 'maxDistance', 'fields', 'as'],
  centroid: ['field', 'inside'],
  area: ['field', 'as'],
  length: ['field', 'as'],
  assign_territory: ['field', 'level', 'as'],
  spatial_join: ['field', 'predicate', 'distance', 'measures'],
  grid: ['field', 'size', 'measures'],
  hexgrid: ['field', 'size', 'measures'],
  dissolve: ['field', 'by', 'measures'],
  clip: ['field'],
}

export const PREDICATES: readonly Predicate[] = ['intersects', 'within', 'contains', 'dwithin']

export const MEASURE_AGGS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const

export type MeasureAgg = (typeof MEASURE_AGGS)[number]

/** Расстояние в метрах: до 1000 км (буфер, радиус, предел поиска ближайшего). */
export const DISTANCE = { min: 0, max: 1_000_000, positive: true } as const

/** Сторона ячейки сетки, м: мельче 10 м сетка по данным региона не нужна и опасна по объёму. */
export const CELL_SIZE = { min: 10, max: 1_000_000 } as const

export const MAX_NEAREST = 100

export const MAX_MEASURES = 50

export const MAX_TERRITORIES = 1000

export const NAME = /^[a-z_][a-z0-9_]*$/

export const ALIAS = /^[a-z_][a-z0-9_]*$/i

export const NUMERIC = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const NUMERIC_FIELD_TYPES = new Set<FieldType>([
  'number',
  'decimal',
  'money',
  'percent',
  'duration',
])

/**
 * Подписи полей, которые добавляет шаг (результат и материализованный датасет).
 * Таджикский — с полным переводом (фаза 5), до него подпись берётся из ru.
 */
export const LABELS = {
  area: { ru: 'Площадь, км²', en: 'Area, km²' },
  length: { ru: 'Длина, км', en: 'Length, km' },
  distance: { ru: 'Расстояние, м', en: 'Distance, m' },
  rank: { ru: 'Номер по близости', en: 'Nearest rank' },
  count: { ru: 'Количество', en: 'Count' },
  cell: { ru: 'Ячейка', en: 'Cell' },
} satisfies Record<string, LangText>

/** Подписи полей «территория уровня» (как уровни в справочнике территорий). */
export const LEVEL_LABELS: Record<TerritoryLevel, LangText> = {
  country: { ru: 'Страна', en: 'Country' },
  region: { ru: 'Регион', en: 'Region' },
  district: { ru: 'Район', en: 'District' },
  jamoat: { ru: 'Джамоат', en: 'Jamoat' },
  settlement: { ru: 'Населённый пункт', en: 'Settlement' },
}

export type Target =
  | { kind: 'literal'; sql: string }
  | { kind: 'relation'; relation: Relation; geom: Column }

export interface Measure {
  sql: string
  column: Column
}

/** SQL агрегата меры и тип результата — как у мер шага aggregate. */
export function measureSql(
  agg: MeasureAgg,
  column: Column | null,
  source: Relation,
  dialect: CompileState['dialect'],
  path: IssuePath,
): { sql: string; type: ValueType; meta: ColumnMeta } {
  const sql = column ? columnSql(dialect, source, column) : null
  const measure = (fieldType: FieldType, format: ColumnMeta['format'] = null): ColumnMeta => ({
    fieldType,
    semantic: 'measure',
    label: null,
    format,
  })
  const need = (): { column: Column; sql: string } => {
    if (!column || !sql) return fail(path, `Для меры «${agg}» нужно поле`)
    return { column, sql }
  }
  switch (agg) {
    case 'count':
      return { sql: sql ? `count(${sql})` : 'count(*)', type: 'number', meta: measure('integer') }
    case 'count_distinct':
      return { sql: `count(DISTINCT ${need().sql})`, type: 'number', meta: measure('integer') }
    case 'sum':
    case 'avg': {
      const value = need()
      if (value.column.type !== 'number') {
        fail(
          path,
          `Мера «${agg}» считается по числам, а получено: ${VALUE_TYPE_LABELS[value.column.type]}`,
        )
      }
      // Сумма сохраняет тип поля (деньги, целое), среднее целых — дробное число
      const source = value.column.meta.fieldType
      const fieldType = agg === 'sum' || NUMERIC_FIELD_TYPES.has(source) ? source : 'number'
      return {
        sql: `${agg}(${value.sql})`,
        type: 'number',
        meta: measure(fieldType, value.column.meta.format),
      }
    }
    case 'min':
    case 'max': {
      const value = need()
      if (!isOrderable(value.column.type)) {
        fail(
          path,
          `Мера «${agg}» не считается по значениям «${VALUE_TYPE_LABELS[value.column.type]}»`,
        )
      }
      const meta = { ...value.column.meta, label: null }
      return {
        sql: `${agg}(${value.sql})`,
        type: value.column.type,
        meta: value.column.type === 'number' ? { ...meta, semantic: 'measure' } : meta,
      }
    }
  }
}

/** Поле геометрии отношения: заданное или единственное. */
export function geometryColumn(
  relation: Relation,
  ref: string | undefined,
  path: IssuePath,
  whose: string,
): Column {
  if (ref !== undefined) {
    const column = resolveColumn(relation, ref, path)
    if (column.type !== 'geometry') {
      fail(path, `Поле «${ref}» — не геометрия, а ${VALUE_TYPE_LABELS[column.type]}`)
    }
    return column
  }
  const candidates = relation.columns.filter(
    (column) => !column.hidden && column.type === 'geometry',
  )
  const [only] = candidates
  if (only && candidates.length === 1) return only
  if (!only) {
    return fail(path, `В ${whose} нет поля геометрии`, {
      hint: 'Пространственные операции работают с полем типа «геометрия»',
    })
  }
  const names = candidates.map((column) =>
    column.qualifier ? `${column.qualifier}.${column.name}` : column.name,
  )
  return fail(path, `В ${whose} несколько полей геометрии: ${names.join(', ')}`, {
    hint: 'Укажите поле геометрии в field',
  })
}

/** Поле справочника территорий, на которое опирается шаг. */
export function directoryColumn(relation: Relation, name: string, path: IssuePath): Column {
  const found = findColumn(relation, null, name)
  if ('message' in found) return fail(path, `В справочнике территорий нет поля «${name}»`)
  return found
}

export function allowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: IssuePath,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      fail([...path, key], `Неизвестное поле «${key}»`, { hint: `Допустимо: ${keys.join(', ')}` })
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSystemName(value: unknown): value is (typeof SYSTEM_DATASETS)[number] {
  return typeof value === 'string' && (SYSTEM_DATASETS as readonly string[]).includes(value)
}

export function mergeSets(
  a: ReadonlyMap<string, Set<string>>,
  b: ReadonlyMap<string, Set<string>>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const source of [a, b]) {
    for (const [key, names] of source) {
      result.set(key, new Set([...(result.get(key) ?? []), ...names]))
    }
  }
  return result
}
