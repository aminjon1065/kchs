import type { SqlCompletionContext, SqlName, SqlTableRef } from './sql-context.js'
import type { SqlEditorTable } from './types.js'

/**
 * Подсказки по схеме: таблицы и поля ищутся и по «человеческому» имени (название
 * датасета, подпись поля), и по ключу. Что совпало, то и вставляется: набрали
 * «дат» — `"Дата происшествия"`, набрали `inc` — `incident_date`.
 */

export interface SchemaCandidate {
  kind: 'table' | 'column'
  /** Имя в списке подсказок. */
  shown: string
  /** Второе имя — ключ при совпадении по подписи и наоборот. */
  other?: string
  /** Имя для вставки в текст (кавычки расставляет редактор). */
  insert: string
  type?: string
  description?: string
  /** Таблица поля, когда в запросе их несколько. */
  table?: string
  /** Совпавший фрагмент `shown` для подсветки. */
  range: readonly [number, number] | null
  score: number
}

interface NameMatch {
  /** Совпало второе имя (ключ). */
  secondary: boolean
  score: number
  range: readonly [number, number] | null
}

const MAX_CANDIDATES = 150

/** Сравнение без регистра и без различия «е»/«ё». */
function fold(text: string): string {
  // i18n-ignore — буква для сравнения, не текст интерфейса
  return text.toLowerCase().replace(/ё/g, 'е')
}

/** Граница слова в имени: пробел, подчёркивание, дефис, точка, косая черта. */
const WORD_BREAK = /[\s_\-./]/

/** Начало имени лучше начала слова в нём, а то — вхождения в середине. */
function scoreIn(query: string, text: string, secondary: boolean): NameMatch | null {
  const folded = fold(text)
  const first = folded.indexOf(query)
  if (first < 0) return null
  // Подсветка — только если свёртка не изменила длину (иначе смещения не совпадут)
  const at = (index: number) =>
    folded.length === text.length ? ([index, index + query.length] as const) : null
  const bonus = secondary ? 0 : 5
  if (first === 0) {
    return { secondary, score: (folded.length === query.length ? 400 : 300) + bonus, range: at(0) }
  }
  for (let i = first; i >= 0; i = folded.indexOf(query, i + 1)) {
    if (WORD_BREAK.test(folded[i - 1] ?? '')) return { secondary, score: 200 + bonus, range: at(i) }
  }
  return { secondary, score: 100 + bonus, range: at(first) }
}

/** Совпадение набранного с именем или ключом; пустой запрос подходит всему. */
export function matchName(query: string, name: string, key?: string): NameMatch | null {
  if (!query) return { secondary: false, score: 0, range: null }
  const folded = fold(query)
  const byName = scoreIn(folded, name, false)
  const byKey = key && key !== name ? scoreIn(folded, key, true) : null
  if (byName && byKey) return byKey.score > byName.score ? byKey : byName
  return byName ?? byKey
}

/**
 * Имя из запроса и имя из схемы — одно и то же: в кавычках — точно, без кавычек —
 * как их сравнит Postgres (латиница к строчной). Регистронезависимое сравнение —
 * запасной вариант: подсказке лучше узнать таблицу, чем промолчать.
 */
function sameName(name: SqlName, candidate: string, strict: boolean): boolean {
  if (strict) {
    return name.quoted
      ? name.value === candidate
      : name.value.replace(/[A-Z]+/g, (m) => m.toLowerCase()) === candidate
  }
  return fold(name.value) === fold(candidate)
}

function findTable(schema: readonly SqlEditorTable[], name: SqlName): SqlEditorTable | undefined {
  for (const strict of [true, false]) {
    const table = schema.find(
      (item) =>
        sameName(name, item.name, strict) ||
        (item.key !== undefined && sameName(name, item.key, strict)),
    )
    if (table) return table
  }
  return undefined
}

function sameAlias(a: SqlName, b: SqlName): boolean {
  const norm = (n: SqlName) =>
    n.quoted ? n.value : n.value.replace(/[A-Z]+/g, (m) => m.toLowerCase())
  return norm(a) === norm(b)
}

/** Таблица перед точкой: псевдоним из FROM/JOIN или имя (ключ) таблицы. */
function resolveQualifier(
  schema: readonly SqlEditorTable[],
  refs: readonly SqlTableRef[],
  qualifier: SqlName,
): SqlEditorTable | undefined {
  const ref = refs.find((item) => item.alias && sameAlias(item.alias, qualifier))
  return findTable(schema, ref ? ref.name : qualifier)
}

function tablesInScope(schema: readonly SqlEditorTable[], refs: readonly SqlTableRef[]) {
  const tables: SqlEditorTable[] = []
  for (const ref of refs) {
    const table = findTable(schema, ref.name)
    if (table && !tables.includes(table)) tables.push(table)
  }
  return tables
}

function tableCandidates(schema: readonly SqlEditorTable[], query: string): SchemaCandidate[] {
  const out: SchemaCandidate[] = []
  for (const table of schema) {
    const match = matchName(query, table.name, table.key)
    if (!match) continue
    out.push({
      kind: 'table',
      shown: match.secondary ? (table.key as string) : table.name,
      other: match.secondary ? table.name : table.key,
      insert: match.secondary ? (table.key as string) : table.name,
      description: table.description,
      range: match.range,
      score: match.score,
    })
  }
  return out
}

function columnCandidates(
  tables: readonly SqlEditorTable[],
  query: string,
  withTable: boolean,
): SchemaCandidate[] {
  const out: SchemaCandidate[] = []
  for (const table of tables) {
    for (const column of table.columns) {
      const match = matchName(query, column.label, column.key)
      if (!match) continue
      out.push({
        kind: 'column',
        shown: match.secondary ? column.key : column.label,
        other: match.secondary ? column.label : column.key,
        insert: match.secondary ? column.key : column.label,
        type: column.type,
        description: column.description,
        table: withTable ? table.name : undefined,
        range: match.range,
        score: match.score,
      })
    }
  }
  return out
}

/** Подсказки схемы для контекста курсора, лучшие первыми. */
export function schemaCandidates(
  schema: readonly SqlEditorTable[],
  context: SqlCompletionContext,
): SchemaCandidate[] {
  let list: SchemaCandidate[]
  switch (context.kind) {
    case 'table':
      list = tableCandidates(schema, context.query)
      break
    case 'member': {
      const table = resolveQualifier(schema, context.refs, context.qualifier)
      list = table ? columnCandidates([table], context.query, false) : []
      break
    }
    case 'general': {
      const scope = tablesInScope(schema, context.refs)
      // Без FROM поля всех таблиц — только когда уже что-то набрано
      const columns =
        scope.length > 0
          ? columnCandidates(scope, context.query, scope.length > 1)
          : context.query
            ? columnCandidates(schema, context.query, true)
            : []
      list = [...columns, ...tableCandidates(schema, context.query)]
      break
    }
    default:
      return []
  }
  // Стабильная сортировка: при равном совпадении — порядок схемы, поля раньше таблиц
  return list
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => b.candidate.score - a.candidate.score || a.index - b.index)
    .slice(0, MAX_CANDIDATES)
    .map(({ candidate }) => candidate)
}
