import { SYSTEM_COLUMNS } from '../../compiler/sources.js'
import type { ResolvedField, SqlDataset } from '../../types.js'
import { valueTypeOfField } from '../../value-types.js'
import { type Placeholder, truncateIdent } from '../text.js'

/**
 * Модель анализатора сырого SQL: столбцы результата, поля датасета по ключам и
 * подписям с учётом политики столбцов, элементы FROM и области видимости запроса.
 */

export type Obj = Record<string, unknown>

/** Дерево разбора libpg-query: `{version, stmts: [{stmt, stmt_location, stmt_len}]}`. */
export interface ParseTree {
  version?: number
  stmts?: Array<{ stmt?: unknown; stmt_location?: number; stmt_len?: number }>
}

/** Правка текста запроса: [start, end) заменяется на `text` (индексы строки). */
export interface Edit {
  start: number
  end: number
  text: string
}

/** Ссылка на датасет в тексте: имя таблицы заменяется подзапросом с политиками. */
export interface DatasetRef {
  start: number
  end: number
  /** Имя таблицы для `AS` (у ссылки не было алиаса) или null — алиас есть в тексте. */
  alias: string | null
}

/** Прямая ссылка столбца результата на поле или системный столбец датасета. */
export interface FieldRef {
  datasetId: string
  column: string
}

/** Столбец результата: имя (null — не вывести без выполнения) или «звёздочка». */
export type Output =
  | { kind: 'column'; name: string | null; field: FieldRef | null }
  | { kind: 'dataset'; datasetId: string }
  | { kind: 'unknown' }

/** Поиск датасетов по имени таблицы (null — режим сбора имён без проверки). */
export interface TableCatalog {
  find(name: string, position: number): SqlDataset | null
  similar(name: string): string[]
}

export interface Analysis {
  /** Границы оператора в тексте (без завершающей точки с запятой). */
  statement: { start: number; end: number }
  edits: Edit[]
  datasets: Map<string, { dataset: SqlDataset; refs: DatasetRef[] }>
  /** Параметры `{{…}}`, встреченные в дереве. */
  params: Placeholder[]
  /** Системные столбцы строк, упомянутые в запросе, — только они попадут в подзапросы. */
  systemColumns: Set<string>
  /** Имена таблиц, не являющихся CTE, в порядке появления. */
  tables: string[]
  outputs: Output[]
  /** Запрос зависит от момента выполнения (now(), CURRENT_DATE…). */
  usesTime: boolean
  /** Результат случаен (random()…): кэшировать нельзя. */
  volatile: boolean
}

export const SYSTEM_NAMES = new Set(SYSTEM_COLUMNS.map((column) => column.name))

export type FieldLookup =
  | { kind: 'field'; field: ResolvedField; viaLabel: boolean }
  | { kind: 'system'; name: string }
  | { kind: 'hidden'; name: string }
  | { kind: 'unavailable'; name: string }
  | { kind: 'ambiguous'; name: string; keys: string[] }

export type ColumnLookup = Extract<FieldLookup, { kind: 'field' | 'system' }>

/** Поля датасета по ключам и подписям (ru, tg, en) с учётом политики столбцов. */
export class DatasetBinding {
  private readonly byKey = new Map<string, ResolvedField>()
  private readonly byLabel = new Map<string, ResolvedField[]>()
  private readonly byLabelLower = new Map<string, ResolvedField[]>()
  private readonly hidden: Set<string>
  private readonly system: boolean

  constructor(readonly dataset: SqlDataset) {
    this.hidden = new Set(dataset.columnPolicy.hide)
    this.system = dataset.systemColumns !== false
    for (const field of dataset.fields) {
      this.byKey.set(field.key, field)
      const labels = new Set(
        [field.label?.ru, field.label?.tg, field.label?.en]
          .filter((label): label is string => typeof label === 'string' && label.length > 0)
          .map(truncateIdent),
      )
      for (const label of labels) {
        push(this.byLabel, label, field)
        push(this.byLabelLower, label.toLowerCase(), field)
      }
    }
  }

  lookup(name: string): FieldLookup | null {
    const field = this.byKey.get(name)
    if (field) return this.classify(field, false)
    if (this.system && SYSTEM_NAMES.has(name)) return { kind: 'system', name }
    for (const [map, key] of [
      [this.byLabel, name],
      [this.byLabelLower, name.toLowerCase()],
    ] as const) {
      const fields = map.get(key)
      if (!fields?.length) continue
      if (fields.length > 1) {
        return { kind: 'ambiguous', name, keys: fields.map((item) => item.key) }
      }
      return this.classify(fields[0] as ResolvedField, true)
    }
    return null
  }

  /** Столбец подзапроса (`*`, подзапрос над датасетом): ключ видимого поля или системный. */
  hasColumn(name: string): boolean {
    const found = this.lookup(name)
    return (found?.kind === 'field' && !found.viaLabel) || found?.kind === 'system'
  }

  /** Имена для подсказки: ключи и подписи видимых полей. */
  names(): string[] {
    return this.dataset.fields
      .filter((field) => !this.hidden.has(field.key))
      .flatMap((field) => [field.key, field.label?.ru ?? ''])
      .filter(Boolean)
  }

  private classify(field: ResolvedField, viaLabel: boolean): FieldLookup {
    if (this.hidden.has(field.key)) return { kind: 'hidden', name: field.key }
    if (!valueTypeOfField(field.type)) return { kind: 'unavailable', name: field.key }
    return { kind: 'field', field, viaLabel }
  }
}

export function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (!list) map.set(key, [value])
  else if (!list.includes(value)) list.push(value)
}

export interface DatasetItem {
  kind: 'dataset'
  ref: string
  binding: DatasetBinding
}

export interface RelationItem {
  kind: 'relation'
  ref: string | null
  /** Столбцы отношения; null — неизвестны до выполнения. */
  columns: readonly Output[] | null
}

export interface JoinItem {
  kind: 'join'
  ref: string
  children: readonly FromItem[]
}

export type FromItem = DatasetItem | RelationItem | JoinItem

export interface CteBinding {
  name: string
  generated: string
  columns: Output[] | null
}

/** Результат поиска имени среди элементов FROM. */
export interface Found {
  /** Совпадения с полями и системными столбцами датасетов. */
  fields: Array<{ item: DatasetItem; lookup: ColumnLookup }>
  /** Скрытые, вычисляемые и неоднозначные подписи. */
  problems: FieldLookup[]
  /** Совпадения со столбцами других отношений (подзапросы, CTE, функции). */
  others: number
  /** Последнее такое совпадение (при единственном — ссылка на поле и замена подписи). */
  other: OutputMatch | null
  /** Есть отношения с неизвестными столбцами — имя может быть там. */
  maybe: boolean
}

/** Область видимости уровня запроса: CTE этого уровня и элементы FROM. */
export class Scope {
  constructor(
    readonly parent: Scope | null,
    readonly ctes: CteBinding[] = [],
    readonly items: FromItem[] = [],
  ) {}

  cte(name: string): CteBinding | undefined {
    for (let scope: Scope | null = this; scope; scope = scope.parent) {
      const found = scope.ctes.find((cte) => cte.name === name)
      if (found) return found
    }
    return undefined
  }
}

/** Как разрешать голое имя: как поле (обычно), сначала как имя результата (ORDER BY) или после (GROUP BY). */
export interface ExprCtx {
  names: 'input' | 'order' | 'group'
  outputs: readonly Output[] | null
  /** ColumnRef — весь элемент списка выборки без алиаса: подпись сохраняется как имя столбца. */
  bareTarget: boolean
}

export const INPUT: ExprCtx = { names: 'input', outputs: null, bareTarget: false }

export function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Столбец отношения, найденный по имени. */
export interface OutputMatch {
  /** Поле датасета, если столбец — прямая ссылка на него (CTE и подзапросы передают описание). */
  field: FieldRef | null
  /** Имя найдено как подпись поля за звёздочкой: столбец называется ключом — заменить имя. */
  rename: string | null
}

/**
 * Поиск имени в столбцах отношения: сначала точные имена (столбцы, ключи полей
 * за звёздочкой), затем подписи полей за звёздочкой (`SELECT * FROM "Датасет"`
 * в CTE и подзапросах отдаёт столбцы с именами-ключами).
 */
export function outputsLookup(
  outputs: readonly Output[] | null,
  bindings: ReadonlyMap<string, DatasetBinding>,
  name: string,
): OutputMatch | { problem: FieldLookup } | 'maybe' | 'none' {
  if (outputs === null) return 'maybe'
  let maybe = false
  for (const output of outputs) {
    if (output.kind === 'column') {
      if (output.name === name) return { field: output.field, rename: null }
      if (output.name === null) maybe = true
    } else if (output.kind === 'dataset') {
      if (bindings.get(output.datasetId)?.hasColumn(name)) {
        return { field: { datasetId: output.datasetId, column: name }, rename: null }
      }
    } else {
      maybe = true
    }
  }
  if (maybe) return 'maybe'
  for (const output of outputs) {
    if (output.kind !== 'dataset') continue
    const lookup = bindings.get(output.datasetId)?.lookup(name)
    if (lookup?.kind === 'field') {
      const key = lookup.field.key
      return { field: { datasetId: output.datasetId, column: key }, rename: key }
    }
    if (lookup && lookup.kind !== 'system') return { problem: lookup }
  }
  return 'none'
}

/** Алиас со списком столбцов переименовывает первые столбцы отношения. */
export function renameOutputs(
  outputs: readonly Output[] | null,
  names: string[] | null | undefined,
): Output[] | null {
  if (!names) return outputs ? [...outputs] : null
  const renamed: Output[] = names.map((name) => ({ kind: 'column', name, field: null }))
  if (!outputs) return [...renamed, { kind: 'unknown' }]
  // Звёздочки в исходных столбцах: сколько столбцов переименовано — неизвестно
  if (outputs.some((output) => output.kind !== 'column')) return [...renamed, { kind: 'unknown' }]
  return [...renamed, ...outputs.slice(names.length)]
}
