import type { FieldFormat, FieldSemantic, FieldType, LangText } from '@kchs/contracts'
import type { Dialect } from '../dialect.js'
import { fail, type IssuePath } from '../errors.js'
import type { LookupRef } from '../types.js'
import type { ValueType } from '../value-types.js'

/** Описание столбца для результата: тип поля, семантика, подпись, формат. */
export interface ColumnMeta {
  fieldType: FieldType
  semantic: FieldSemantic | null
  label: LangText | null
  format: FieldFormat | null
  /** Справочник поля датасета — для `lookup_label()`. */
  lookup?: LookupRef | null
}

export interface Column {
  /** Имя для ссылок без алиаса и для результата (ключ поля, алиас меры…). */
  name: string
  /** Алиас источника для ссылок `alias.field`; null — после сводки и переименования. */
  qualifier: string | null
  /** Имя столбца в SQL-отношении (уникально внутри отношения). */
  internal: string
  type: ValueType
  meta: ColumnMeta
  /** Не попадает в результат сам по себе: системные столбцы строк и служебный порядок. */
  hidden: boolean
  /** Системный столбец строки датасета (`_id`, `_ver`, `_created_at`, `_updated_at`). */
  system?: boolean
}

/** Отношение — CTE текущего шага и его столбцы. */
export interface Relation {
  name: string
  columns: Column[]
  /** Поля, скрытые политикой столбцов, по алиасу источника — для понятной ошибки. */
  restricted: Map<string, Set<string>>
  /** Поля, которые пока нельзя запрашивать (вычисляемые), по алиасу источника. */
  unavailable: Map<string, Set<string>>
  /** Алиасы источников, чьи поля доступны в отношении. */
  qualifiers: Set<string>
}

export function columnSql(dialect: Dialect, relation: Relation, column: Column): string {
  return `${dialect.ident(relation.name)}.${dialect.ident(column.internal)}`
}

export function splitRef(ref: string): { qualifier: string | null; name: string } {
  const dot = ref.indexOf('.')
  if (dot <= 0) return { qualifier: null, name: ref }
  return { qualifier: ref.slice(0, dot), name: ref.slice(dot + 1) }
}

export type ResolveFailure = { message: string; hint?: string }

/** Находит столбец по ссылке; при неудаче — сообщение (путь добавляет вызывающий). */
export function findColumn(
  relation: Relation,
  qualifier: string | null,
  name: string,
): Column | ResolveFailure {
  const shown = qualifier ? `${qualifier}.${name}` : name
  const candidates = relation.columns.filter(
    (column) => column.name === name && (qualifier === null || column.qualifier === qualifier),
  )
  const visible = candidates.filter((column) => !column.hidden || column.system)
  if (visible.length === 1) return visible[0] as Column
  if (visible.length > 1) {
    const qualifiers = [...new Set(visible.map((column) => column.qualifier).filter(Boolean))]
    return {
      message: `Поле «${shown}» неоднозначно`,
      hint: qualifiers.length
        ? `Укажите источник: ${qualifiers.map((q) => `${q}.${name}`).join(' или ')}`
        : 'Переименуйте одно из полей',
    }
  }
  for (const [source, names] of relation.restricted) {
    if ((qualifier === null || qualifier === source) && names.has(name)) {
      return { message: `Нет доступа к полю «${shown}»` }
    }
  }
  for (const [source, names] of relation.unavailable) {
    if ((qualifier === null || qualifier === source) && names.has(name)) {
      return {
        message: `Поле «${shown}» вычисляемое — в запросах к данным оно пока недоступно`,
      }
    }
  }
  if (qualifier !== null && !relation.qualifiers.has(qualifier)) {
    return {
      message: `Неизвестный источник «${qualifier}»`,
      hint: relation.qualifiers.size
        ? `Доступны: ${[...relation.qualifiers].join(', ')}`
        : 'После сводки поля указываются без источника',
    }
  }
  const names = relation.columns.filter((column) => !column.hidden).map((column) => column.name)
  const similar = similarNames(names, name)
  return {
    message: `Нет поля «${shown}»`,
    ...(similar.length ? { hint: `Возможно, имелось в виду: ${similar.join(', ')}` } : {}),
  }
}

/** Столбец по ссылке `alias.field` или `field`; ошибка — с путём в спецификации. */
export function resolveColumn(relation: Relation, ref: string, path: IssuePath): Column {
  const { qualifier, name } = splitRef(ref)
  const found = findColumn(relation, qualifier, name)
  if ('message' in found) fail(path, found.message, found.hint ? { hint: found.hint } : {})
  return found
}

/** Уникальное имя столбца в отношении. */
export function uniqueInternal(
  taken: ReadonlySet<string>,
  preferred: string,
  prefix?: string,
): string {
  if (!taken.has(preferred)) return preferred
  const base = prefix ? `${prefix}__${preferred}` : `${preferred}_2`
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Похожие имена для подсказки «Возможно, имелось в виду». */
export function similarNames(candidates: readonly string[], name: string, limit = 3): string[] {
  return candidates.filter((candidate) => closeTo(candidate, name)).slice(0, limit)
}

function closeTo(a: string, b: string): boolean {
  if (a.startsWith(b) || b.startsWith(a)) return true
  return levenshtein(a, b) <= Math.max(1, Math.floor(Math.min(a.length, b.length) / 4))
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j] as number
      row[j] = Math.min(
        (row[j] as number) + 1,
        (row[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      prev = current
    }
  }
  return row[b.length] as number
}
