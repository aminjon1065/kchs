import type { QueryResultField, QuerySpec } from '@kchs/contracts'
import { cacheKey, DEFAULT_MAX_ROWS, DEFAULT_TIMEOUT_MS } from '../compiler/compile.js'
import { similarNames } from '../compiler/scope.js'
import { datasetRelation } from '../compiler/sources.js'
import { CompileState } from '../compiler/state.js'
import { QueryCompileError } from '../errors.js'
import type { ExprValue } from '../expr/compile.js'
import type {
  CompileContext,
  CompiledRawSql,
  RawSqlColumn,
  RawSqlContext,
  SqlDataset,
  SqlSourceSegment,
} from '../types.js'
import { sqlTypeOfValue, type ValueType } from '../value-types.js'
import {
  type Analysis,
  type AnalyzeOptions,
  analyzeSql,
  type Edit,
  type Output,
  type ParseTree,
  type TableCatalog,
} from './analyze.js'
import {
  extractPlaceholders,
  invalidCharacter,
  type Placeholder,
  quoteIdent,
  SourcePositions,
  SQL_PATH,
  sqlFail,
  truncateIdent,
} from './text.js'

/** Предел длины запроса — как у источника `sql` в контракте QuerySpec. */
const MAX_SQL_LENGTH = 100_000
/** Алиас внешней обёртки: предел строк и подсчёт поверх запроса пользователя. */
const WRAPPER = '"__kchs_sql"'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Датасеты по имени таблицы: сначала точное совпадение, затем без учёта регистра. */
class DatasetCatalog implements TableCatalog {
  private readonly exact = new Map<string, SqlDataset[]>()
  private readonly lower = new Map<string, SqlDataset[]>()
  private readonly names: string[] = []

  constructor(datasets: readonly SqlDataset[]) {
    for (const dataset of datasets) {
      for (const name of [dataset.name, ...(dataset.aliases ?? [])]) {
        if (!name) continue
        const key = truncateIdent(name)
        add(this.exact, key, dataset)
        add(this.lower, key.toLowerCase(), dataset)
        this.names.push(name)
      }
    }
  }

  find(name: string, position: number): SqlDataset | null {
    for (const found of [this.exact.get(name), this.lower.get(name.toLowerCase())]) {
      if (!found?.length) continue
      if (found.length > 1) {
        sqlFail(`Название «${name}» у нескольких датасетов`, position, 'Переименуйте один из них')
      }
      return found[0] as SqlDataset
    }
    return null
  }

  similar(name: string): string[] {
    return similarNames(this.names, name).map(quoteIdent)
  }
}

function add(map: Map<string, SqlDataset[]>, key: string, dataset: SqlDataset): void {
  const list = map.get(key)
  if (!list) map.set(key, [dataset])
  else if (!list.some((item) => item.id === dataset.id)) list.push(dataset)
}

/** Слишком глубокая вложенность: переполнение стека при разборе или обходе дерева. */
const TOO_DEEP = 'Запрос слишком сложный: уменьшите вложенность выражений и подзапросов'

/** Ошибка разборщика Postgres → понятное сообщение с позицией. */
function translateSyntaxError(message: string): { message: string; hint?: string } {
  const near = /^syntax error at or near "(.*)"$/s.exec(message)
  if (near) return { message: `Синтаксическая ошибка рядом с «${near[1]}»` }
  if (message === 'syntax error at end of input') {
    return { message: 'Синтаксическая ошибка: запрос обрывается' }
  }
  const known: Array<[RegExp, string]> = [
    [/^unterminated quoted string/, 'Не закрыта строка в одинарных кавычках'],
    [/^unterminated quoted identifier/, 'Не закрыто имя в двойных кавычках'],
    [/^unterminated \/\* comment/, 'Не закрыт комментарий /* … */'],
    [/^unterminated dollar-quoted string/, 'Не закрыта строка в долларовых кавычках'],
    [/^zero-length delimited identifier/, 'Пустое имя в двойных кавычках'],
    [/^trailing junk after/, 'Недопустимое число или параметр'],
    [/^memory exhausted/, TOO_DEEP],
  ]
  for (const [pattern, text] of known) if (pattern.test(message)) return { message: text }
  return { message: 'Синтаксическая ошибка в SQL', hint: message }
}

let parser: Promise<typeof import('libpg-query')> | null = null

/**
 * Разборщик Postgres 17 (libpg-query, WASM) загружается при первом сыром SQL:
 * модуль компилирует WASM при импорте, и остальным путям API он не нужен.
 */
async function parseTree(text: string): Promise<ParseTree> {
  parser ??= import('libpg-query')
  const { parse } = await parser
  return (await parse(text)) as ParseTree
}

async function parseSql(text: string): Promise<ParseTree> {
  try {
    return await parseTree(text)
  } catch (error) {
    if (error instanceof RangeError) sqlFail(TOO_DEEP, 0)
    const details = (error as { sqlDetails?: { message?: unknown; cursorPosition?: unknown } })
      .sqlDetails
    if (details && typeof details.message === 'string') {
      const translated = translateSyntaxError(details.message)
      const cursor = typeof details.cursorPosition === 'number' ? details.cursorPosition : 0
      const position = new SourcePositions(text).fromCodePoint(cursor)
      throw new QueryCompileError([
        {
          path: [...SQL_PATH],
          message: translated.message,
          position,
          ...(translated.hint ? { hint: translated.hint } : {}),
        },
      ])
    }
    throw error
  }
}

/** Проверка оператора; переполнение стека на глубоком дереве — понятная ошибка. */
function analyze(text: string, tree: ParseTree, options: AnalyzeOptions): Analysis {
  try {
    return analyzeSql(text, tree, options)
  } catch (error) {
    if (error instanceof RangeError) sqlFail(TOO_DEEP, 0)
    throw error
  }
}

/** Текст, параметры и дерево разбора; пустой и слишком длинный запрос — ошибка. */
async function prepare(
  sql: string,
): Promise<{ text: string; placeholders: Placeholder[]; tree: ParseTree }> {
  if (sql.length > MAX_SQL_LENGTH) sqlFail('Запрос длиннее 100 000 символов', MAX_SQL_LENGTH)
  const invalid = invalidCharacter(sql)
  if (invalid >= 0) sqlFail('Недопустимый символ в запросе', invalid)
  if (sql.trim() === '') sqlFail('Пустой запрос: напишите SELECT', 0)
  const { text, placeholders } = extractPlaceholders(sql)
  const tree = await parseSql(text)
  return { text, placeholders, tree }
}

/**
 * Имена таблиц запроса (кроме CTE) — чтобы загрузить только нужные датасеты с
 * политиками до `compileRawSql`. Запрос заодно проверяется: разбор, операторы,
 * функции, типы (ошибки — `QueryCompileError`).
 */
export async function rawSqlTables(sql: string): Promise<string[]> {
  const { text, placeholders, tree } = await prepare(sql)
  return analyze(text, tree, { catalog: null, placeholders }).tables
}

/**
 * Сырой SQL SQL-лаборатории → безопасный параметризованный SQL (06-analytics-engine.md
 * §6, 17-security.md): разбор libpg-query, белые списки узлов, функций и типов,
 * имена датасетов → подзапросы с политиками пользователя (тот же код, что у
 * QuerySpec), подписи полей → ключи, `{{параметр}}` → `$n`. Выполнять — под ролью
 * `kchs_query` в транзакции только для чтения с тайм-аутом (как QuerySpec).
 */
export async function compileRawSql(sql: string, ctx: RawSqlContext): Promise<CompiledRawSql> {
  const { text, placeholders, tree } = await prepare(sql)
  const analysis = analyze(text, tree, {
    catalog: new DatasetCatalog(ctx.datasets),
    placeholders,
  })
  const maxRows = ctx.maxRows === undefined ? DEFAULT_MAX_ROWS : ctx.maxRows
  if (maxRows !== null && (!Number.isInteger(maxRows) || maxRows < 0)) {
    throw new Error(`maxRows — неотрицательное целое, а передано: ${maxRows}`)
  }
  const spec: QuerySpec = {
    version: 1,
    source: { kind: 'sql', sql },
    steps: [],
    params: { ...ctx.paramDefs },
    options: { cache: true, approxCount: true },
  }
  const compileCtx: CompileContext = {
    ...ctx,
    datasets: new Map(ctx.datasets.map((dataset) => [dataset.id, dataset])),
  }
  const state = new CompileState(compileCtx, spec)
  const edits: Edit[] = [...analysis.edits]

  // Параметры — в порядке появления в тексте: $1, $2…
  const ordered = [...analysis.params].sort((a, b) => a.start - b.start)
  for (const placeholder of ordered) {
    const resolved = atPosition(placeholder.start, () =>
      state.paramExpr(placeholder.name, [...SQL_PATH]),
    )
    const list = ctx.paramDefs?.[placeholder.name]?.type === 'list'
    edits.push({
      start: placeholder.start,
      end: placeholder.end,
      text: `(${bindParam(state, placeholder, resolved, list)})`,
    })
  }

  // Датасеты — подзапрос с политиками на месте каждого имени таблицы
  const relations = new Map<string, Map<string, QueryResultField>>()
  const tables = new Set<string>()
  for (const { dataset, refs } of analysis.datasets.values()) {
    const { body, columns } = datasetRelation(
      state,
      dataset,
      null,
      [...SQL_PATH],
      analysis.systemColumns,
    )
    tables.add(dataset.table)
    relations.set(
      dataset.id,
      new Map(
        columns.map((column) => [
          column.name,
          {
            name: column.name,
            type: column.meta.fieldType,
            semantic: column.meta.semantic,
            label: column.meta.label,
            format: column.meta.format,
          },
        ]),
      ),
    )
    for (const ref of refs) {
      edits.push({
        start: ref.start,
        end: ref.end,
        text: `(${body})${ref.alias === null ? '' : ` AS ${quoteIdent(ref.alias)}`}`,
      })
    }
  }

  const prefix = 'SELECT * FROM (\n'
  const { body, segments } = applyEdits(text, analysis.statement, edits, prefix.length)
  const wrapped = `${prefix}${body}\n) AS ${WRAPPER}`
  const finalSql = maxRows === null ? wrapped : `${wrapped}\nLIMIT ${maxRows + 1}`
  const countSql = `SELECT count(*) AS "count" FROM (\n${body}\n) AS ${WRAPPER}`
  const params = state.binder.values
  await verifyRewritten(finalSql, tables, params.length)

  if (analysis.usesTime) state.usesTime = true
  return {
    sql: finalSql,
    params,
    sourceMap: segments,
    fields: resultColumns(analysis.outputs, relations),
    countSql,
    countParams: [...params],
    maxRows,
    timeoutMs: ctx.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    timezone: state.timezone,
    datasets: [...analysis.datasets.keys()],
    cacheable: !analysis.volatile,
    cacheKeyParts: cacheKey(state, spec, maxRows),
  }
}

/** Ошибка значения параметра получает позицию `{{…}}` в тексте. */
function atPosition<T>(position: number, run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof QueryCompileError) {
      throw new QueryCompileError(
        error.issues.map((issue) => ({ ...issue, position: issue.position ?? position })),
      )
    }
    throw error
  }
}

/**
 * Значение параметра → `$n`. Объявленный тип — приведение (`$1::date`), список —
 * массив (`= ANY({{районы}})`); без объявления тип выводит Postgres по месту
 * (сравнение с полем, LIMIT…).
 */
function bindParam(
  state: CompileState,
  placeholder: Placeholder,
  resolved: ExprValue,
  list: boolean,
): string {
  const key = `sql:${placeholder.name}`
  const { type } = resolved
  let value = resolved.value instanceof Date ? resolved.value.toISOString() : resolved.value
  if (value === null || value === undefined) {
    return type ? `NULL::${sqlTypeOfValue(type)}${resolved.array || list ? '[]' : ''}` : 'NULL'
  }
  if (list && !Array.isArray(value)) value = [value]
  if (Array.isArray(value)) {
    const items = value.map((item) => (item instanceof Date ? item.toISOString() : item))
    const element = type ?? inferElementType(items, placeholder)
    return state.binder.once(key, items, `${sqlTypeOfValue(element)}[]`)
  }
  if (typeof value === 'object') {
    return `${state.binder.once(key, JSON.stringify(value), 'text')}::jsonb`
  }
  return state.binder.once(key, value, type ? sqlTypeOfValue(type) : undefined)
}

/** Тип элементов списка без объявления: строки (ссылки), числа или логические. */
function inferElementType(items: unknown[], placeholder: Placeholder): ValueType {
  const present = items.filter((item) => item !== null && item !== undefined)
  if (present.every((item) => typeof item === 'number')) return 'number'
  if (present.every((item) => typeof item === 'boolean')) return 'boolean'
  if (present.every((item) => typeof item === 'string')) {
    return present.length > 0 && present.every((item) => UUID.test(item as string))
      ? 'uuid'
      : 'text'
  }
  return sqlFail(
    `Параметр {{${placeholder.name}}}: значения списка разных типов`,
    placeholder.start,
  )
}

/**
 * Текст оператора с правками и карта участков: какой участок итогового SQL
 * (со сдвигом `offset` обёртки) взят из какого места исходного текста.
 */
function applyEdits(
  text: string,
  span: { start: number; end: number },
  edits: Edit[],
  offset: number,
): { body: string; segments: SqlSourceSegment[] } {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  const segments: SqlSourceSegment[] = []
  let body = ''
  let position = span.start
  const copy = (end: number) => {
    if (end > position) {
      segments.push({
        at: offset + body.length,
        source: position,
        length: end - position,
        exact: true,
      })
      body += text.slice(position, end)
    }
  }
  for (const edit of sorted) {
    if (edit.start < position || edit.end > span.end) {
      throw new Error('Правки сырого SQL пересекаются или выходят за оператор')
    }
    copy(edit.start)
    segments.push({
      at: offset + body.length,
      source: edit.start,
      length: edit.text.length,
      exact: false,
    })
    body += edit.text
    position = edit.end
  }
  copy(span.end)
  return { body, segments }
}

/**
 * Позиция ошибки Postgres при выполнении (`position`: с 1, в символах итогового
 * SQL) → индекс в исходном тексте запроса пользователя. Внутри подставленного
 * текста (подзапрос датасета, параметр) — начало заменённого имени; в обёртке —
 * null.
 */
export function rawSqlErrorPosition(compiled: CompiledRawSql, position: number): number | null {
  const index = new SourcePositions(compiled.sql).fromCodePoint(position - 1)
  const segment = compiled.sourceMap.find(
    (item) => index >= item.at && index < item.at + item.length,
  )
  if (!segment) return null
  return segment.exact ? segment.source + (index - segment.at) : segment.source
}

/**
 * Защита в глубину: переписанный запрос разбирается ещё раз. Один SELECT; таблицы —
 * только физические таблицы датасетов запроса (`ds.t_…`) и служебные CTE; номера
 * параметров — в пределах связанных значений. Иначе переписывание ошиблось, и
 * запрос не выполняется.
 */
async function verifyRewritten(
  sql: string,
  tables: ReadonlySet<string>,
  paramCount: number,
): Promise<void> {
  const tree = await parseTree(sql)
  const statements = tree.stmts ?? []
  const first = statements[0]?.stmt
  const broken = (reason: string): never => {
    throw new Error(`Переписанный SQL не прошёл проверку: ${reason}`)
  }
  if (statements.length !== 1 || !first || typeof first !== 'object' || !('SelectStmt' in first)) {
    broken('ожидался один SELECT')
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'intoClause' || key === 'lockingClause') broken(key)
      if (key === 'RangeVar' && child && typeof child === 'object') {
        const range = child as { schemaname?: string; catalogname?: string; relname?: string }
        const qualified = `${range.schemaname ?? ''}.${range.relname ?? ''}`
        const physical = range.catalogname === undefined && tables.has(qualified)
        const cte = range.schemaname === undefined && /^__kchs_cte_\d+$/.test(range.relname ?? '')
        if (!physical && !cte) broken(`таблица ${qualified}`)
      }
      if (key === 'ParamRef' && child && typeof child === 'object') {
        const number = (child as { number?: number }).number ?? 0
        if (number < 1 || number > paramCount) broken(`параметр $${number}`)
      }
      visit(child)
    }
  }
  visit(first)
}

/** Столбцы результата с описаниями полей датасетов; null — если есть неизвестные. */
function resultColumns(
  outputs: readonly Output[],
  relations: ReadonlyMap<string, ReadonlyMap<string, QueryResultField>>,
): RawSqlColumn[] | null {
  const columns: RawSqlColumn[] = []
  for (const output of outputs) {
    if (output.kind === 'unknown') return null
    if (output.kind === 'dataset') {
      const relation = relations.get(output.datasetId)
      if (!relation) return null
      for (const field of relation.values()) columns.push({ name: field.name, field })
      continue
    }
    const meta = output.field
      ? relations.get(output.field.datasetId)?.get(output.field.column)
      : undefined
    columns.push({
      name: output.name,
      field: meta && output.name !== null ? { ...meta, name: output.name } : null,
    })
  }
  return columns
}
