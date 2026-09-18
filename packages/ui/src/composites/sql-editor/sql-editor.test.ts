import {
  type Completion,
  CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { PostgreSQL, sql } from '@codemirror/lang-sql'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { SQL_EDITOR_FUNCTIONS } from './functions.js'
import { type SqlCompletionData, sqlCompletionSources } from './sql-completion.js'
import { sqlCompletionContext } from './sql-context.js'
import { toEditorDiagnostics } from './sql-diagnostics.js'
import { quoteSqlIdentifier, sqlPositionToOffset } from './sql-identifier.js'
import { lexSql } from './sql-lexer.js'
import type { SqlEditorTable } from './types.js'

const SCHEMA: SqlEditorTable[] = [
  {
    name: 'Происшествия',
    key: 'incidents',
    columns: [
      { label: 'Дата происшествия', key: 'incident_date', type: 'Дата' },
      { label: 'Район', key: 'district', type: 'Текст' },
      { label: 'Ущерб', key: 'damage', type: 'Число' },
      { label: 'Отчёт', key: 'report' },
      { label: 'Население_2020', key: 'population_2020' },
    ],
  },
  {
    name: 'Районы',
    key: 'districts',
    columns: [
      { label: 'Район', key: 'name', type: 'Текст' },
      { label: 'Население', key: 'population', type: 'Число' },
    ],
  },
  { name: 'Дорожные происшествия 2024', columns: [{ label: 'ДТП', key: 'accidents' }] },
]

const DATA: SqlCompletionData = {
  schema: SCHEMA,
  params: [
    { name: 'from', label: 'Начало периода' },
    { name: 'district', label: 'Район' },
  ],
  functions: SQL_EDITOR_FUNCTIONS,
  texts: { table: 'таблица', param: 'параметр' },
}

/** Текст с курсором `|`. */
function at(doc: string) {
  const pos = doc.indexOf('|')
  return { text: doc.slice(0, pos) + doc.slice(pos + 1), pos }
}

function context(doc: string) {
  const { text, pos } = at(doc)
  return sqlCompletionContext(text, pos)
}

const [paramSource, schemaSource, functionSource, keywordSource] = sqlCompletionSources(
  () => DATA,
) as [CompletionSource, CompletionSource, CompletionSource, CompletionSource]

function complete(
  source: CompletionSource,
  doc: string,
  { explicit = false, readOnly = false } = {},
): CompletionResult | null {
  const { text, pos } = at(doc)
  const state = EditorState.create({
    doc: text,
    selection: { anchor: pos },
    extensions: [sql({ dialect: PostgreSQL }), EditorState.readOnly.of(readOnly)],
  })
  return source(new CompletionContext(state, pos, explicit)) as CompletionResult | null
}

const shown = (options: readonly Completion[]) => options.map((o) => o.displayLabel ?? o.label)

describe('лексер SQL', () => {
  it('строки, комментарии, кавычки, параметры, имена на любом алфавите', () => {
    const text =
      "SELECT \"Дата\", 'it''s', E'a\\'b', $x$ ; $x$ FROM Население_2020 -- к\n/* a /* b */ c */ {{ from }} $1 1.5e3::int"
    const tokens = lexSql(text).map((t) => [t.type, text.slice(t.from, t.to)])
    expect(tokens).toEqual([
      ['word', 'SELECT'],
      ['quoted', '"Дата"'],
      ['comma', ','],
      ['string', "'it''s'"],
      ['comma', ','],
      ['string', "E'a\\'b'"],
      ['comma', ','],
      ['string', '$x$ ; $x$'],
      ['word', 'FROM'],
      ['word', 'Население_2020'],
      ['comment', '-- к'],
      ['comment', '/* a /* b */ c */'],
      ['param', '{{ from }}'],
      ['positional', '$1'],
      ['number', '1.5e3'],
      ['operator', '::'],
      ['word', 'int'],
    ])
  })

  it('незакрытые литералы и параметр тянутся до конца, параметр — до конца имени', () => {
    expect(lexSql("'abc").at(-1)).toMatchObject({ type: 'string', closed: false, to: 4 })
    expect(lexSql('"Дат').at(-1)).toMatchObject({ type: 'quoted', closed: false })
    expect(lexSql('/* x').at(-1)).toMatchObject({ type: 'comment', closed: false })
    expect(lexSql('{{ fro ')[0]).toMatchObject({ type: 'param', closed: false, from: 0, to: 6 })
  })
})

describe('имена в тексте запроса', () => {
  it('кавычки — только когда без них Postgres прочтёт имя иначе', () => {
    expect(quoteSqlIdentifier('Происшествия')).toBe('Происшествия')
    expect(quoteSqlIdentifier('incident_date')).toBe('incident_date')
    expect(quoteSqlIdentifier('Население_2020')).toBe('Население_2020')
    expect(quoteSqlIdentifier('Дата происшествия')).toBe('"Дата происшествия"')
    expect(quoteSqlIdentifier('ID')).toBe('"ID"')
    expect(quoteSqlIdentifier('order')).toBe('"order"')
    expect(quoteSqlIdentifier('2024')).toBe('"2024"')
    expect(quoteSqlIdentifier('Сводка «Паводок»')).toBe('"Сводка «Паводок»"')
    expect(quoteSqlIdentifier('a"b')).toBe('"a""b"')
  })

  it('позиция ошибки Postgres (с 1, в символах) → смещение UTF-16', () => {
    const text = "SELECT '😀' + x"
    expect(sqlPositionToOffset(text, 1)).toBe(0)
    // x — 14-й символ, но 15-я единица UTF-16: эмодзи занимает две
    expect(sqlPositionToOffset(text, 14)).toBe(text.indexOf('x'))
    expect(sqlPositionToOffset(text, 999)).toBe(text.length)
  })
})

describe('контекст автодополнения', () => {
  it('после FROM, JOIN и запятой списка FROM — имя таблицы', () => {
    expect(context('SELECT * FROM |')).toMatchObject({ kind: 'table', query: '' })
    expect(context('SELECT * FROM Про|')).toMatchObject({ kind: 'table', query: 'Про', from: 14 })
    expect(context('SELECT * FROM a JOIN "Дор| x')).toMatchObject({
      kind: 'table',
      query: 'Дор',
      quoted: true,
    })
    expect(context('SELECT * FROM a, |')).toMatchObject({ kind: 'table' })
    expect(context('SELECT a, |')).toMatchObject({ kind: 'general' })
    expect(context('SELECT * FROM t WHERE x IN (1, |')).toMatchObject({ kind: 'general' })
  })

  it('через точку — поле таблицы или псевдонима, таблицы оператора известны', () => {
    const member = context('SELECT п.| FROM Происшествия AS п JOIN Районы р ON true')
    expect(member).toMatchObject({ kind: 'member', qualifier: { value: 'п', quoted: false } })
    expect(member.kind === 'member' && member.refs).toEqual([
      { name: { value: 'Происшествия', quoted: false }, alias: { value: 'п', quoted: false } },
      { name: { value: 'Районы', quoted: false }, alias: { value: 'р', quoted: false } },
    ])
    expect(context('SELECT "Дорожные происшествия 2024"."Д|')).toMatchObject({
      kind: 'member',
      quoted: true,
      qualifier: { value: 'Дорожные происшествия 2024', quoted: true },
    })
  })

  it('внутри строки, комментария и $1 подсказок нет; после таблицы — псевдоним', () => {
    expect(context("SELECT 'Про|'")).toEqual({ kind: 'none' })
    expect(context('-- Про|')).toEqual({ kind: 'none' })
    expect(context('SELECT $1|')).toEqual({ kind: 'none' })
    expect(context('SELECT * FROM Происшествия |')).toEqual({ kind: 'alias' })
    expect(context('SELECT * FROM Происшествия AS |')).toEqual({ kind: 'alias' })
  })

  it('параметр {{…}}: открытый — с закрывающими скобками, закрытый — только имя', () => {
    expect(context('WHERE d >= {{fr|')).toMatchObject({ kind: 'param', query: 'fr', close: true })
    expect(context('WHERE d >= {{|}}')).toMatchObject({ kind: 'param', query: '', close: false })
  })

  it('таблицы — только текущего оператора', () => {
    const general = context('SELECT 1 FROM Районы; SELECT | FROM Происшествия')
    expect(general.kind === 'general' && general.refs.map((r) => r.name.value)).toEqual([
      'Происшествия',
    ])
  })
})

describe('подсказки по «человеческим» именам и ключам', () => {
  it('поля таблицы через псевдоним: вставка с кавычками, где они нужны', () => {
    const result = complete(schemaSource, 'SELECT п.| FROM Происшествия п')
    expect(result?.filter).toBe(false)
    expect(shown(result?.options ?? [])).toEqual([
      'Дата происшествия',
      'Район',
      'Ущерб',
      'Отчёт',
      'Население_2020',
    ])
    expect(result?.options.map((o) => o.label)).toEqual([
      '"Дата происшествия"',
      'Район',
      'Ущерб',
      'Отчёт',
      'Население_2020',
    ])
    expect(result?.options[0]?.detail).toBe('incident_date · Дата')
  })

  it('поиск по ключу вставляет ключ, по подписи — подпись; «е» и «ё» не различаются', () => {
    const byKey = complete(schemaSource, 'SELECT п.inc| FROM Происшествия п')
    expect(byKey?.options[0]).toMatchObject({
      label: 'incident_date',
      displayLabel: 'incident_date',
      detail: 'Дата происшествия · Дата',
    })
    const byLabel = complete(schemaSource, 'SELECT Происшествия.отчет|')
    expect(byLabel?.options.map((o) => o.label)).toEqual(['Отчёт'])
    // Имя таблицы в запросе — «человеческое»: поле найдено через `Происшествия.`
    const byTableKey = complete(schemaSource, 'SELECT incidents.дат|')
    expect(byTableKey?.options.map((o) => o.label)).toEqual(['"Дата происшествия"'])
  })

  it('таблицы после FROM: начало имени раньше начала слова; в кавычках — с кавычками', () => {
    const tables = complete(schemaSource, 'SELECT * FROM про|')
    expect(shown(tables?.options ?? [])).toEqual(['Происшествия', 'Дорожные происшествия 2024'])
    expect(tables?.options[1]?.label).toBe('"Дорожные происшествия 2024"')
    const doc = 'SELECT * FROM "дор|"'
    const quoted = complete(schemaSource, doc)
    expect(quoted?.options[0]?.label).toBe('"Дорожные происшествия 2024"')
    // Заменяется весь идентификатор вместе с кавычками
    expect(quoted).toMatchObject({ from: doc.indexOf('"'), to: doc.length - 1 })
  })

  it('в выражении — поля таблиц оператора; без набранного — только по Ctrl+Space', () => {
    const doc = 'SELECT ущ| FROM Происшествия'
    expect(shown(complete(schemaSource, doc)?.options ?? [])).toEqual(['Ущерб'])
    expect(complete(schemaSource, 'SELECT | FROM Происшествия')).toBeNull()
    const explicit = complete(schemaSource, 'SELECT | FROM Происшествия', { explicit: true })
    expect(shown(explicit?.options ?? []).slice(0, 5)).toEqual([
      'Дата происшествия',
      'Район',
      'Ущерб',
      'Отчёт',
      'Население_2020',
    ])
    // Одинаковые подписи из двух таблиц различает имя таблицы
    const two = complete(schemaSource, 'SELECT рай| FROM Происшествия, Районы')
    expect(two?.options.map((o) => o.detail)).toEqual([
      'district · Текст · Происшествия',
      'name · Текст · Районы',
      'districts · таблица',
    ])
  })

  it('параметры после {{ и нет подсказок в режиме «только чтение»', () => {
    const open = complete(paramSource, 'WHERE d >= {{|')
    expect(open?.options.map((o) => [o.label, o.apply, o.detail])).toEqual([
      ['from', 'from}}', 'Начало периода'],
      ['district', 'district}}', 'Район'],
    ])
    const closed = complete(paramSource, 'WHERE d >= {{fr|}}')
    expect(closed?.options.map((o) => o.apply)).toEqual(['from'])
    expect(complete(paramSource, 'WHERE d >= {{|', { readOnly: true })).toBeNull()
    expect(complete(schemaSource, 'SELECT * FROM |', { readOnly: true })).toBeNull()
  })

  it('ключевые слова и функции — латиницей и не после точки', () => {
    const keywords = complete(keywordSource, 'SEL|')
    expect(keywords?.options.some((o) => o.label === 'SELECT')).toBe(true)
    // Имена функций не дублируются ключевыми словами
    expect(keywords?.options.some((o) => o.label === 'COUNT')).toBe(false)
    expect(complete(keywordSource, 'SELECT п.se| FROM Происшествия п')).toBeNull()
    expect(complete(keywordSource, 'SELECT Про|')).toBeNull()
    const functions = complete(functionSource, 'SELECT date_t|')
    expect(functions?.options.find((o) => o.label === 'date_trunc')?.detail).toBe('(unit, value)')
    expect(complete(functionSource, 'SELECT * FROM da|')).toBeNull()
  })
})

describe('диагностика', () => {
  const text = 'SELECT * FROM Происшествие\nWHERE x'
  it('позиция без конца — подчёркивается токен, в пределах строки', () => {
    const [diagnostic] = toEditorDiagnostics(text, [{ from: 14, message: 'нет таблицы' }])
    expect(diagnostic).toMatchObject({ from: 14, to: 26, severity: 'error' })
  })

  it('позиции за пределами текста обрезаются, в конце текста — точка', () => {
    const list = toEditorDiagnostics(text, [
      { from: 999, message: 'конец' },
      { from: -5, to: 3, message: 'начало', severity: 'warning' },
    ])
    expect(list.map((d) => [d.from, d.to, d.severity])).toEqual([
      [text.length, text.length, 'error'],
      [0, 3, 'warning'],
    ])
  })
})
