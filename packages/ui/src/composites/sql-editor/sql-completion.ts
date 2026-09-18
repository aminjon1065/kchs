import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  insertBracket,
  pickedCompletion,
} from '@codemirror/autocomplete'
import { PostgreSQL } from '@codemirror/lang-sql'
import type { EditorView } from '@codemirror/view'
import { type SqlCompletionContext, sqlCompletionContext } from './sql-context.js'
import { quoteSqlIdentifier } from './sql-identifier.js'
import { matchName, type SchemaCandidate, schemaCandidates } from './sql-schema.js'
import type { SqlEditorFunction, SqlEditorParam, SqlEditorTable } from './types.js'

/** Данные подсказок: читаются при каждом запросе — смена схемы не пересоздаёт редактор. */
export interface SqlCompletionData {
  schema: readonly SqlEditorTable[]
  params: readonly SqlEditorParam[]
  functions: readonly SqlEditorFunction[]
  /** Подписи вида подсказки на языке интерфейса. */
  texts: { table: string; param: string }
}

/** Контекст считается один раз на запрос подсказок — его читают все источники. */
const contexts = new WeakMap<CompletionContext, SqlCompletionContext>()

function contextOf(context: CompletionContext): SqlCompletionContext {
  let found = contexts.get(context)
  if (!found) {
    found = sqlCompletionContext(context.state.doc.toString(), context.pos)
    contexts.set(context, found)
  }
  return found
}

/** Совпавшие фрагменты подписей: CodeMirror подсвечивает их при `filter: false`. */
const matches = new WeakMap<Completion, readonly number[]>()
const getMatch = (completion: Completion) => matches.get(completion) ?? []

function withMatch(completion: Completion, range: readonly [number, number] | null): Completion {
  if (range) matches.set(completion, range)
  return completion
}

/** В кавычках — всегда в кавычках: пользователь сам начал имя с `"`. */
function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function schemaCompletion(
  candidate: SchemaCandidate,
  inQuotes: boolean,
  texts: SqlCompletionData['texts'],
): Completion {
  const detail = [
    candidate.other,
    candidate.type ?? (candidate.kind === 'table' ? texts.table : undefined),
    candidate.table,
  ]
    .filter(Boolean)
    .join(' · ')
  return withMatch(
    {
      label: inQuotes ? quoted(candidate.insert) : quoteSqlIdentifier(candidate.insert),
      displayLabel: candidate.shown,
      detail: detail || undefined,
      info: candidate.description,
      type: candidate.kind,
    },
    candidate.range,
  )
}

/** Таблицы и поля по «человеческим» именам и ключам. */
function schemaSource(data: () => SqlCompletionData): CompletionSource {
  return (context) => {
    if (context.state.readOnly) return null
    const sql = contextOf(context)
    if (sql.kind !== 'table' && sql.kind !== 'member' && sql.kind !== 'general') return null
    // В выражении список не всплывает на каждый пробел — только на набранное или по Ctrl+Space
    if (sql.kind === 'general' && !sql.query && !sql.quoted && !context.explicit) return null
    const { schema, texts } = data()
    const options = schemaCandidates(schema, sql).map((candidate) =>
      schemaCompletion(candidate, sql.quoted, texts),
    )
    if (options.length === 0) return null
    return { from: sql.from, to: sql.to, options, filter: false, getMatch }
  }
}

/** Параметры `{{name}}`: после `{{` — имена из списка, недостающие `}}` дописываются. */
function paramSource(data: () => SqlCompletionData): CompletionSource {
  return (context) => {
    if (context.state.readOnly) return null
    const sql = contextOf(context)
    if (sql.kind !== 'param') return null
    const { params, texts } = data()
    const options: Completion[] = []
    for (const param of params) {
      const match = matchName(sql.query, param.name, param.label)
      if (!match) continue
      options.push(
        withMatch(
          {
            label: param.name,
            detail: param.label ?? texts.param,
            type: 'param',
            apply: sql.close ? `${param.name}}}` : param.name,
          },
          match.secondary ? null : match.range,
        ),
      )
    }
    if (options.length === 0) return null
    return { from: sql.from, to: sql.to, options, filter: false, getMatch }
  }
}

/** Слово латиницей, которое можно дополнить ключевым словом или функцией. */
const ASCII_WORD = /^[A-Za-z_][\w$]*$/

function wordSpan(context: CompletionContext, sql: SqlCompletionContext) {
  if (sql.kind !== 'general' && sql.kind !== 'table' && sql.kind !== 'alias') return null
  if (sql.kind === 'alias') {
    const word = context.matchBefore(/[A-Za-z_][\w$]*$/)
    return word || context.explicit ? { from: word ? word.from : context.pos } : null
  }
  if (sql.quoted || (sql.query && !ASCII_WORD.test(sql.query))) return null
  return sql.query || context.explicit ? { from: sql.from } : null
}

/** Вставка `name(` со скобкой, которую closeBrackets закроет и сможет «перепрыгнуть». */
function applyFunction(noArgs: boolean) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const name = completion.label
    if (noArgs) {
      view.dispatch({
        changes: { from, to, insert: `${name}()` },
        selection: { anchor: from + name.length + 2 },
        scrollIntoView: true,
        userEvent: 'input.complete',
        annotations: pickedCompletion.of(completion),
      })
      return
    }
    const at = from + name.length
    const inserted = view.state.update({
      changes: { from, to, insert: name },
      selection: { anchor: at },
      scrollIntoView: true,
      userEvent: 'input.complete',
      annotations: pickedCompletion.of(completion),
    })
    // Перед словом closeBrackets пару не ставит — тогда только открывающая скобка
    const bracket =
      insertBracket(inserted.state, '(') ??
      inserted.state.update({ changes: { from: at, insert: '(' }, selection: { anchor: at + 1 } })
    view.dispatch([inserted, bracket])
  }
}

const functionOptions = new WeakMap<readonly SqlEditorFunction[], Completion[]>()

function functionSource(data: () => SqlCompletionData): CompletionSource {
  return (context): CompletionResult | null => {
    if (context.state.readOnly) return null
    const sql = contextOf(context)
    if (sql.kind !== 'general') return null
    const span = wordSpan(context, sql)
    if (!span) return null
    const { functions } = data()
    let options = functionOptions.get(functions)
    if (!options) {
      options = functions.map((item) => ({
        label: item.name,
        detail: item.signature,
        info: item.description,
        type: 'function',
        apply: applyFunction(item.signature === '()'),
      }))
      functionOptions.set(functions, options)
    }
    return { from: span.from, options, validFor: /^[\w$]*$/ }
  }
}

/** Ключевые слова и типы PostgreSQL — прописными; имена функций — из списка функций. */
function keywordSource(data: () => SqlCompletionData): CompletionSource {
  let cache: { functions: readonly SqlEditorFunction[]; options: Completion[] } | null = null
  const build = (functions: readonly SqlEditorFunction[]) => {
    const names = new Set(functions.map((item) => item.name.toLowerCase()))
    const words = (list: string | undefined, type: string) =>
      (list ?? '')
        .split(' ')
        .filter((word) => word && !names.has(word))
        .map((word) => ({ label: word.toUpperCase(), type, boost: -1 }))
    const seen = new Set<string>()
    return [
      ...words(PostgreSQL.spec.keywords, 'keyword'),
      ...words(PostgreSQL.spec.types, 'type'),
    ].filter((option) => !seen.has(option.label) && seen.add(option.label))
  }
  return (context) => {
    if (context.state.readOnly) return null
    const sql = contextOf(context)
    const span = wordSpan(context, sql)
    if (!span) return null
    const { functions } = data()
    if (cache?.functions !== functions) cache = { functions, options: build(functions) }
    return { from: span.from, options: cache.options, validFor: /^[\w$]*$/ }
  }
}

/**
 * Источники подсказок SQL-редактора. Порядок в списке: схема и параметры
 * (`filter: false` — своя сортировка, всегда сверху), затем функции и ключевые слова.
 */
export function sqlCompletionSources(data: () => SqlCompletionData): CompletionSource[] {
  return [paramSource(data), schemaSource(data), functionSource(data), keywordSource(data)]
}
