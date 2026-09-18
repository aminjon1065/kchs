import { similarNames } from '../compiler/scope.js'
import { SYSTEM_COLUMNS } from '../compiler/sources.js'
import type { ResolvedField, SqlDataset } from '../types.js'
import { valueTypeOfField } from '../value-types.js'
import {
  isAllowedFunction,
  isAllowedType,
  isDeniedFunction,
  OPERATOR,
  TIME_VALUE_FUNCTIONS,
  TIME_VALUE_NAMES,
  VOLATILE_FUNCTIONS,
} from './allowlist.js'
import {
  type Placeholder,
  quoteIdent,
  readIdentifier,
  readIdentifierChain,
  SourcePositions,
  sqlFail,
  truncateIdent,
} from './text.js'

/**
 * Проверка и разбор имён сырого SQL по дереву libpg-query (06-analytics-engine.md
 * §6, 17-security.md). Каждый узел дерева проверяется по белому списку типов
 * узлов и их полей: неизвестный узел или поле — отказ. Попутно собираются правки
 * текста: имена датасетов → подзапросы с политиками, имена CTE → служебные,
 * подписи полей → ключи, `{{параметры}}` → `$n`.
 *
 * Каждая ссылка на таблицу (RangeVar) переписывается: на датасет из контекста
 * или на служебное имя CTE `__kchs_cte_N`. Если разбор областей видимости
 * ошибётся, Postgres не найдёт служебное имя и запрос упадёт — но не прочитает
 * таблицу мимо политик.
 */

type Obj = Record<string, unknown>

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

const SYSTEM_NAMES = new Set(SYSTEM_COLUMNS.map((column) => column.name))
const CTE_PREFIX = '__kchs_cte_'
const FUNCTION_HINT =
  'Доступны агрегаты, оконные, математические и строковые функции, функции дат, JSON, массивов и PostGIS'
const TYPE_HINT =
  'Доступны числа, строки, логический тип, даты и время, интервалы, uuid, json/jsonb и геометрия'

/** Допустимые поля узлов дерева; узел вне списка или неизвестное поле — отказ. */
const NODE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  SelectStmt: [
    'distinctClause',
    'targetList',
    'fromClause',
    'whereClause',
    'groupClause',
    'groupDistinct',
    'havingClause',
    'windowClause',
    'valuesLists',
    'sortClause',
    'limitOffset',
    'limitCount',
    'limitOption',
    'withClause',
    'op',
    'all',
    'larg',
    'rarg',
  ],
  WithClause: ['ctes', 'recursive', 'location'],
  CommonTableExpr: ['ctename', 'aliascolnames', 'ctematerialized', 'ctequery', 'location'],
  ResTarget: ['name', 'val', 'location'],
  RangeVar: ['relname', 'inh', 'relpersistence', 'alias', 'location'],
  RangeSubselect: ['lateral', 'subquery', 'alias'],
  RangeFunction: ['lateral', 'ordinality', 'is_rowsfrom', 'functions', 'alias', 'coldeflist'],
  JoinExpr: [
    'jointype',
    'isNatural',
    'larg',
    'rarg',
    'usingClause',
    'join_using_alias',
    'quals',
    'alias',
  ],
  Alias: ['aliasname', 'colnames'],
  ColumnDef: ['colname', 'typeName', 'is_local', 'location'],
  ColumnRef: ['fields', 'location'],
  ParamRef: ['number', 'location'],
  A_Const: ['ival', 'fval', 'boolval', 'sval', 'bsval', 'isnull', 'location'],
  A_Expr: ['kind', 'name', 'lexpr', 'rexpr', 'location'],
  BoolExpr: ['boolop', 'args', 'location'],
  NullTest: ['arg', 'nulltesttype', 'argisrow', 'location'],
  BooleanTest: ['arg', 'booltesttype', 'location'],
  TypeCast: ['arg', 'typeName', 'location'],
  TypeName: ['names', 'typmods', 'typemod', 'arrayBounds', 'location'],
  FuncCall: [
    'funcname',
    'args',
    'agg_order',
    'agg_filter',
    'over',
    'agg_within_group',
    'agg_star',
    'agg_distinct',
    'func_variadic',
    'funcformat',
    'location',
  ],
  NamedArgExpr: ['arg', 'name', 'argnumber', 'location'],
  CaseExpr: ['arg', 'args', 'defresult', 'location'],
  CaseWhen: ['expr', 'result', 'location'],
  CoalesceExpr: ['args', 'location'],
  MinMaxExpr: ['op', 'args', 'location'],
  SQLValueFunction: ['op', 'typmod', 'location'],
  SubLink: ['subLinkType', 'subLinkId', 'testexpr', 'operName', 'subselect', 'location'],
  RowExpr: ['args', 'row_format', 'colnames', 'location'],
  A_ArrayExpr: ['elements', 'location'],
  A_Indirection: ['arg', 'indirection'],
  A_Indices: ['is_slice', 'lidx', 'uidx'],
  CollateClause: ['arg', 'collname', 'location'],
  GroupingFunc: ['args', 'location'],
  GroupingSet: ['kind', 'content', 'location'],
  SortBy: ['node', 'sortby_dir', 'sortby_nulls', 'useOp', 'location'],
  WindowDef: [
    'name',
    'refname',
    'partitionClause',
    'orderClause',
    'frameOptions',
    'startOffset',
    'endOffset',
    'location',
  ],
  JsonIsPredicate: ['expr', 'format', 'item_type', 'unique_keys', 'location'],
  JsonFormat: ['format_type', 'encoding', 'location'],
  List: ['items'],
  String: ['sval'],
  Integer: ['ival'],
  A_Star: [],
}

/** Поля «хвоста» SELECT, общие для всех форм: WITH, ORDER BY, LIMIT, OFFSET. */
const TAIL_FIELDS = ['withClause', 'sortClause', 'limitCount', 'limitOffset', 'limitOption', 'op']

/** Операторы, которые не являются запросом на чтение, — понятная причина отказа. */
const STATEMENTS: Readonly<Record<string, string>> = {
  InsertStmt: 'Изменение данных запрещено (INSERT)',
  UpdateStmt: 'Изменение данных запрещено (UPDATE)',
  DeleteStmt: 'Изменение данных запрещено (DELETE)',
  MergeStmt: 'Изменение данных запрещено (MERGE)',
  TruncateStmt: 'Изменение данных запрещено (TRUNCATE)',
  CopyStmt: 'COPY запрещён',
  DoStmt: 'Анонимные блоки кода (DO) запрещены',
  CallStmt: 'Вызов процедур (CALL) запрещён',
  VariableSetStmt: 'Изменение настроек сеанса (SET, RESET) запрещено',
  VariableShowStmt: 'SHOW запрещён',
  ExplainStmt: 'EXPLAIN запрещён',
  LockStmt: 'Блокировка таблиц (LOCK) запрещена',
  TransactionStmt: 'Управление транзакциями запрещено',
  GrantStmt: 'Выдача и отзыв прав (GRANT, REVOKE) запрещены',
  GrantRoleStmt: 'Выдача и отзыв ролей запрещены',
  PrepareStmt: 'Подготовленные операторы (PREPARE, EXECUTE) запрещены',
  ExecuteStmt: 'Подготовленные операторы (PREPARE, EXECUTE) запрещены',
  DeallocateStmt: 'Подготовленные операторы (PREPARE, EXECUTE) запрещены',
  ListenStmt: 'LISTEN и NOTIFY запрещены',
  NotifyStmt: 'LISTEN и NOTIFY запрещены',
  VacuumStmt: 'Обслуживание таблиц (VACUUM, ANALYZE) запрещено',
  DeclareCursorStmt: 'Курсоры запрещены',
  FetchStmt: 'Курсоры запрещены',
}

/** Узлы, которые разборщик понимает, а лаборатория не принимает. */
const UNSUPPORTED: Readonly<Record<string, string>> = {
  RangeTableSample: 'TABLESAMPLE не поддерживается',
  RangeTableFunc: 'XML в запросах не поддерживается',
  XmlExpr: 'XML в запросах не поддерживается',
  XmlSerialize: 'XML в запросах не поддерживается',
  JsonTable: 'JSON_TABLE не поддерживается: используйте функции jsonb_*',
  JsonFuncExpr:
    'SQL/JSON-функции не поддерживаются: используйте операторы ->, ->> и функции jsonb_*',
  JsonObjectConstructor:
    'SQL/JSON-функции не поддерживаются: используйте json_build_object и jsonb_build_object',
  JsonArrayConstructor:
    'SQL/JSON-функции не поддерживаются: используйте json_build_array и jsonb_build_array',
  JsonArrayQueryConstructor: 'SQL/JSON-функции не поддерживаются: используйте json_agg',
  JsonObjectAgg: 'SQL/JSON-функции не поддерживаются: используйте json_object_agg',
  JsonArrayAgg: 'SQL/JSON-функции не поддерживаются: используйте json_agg',
  JsonParseExpr: 'SQL/JSON-функции не поддерживаются: используйте приведение ::jsonb',
  JsonScalarExpr: 'SQL/JSON-функции не поддерживаются: используйте to_jsonb',
  JsonSerializeExpr: 'SQL/JSON-функции не поддерживаются: используйте приведение ::text',
  SetToDefault: 'DEFAULT недопустим в запросе на чтение',
  CurrentOfExpr: 'Курсоры запрещены',
  MergeSupportFunc: 'MERGE запрещён',
}

const SUBLINKS = new Set([
  'EXISTS_SUBLINK',
  'ALL_SUBLINK',
  'ANY_SUBLINK',
  'ROWCOMPARE_SUBLINK',
  'EXPR_SUBLINK',
  'ARRAY_SUBLINK',
])
const EXPR_KINDS = new Set([
  'AEXPR_OP',
  'AEXPR_OP_ANY',
  'AEXPR_OP_ALL',
  'AEXPR_DISTINCT',
  'AEXPR_NOT_DISTINCT',
  'AEXPR_NULLIF',
  'AEXPR_IN',
  'AEXPR_LIKE',
  'AEXPR_ILIKE',
  'AEXPR_SIMILAR',
])
const BETWEEN_KINDS = new Set([
  'AEXPR_BETWEEN',
  'AEXPR_NOT_BETWEEN',
  'AEXPR_BETWEEN_SYM',
  'AEXPR_NOT_BETWEEN_SYM',
])

type FieldLookup =
  | { kind: 'field'; field: ResolvedField; viaLabel: boolean }
  | { kind: 'system'; name: string }
  | { kind: 'hidden'; name: string }
  | { kind: 'unavailable'; name: string }
  | { kind: 'ambiguous'; name: string; keys: string[] }

type ColumnLookup = Extract<FieldLookup, { kind: 'field' | 'system' }>

/** Поля датасета по ключам и подписям (ru, tg, en) с учётом политики столбцов. */
class DatasetBinding {
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

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (!list) map.set(key, [value])
  else if (!list.includes(value)) list.push(value)
}

interface DatasetItem {
  kind: 'dataset'
  ref: string
  binding: DatasetBinding
}
interface RelationItem {
  kind: 'relation'
  ref: string | null
  /** Столбцы отношения; null — неизвестны до выполнения. */
  columns: readonly Output[] | null
}
interface JoinItem {
  kind: 'join'
  ref: string
  children: readonly FromItem[]
}
type FromItem = DatasetItem | RelationItem | JoinItem

interface CteBinding {
  name: string
  generated: string
  columns: Output[] | null
}

/** Результат поиска имени среди элементов FROM. */
interface Found {
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
class Scope {
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
interface ExprCtx {
  names: 'input' | 'order' | 'group'
  outputs: readonly Output[] | null
  /** ColumnRef — весь элемент списка выборки без алиаса: подпись сохраняется как имя столбца. */
  bareTarget: boolean
}

const INPUT: ExprCtx = { names: 'input', outputs: null, bareTarget: false }

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Столбец отношения, найденный по имени. */
interface OutputMatch {
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
function outputsLookup(
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

class Analyzer {
  readonly edits: Edit[] = []
  readonly datasets = new Map<string, { dataset: SqlDataset; refs: DatasetRef[] }>()
  readonly tables: string[] = []
  readonly systemColumns = new Set<string>()
  readonly params: Placeholder[] = []
  usesTime = false
  volatile = false
  private readonly bindings = new Map<string, DatasetBinding>()
  private readonly placeholders = new Map<number, Placeholder>()
  private readonly seen = new Set<number>()
  /** ColumnRef, переписанный с подписи на ключ, — имя столбца Postgres возьмёт по ключу. */
  private readonly renamed = new WeakMap<Obj, string>()
  /** Столбцы результата подзапросов-выражений — для имени `(SELECT …)`. */
  private readonly sublinkOutputs = new WeakMap<Obj, Output[]>()
  private cteCount = 0

  constructor(
    private readonly text: string,
    private readonly positions: SourcePositions,
    private readonly catalog: TableCatalog | null,
    placeholders: readonly Placeholder[],
  ) {
    for (const placeholder of placeholders) this.placeholders.set(placeholder.start, placeholder)
  }

  // ─── Общее ─────────────────────────────────────────────────────────────────

  private at(location: unknown, fallback: number): number {
    return typeof location === 'number' && location >= 0
      ? this.positions.fromByte(location)
      : fallback
  }

  /** Узел `{Тип: поля}`; тип и поля проверяются по белому списку. */
  private node(value: unknown, pos: number): [string, Obj] {
    if (isObj(value)) {
      const keys = Object.keys(value)
      if (keys.length === 1) {
        const type = keys[0] as string
        const fields = value[type]
        if (isObj(fields)) {
          this.check(type, fields, this.at(fields.location, pos))
          return [type, fields]
        }
      }
    }
    return sqlFail('Конструкция SQL не поддерживается', pos)
  }

  /** Поля узла — только из белого списка. */
  private check(type: string, fields: Obj, pos: number): void {
    const allowed = NODE_FIELDS[type]
    if (!allowed) {
      const known = UNSUPPORTED[type]
      sqlFail(known ?? `Конструкция SQL «${type}» не поддерживается`, pos)
    }
    for (const key of Object.keys(fields)) {
      if (!allowed.includes(key)) sqlFail(`Конструкция SQL «${type}.${key}» не поддерживается`, pos)
    }
  }

  /** Узел содержит только перечисленные поля (у разных форм SELECT — разные наборы). */
  private only(fields: Obj, allowed: readonly string[], pos: number): void {
    for (const key of Object.keys(fields)) {
      if (!allowed.includes(key)) sqlFail('Конструкция SQL не поддерживается', pos)
    }
  }

  /** Список строк (имена функций, операторов, типов, столбцов). */
  private strings(value: unknown, pos: number): string[] {
    return list(value).map((item) => {
      const [type, fields] = this.node(item, pos)
      if (type !== 'String' || typeof fields.sval !== 'string') {
        return sqlFail('Конструкция SQL не поддерживается', pos)
      }
      return fields.sval
    })
  }

  private binding(dataset: SqlDataset): DatasetBinding {
    let binding = this.bindings.get(dataset.id)
    if (!binding) {
      binding = new DatasetBinding(dataset)
      this.bindings.set(dataset.id, binding)
    }
    return binding
  }

  // ─── Операторы ─────────────────────────────────────────────────────────────

  statement(stmt: unknown, pos: number): Output[] {
    if (isObj(stmt)) {
      const type = Object.keys(stmt)[0] ?? ''
      if (type !== 'SelectStmt') {
        const message =
          STATEMENTS[type] ??
          (/^(Create|Alter|Drop|Rename|Comment|Refresh|Reindex|Cluster|Security|Import)/.test(type)
            ? 'Изменение структуры базы запрещено: доступны только запросы на чтение'
            : 'Доступны только запросы на чтение: SELECT, WITH, VALUES')
        return sqlFail(message, pos)
      }
    }
    const [, fields] = this.nodeSelect(stmt, pos)
    return this.select(fields, null, pos)
  }

  /** Узел SELECT с понятными причинами отказа для INTO и FOR UPDATE. */
  private nodeSelect(value: unknown, pos: number): [string, Obj] {
    if (isObj(value) && isObj(value.SelectStmt)) this.selectClauses(value.SelectStmt, pos)
    if (isObj(value) && !isObj(value.SelectStmt)) {
      const type = Object.keys(value)[0] ?? ''
      if (['InsertStmt', 'UpdateStmt', 'DeleteStmt', 'MergeStmt'].includes(type)) {
        return sqlFail(STATEMENTS[type] as string, pos)
      }
    }
    return this.node(value, pos)
  }

  private selectClauses(stmt: Obj, pos: number): void {
    if (stmt.intoClause !== undefined) {
      const into = stmt.intoClause as Obj
      const at = this.at(isObj(into.rel) ? into.rel.location : undefined, pos)
      sqlFail('SELECT INTO запрещён: запрос не создаёт таблиц', at)
    }
    if (stmt.lockingClause !== undefined) {
      sqlFail('Блокировки строк (FOR UPDATE, FOR SHARE) запрещены', pos)
    }
  }

  private select(stmt: Obj, parent: Scope | null, pos: number): Output[] {
    this.selectClauses(stmt, pos)
    this.check('SelectStmt', stmt, pos)
    const scope = new Scope(parent)
    if (stmt.withClause !== undefined) this.withClause(stmt.withClause, scope, pos)
    const op = stmt.op ?? 'SETOP_NONE'
    if (op !== 'SETOP_NONE') {
      if (!['SETOP_UNION', 'SETOP_INTERSECT', 'SETOP_EXCEPT'].includes(String(op))) {
        return sqlFail('Конструкция SQL не поддерживается', pos)
      }
      // Узел объединения: только ветви и хвост — других полей анализатор не обходит
      this.only(stmt, [...TAIL_FIELDS, 'all', 'larg', 'rarg'], pos)
      if (!isObj(stmt.larg) || !isObj(stmt.rarg))
        return sqlFail('Конструкция SQL не поддерживается', pos)
      const left = this.select(stmt.larg, scope, pos)
      this.select(stmt.rarg, scope, pos)
      this.tail(stmt, new Scope(scope), left, pos)
      return left
    }
    if (stmt.valuesLists !== undefined) {
      this.only(stmt, [...TAIL_FIELDS, 'valuesLists'], pos)
      let width = 0
      for (const row of list(stmt.valuesLists)) {
        const [type, fields] = this.node(row, pos)
        if (type !== 'List') return sqlFail('Конструкция SQL не поддерживается', pos)
        const items = list(fields.items)
        width = Math.max(width, items.length)
        for (const item of items) this.expr(item, scope, INPUT, pos)
      }
      const outputs: Output[] = Array.from({ length: width }, (_, index) => ({
        kind: 'column',
        name: `column${index + 1}`,
        field: null,
      }))
      this.tail(stmt, new Scope(scope), outputs, pos)
      return outputs
    }

    this.only(
      stmt,
      (NODE_FIELDS.SelectStmt as readonly string[]).filter(
        (key) => !['all', 'larg', 'rarg', 'valuesLists'].includes(key),
      ),
      pos,
    )
    const targets = list(stmt.targetList)
    const tableSyntax = targets.length === 1 && this.isTableSyntax(targets[0])
    if (tableSyntax) sqlFail('Вместо «TABLE имя» напишите «SELECT * FROM имя»', pos)

    let usingJoins = false
    for (const item of list(stmt.fromClause)) {
      const added = this.fromItem(item, scope, scope.items, pos)
      scope.items.push(...added.items)
      usingJoins ||= added.using
    }
    this.expr(stmt.whereClause, scope, INPUT, pos)
    const outputs = this.targetList(targets, scope, usingJoins, pos)
    for (const item of list(stmt.groupClause)) this.groupItem(item, scope, outputs, pos)
    this.expr(stmt.havingClause, scope, INPUT, pos)
    for (const item of list(stmt.windowClause)) {
      const [type, fields] = this.node(item, pos)
      if (type !== 'WindowDef') return sqlFail('Конструкция SQL не поддерживается', pos)
      this.windowDef(fields, scope, pos)
    }
    for (const item of list(stmt.distinctClause)) {
      // Пустой узел — DISTINCT без ON
      if (isObj(item) && Object.keys(item).length === 0) continue
      this.orderItem(item, scope, outputs, 'order', pos)
    }
    this.tail(stmt, scope, outputs, pos, true)
    return outputs
  }

  /** ORDER BY, LIMIT, OFFSET: у объединений и VALUES — по именам результата. */
  private tail(stmt: Obj, scope: Scope, outputs: Output[], pos: number, simple = false): void {
    if (!simple) {
      scope.items.push({ kind: 'relation', ref: null, columns: outputs })
    }
    for (const item of list(stmt.sortClause)) this.sortBy(item, scope, outputs, pos)
    this.expr(stmt.limitCount, scope, INPUT, pos)
    this.expr(stmt.limitOffset, scope, INPUT, pos)
    const option = stmt.limitOption
    if (
      option !== undefined &&
      !['LIMIT_OPTION_DEFAULT', 'LIMIT_OPTION_COUNT', 'LIMIT_OPTION_WITH_TIES'].includes(
        String(option),
      )
    ) {
      sqlFail('Конструкция SQL не поддерживается', pos)
    }
  }

  /** `TABLE имя` — звёздочка без позиции в тексте. */
  private isTableSyntax(target: unknown): boolean {
    if (!isObj(target) || !isObj(target.ResTarget)) return false
    const value = target.ResTarget.val
    if (!isObj(value) || !isObj(value.ColumnRef)) return false
    return value.ColumnRef.location === -1 || value.ColumnRef.location === undefined
  }

  private withClause(value: unknown, scope: Scope, pos: number): void {
    if (!isObj(value)) sqlFail('Конструкция SQL не поддерживается', pos)
    this.check('WithClause', value, pos)
    const recursive = value.recursive === true
    const entries = list(value.ctes).map((item) => {
      const [type, fields] = this.node(item, pos)
      if (type !== 'CommonTableExpr') return sqlFail('Конструкция SQL не поддерживается', pos)
      return fields
    })
    const bindings: CteBinding[] = []
    for (const cte of entries) {
      const at = this.at(cte.location, pos)
      const name = String(cte.ctename ?? '')
      if (bindings.some((binding) => binding.name === name)) {
        sqlFail(`Имя «${name}» в WITH повторяется`, at)
      }
      const generated = `${CTE_PREFIX}${this.cteCount++}`
      const token = this.identifierToken(at, name, 'имя в WITH')
      this.edits.push({ start: token.start, end: token.end, text: quoteIdent(generated) })
      const aliases = cte.aliascolnames === undefined ? null : this.strings(cte.aliascolnames, at)
      bindings.push({
        name,
        generated,
        columns: aliases
          ? aliases.map((alias) => ({ kind: 'column', name: alias, field: null }))
          : null,
      })
    }
    if (recursive) scope.ctes.push(...bindings)
    entries.forEach((cte, index) => {
      const at = this.at(cte.location, pos)
      const binding = bindings[index] as CteBinding
      const visible = recursive ? scope.ctes : bindings.slice(0, index)
      const [, body] = this.nodeSelect(cte.ctequery, at)
      const outputs = this.select(body, new Scope(scope.parent, visible), at)
      if (binding.columns === null) binding.columns = outputs
      else binding.columns = [...binding.columns, ...outputs.slice(binding.columns.length)]
      if (!recursive) scope.ctes.push(binding)
    })
  }

  // ─── FROM ──────────────────────────────────────────────────────────────────

  /** Элемент FROM → элементы области видимости; `using` — соединение USING/NATURAL. */
  private fromItem(
    value: unknown,
    scope: Scope,
    visible: readonly FromItem[],
    pos: number,
  ): { items: FromItem[]; using: boolean } {
    if (isObj(value) && isObj(value.RangeVar))
      return { items: [this.rangeVar(value.RangeVar, scope, pos)], using: false }
    const [type, fields] = this.node(value, pos)
    switch (type) {
      case 'RangeSubselect': {
        const lateral = fields.lateral === true
        const [, sub] = this.nodeSelect(fields.subquery, pos)
        const outputs = this.select(
          sub,
          new Scope(scope.parent, scope.ctes, lateral ? [...visible] : []),
          pos,
        )
        const alias = this.alias(fields.alias, pos)
        return {
          items: [
            {
              kind: 'relation',
              ref: alias?.name ?? null,
              columns: renameOutputs(outputs, alias?.columns),
            },
          ],
          using: false,
        }
      }
      case 'RangeFunction':
        return { items: [this.rangeFunction(fields, scope, visible, pos)], using: false }
      case 'JoinExpr': {
        const left = this.fromItem(fields.larg, scope, visible, pos)
        const right = this.fromItem(fields.rarg, scope, [...visible, ...left.items], pos)
        const children = [...left.items, ...right.items]
        this.expr(fields.quals, new Scope(scope.parent, scope.ctes, children), INPUT, pos)
        const using = this.strings(fields.usingClause, pos)
        for (const name of using) this.usingColumn(name, left.items, right.items, pos)
        const items: FromItem[] = []
        const alias = this.alias(fields.alias, pos)
        if (alias) {
          if (alias.columns) sqlFail('Переименование столбцов соединения не поддерживается', pos)
          items.push({ kind: 'join', ref: alias.name, children })
        } else {
          items.push(...children)
        }
        const usingAlias = this.alias(fields.join_using_alias, pos)
        if (usingAlias) {
          items.push({
            kind: 'relation',
            ref: usingAlias.name,
            columns: using.map((name) => ({ kind: 'column', name, field: null })),
          })
        }
        return {
          items,
          using: left.using || right.using || using.length > 0 || fields.isNatural === true,
        }
      }
      default:
        return sqlFail(UNSUPPORTED[type] ?? `Конструкция SQL «${type}» не поддерживается`, pos)
    }
  }

  private rangeVar(fields: Obj, scope: Scope, pos: number): FromItem {
    const at = this.at(fields.location, pos)
    const schema = fields.catalogname ?? fields.schemaname
    if (schema !== undefined) {
      return sqlFail(
        `Обращение к схеме «${String(schema)}» запрещено: в запросе доступны только датасеты по названию`,
        at,
        'Например: SELECT * FROM "Происшествия"',
      )
    }
    this.check('RangeVar', fields, at)
    if (fields.inh !== true) sqlFail('ONLY не поддерживается', at)
    const name = String(fields.relname ?? '')
    const alias = this.alias(fields.alias, at)
    const token = this.identifierToken(at, name, 'имя таблицы')
    const ref = alias?.name ?? name

    const cte = scope.cte(name)
    if (cte) {
      this.edits.push({
        start: token.start,
        end: token.end,
        text: alias
          ? quoteIdent(cte.generated)
          : `${quoteIdent(cte.generated)} AS ${quoteIdent(name)}`,
      })
      return { kind: 'relation', ref, columns: renameOutputs(cte.columns, alias?.columns) }
    }
    if (!this.tables.includes(name)) this.tables.push(name)
    if (!this.catalog) return { kind: 'relation', ref, columns: null }

    const dataset = this.catalog.find(name, at)
    if (!dataset) {
      const similar = this.catalog.similar(name)
      return sqlFail(
        `Нет датасета «${name}» или нет доступа к нему`,
        at,
        similar.length ? `Возможно, имелось в виду: ${similar.join(', ')}` : undefined,
      )
    }
    if (alias?.columns) {
      sqlFail(
        'Переименование столбцов датасета в алиасе не поддерживается',
        at,
        'Задайте имена через AS в SELECT',
      )
    }
    let use = this.datasets.get(dataset.id)
    if (!use) {
      use = { dataset, refs: [] }
      this.datasets.set(dataset.id, use)
    }
    use.refs.push({ start: token.start, end: token.end, alias: alias ? null : name })
    return { kind: 'dataset', ref, binding: this.binding(dataset) }
  }

  private rangeFunction(
    fields: Obj,
    scope: Scope,
    visible: readonly FromItem[],
    pos: number,
  ): FromItem {
    // Функции во FROM видят предыдущие элементы (неявный LATERAL)
    const inner = new Scope(scope.parent, scope.ctes, [...visible])
    const functions = list(fields.functions)
    let single: string | null = null
    const columns: Output[] = []
    for (const entry of functions) {
      const [type, pair] = this.node(entry, pos)
      if (type !== 'List') return sqlFail('Конструкция SQL не поддерживается', pos)
      const [call, definitions] = list(pair.items)
      this.expr(call, inner, INPUT, pos)
      if (functions.length === 1 && isObj(call) && isObj(call.FuncCall)) {
        const names = this.strings(call.FuncCall.funcname, pos)
        single = names[names.length - 1] ?? null
      }
      if (isObj(definitions) && Object.keys(definitions).length > 0) {
        const [listType, defs] = this.node(definitions, pos)
        if (listType !== 'List') return sqlFail('Конструкция SQL не поддерживается', pos)
        columns.push(...this.columnDefs(defs.items, pos))
      }
    }
    columns.push(...this.columnDefs(fields.coldeflist, pos))
    const alias = this.alias(fields.alias, pos)
    return {
      kind: 'relation',
      ref: alias?.name ?? single,
      columns: alias?.columns
        ? alias.columns.map((name) => ({ kind: 'column', name, field: null }))
        : columns.length
          ? columns
          : null,
    }
  }

  private columnDefs(value: unknown, pos: number): Output[] {
    return list(value).map((item) => {
      const [type, fields] = this.node(item, pos)
      if (type !== 'ColumnDef') return sqlFail('Конструкция SQL не поддерживается', pos)
      const at = this.at(fields.location, pos)
      this.typeName(fields.typeName, at)
      return { kind: 'column', name: String(fields.colname ?? ''), field: null }
    })
  }

  private alias(value: unknown, pos: number): { name: string; columns: string[] | null } | null {
    if (value === undefined) return null
    if (!isObj(value)) return sqlFail('Конструкция SQL не поддерживается', pos)
    this.check('Alias', value, pos)
    return {
      name: String(value.aliasname ?? ''),
      columns: value.colnames === undefined ? null : this.strings(value.colnames, pos),
    }
  }

  /** Имя в USING: у датасетов — ключ поля (у имён USING нет позиций для замены подписи). */
  private usingColumn(
    name: string,
    left: readonly FromItem[],
    right: readonly FromItem[],
    pos: number,
  ): void {
    if (SYSTEM_NAMES.has(name)) this.systemColumns.add(name)
    for (const side of [left, right]) {
      const found = this.lookupIn(side, name)
      for (const match of found.fields) {
        if (match.lookup.kind === 'field' && match.lookup.viaLabel) {
          sqlFail(
            `В USING укажите ключ поля «${match.lookup.field.key}», а не подпись «${name}»`,
            pos,
          )
        }
      }
      const problem = found.problems[0]
      if (problem && found.fields.length === 0 && found.others === 0) this.problem(problem, pos)
    }
  }

  private identifierToken(at: number, name: string, what: string): { start: number; end: number } {
    const token = readIdentifier(this.text, at)
    if (!token) {
      return sqlFail(`Не удалось прочитать ${what}: используйте обычные двойные кавычки`, at)
    }
    if (token.value !== name) sqlFail(`Не удалось прочитать ${what} «${name}»`, at)
    return token
  }

  // ─── Список выборки, группировка, сортировка ──────────────────────────────

  private targetList(targets: unknown[], scope: Scope, usingJoins: boolean, pos: number): Output[] {
    const outputs: Output[] = []
    for (const target of targets) {
      const [type, fields] = this.node(target, pos)
      if (type !== 'ResTarget') return sqlFail('Конструкция SQL не поддерживается', pos)
      const at = this.at(fields.location, pos)
      const value = fields.val
      const name = typeof fields.name === 'string' ? fields.name : null
      if (isObj(value) && isObj(value.ColumnRef)) {
        const [, ref] = this.node(value, at)
        const star = this.star(ref, scope, usingJoins, at)
        if (star) {
          outputs.push(...star)
          continue
        }
        const field = this.columnRef(
          ref,
          scope,
          { ...INPUT, bareTarget: name === null },
          this.at(ref.location, at),
        )
        outputs.push({ kind: 'column', name: name ?? this.figureName(value), field })
        continue
      }
      this.expr(value, scope, INPUT, at)
      outputs.push({ kind: 'column', name: name ?? this.figureName(value), field: null })
    }
    return outputs
  }

  /** `*` и `алиас.*`: столбцы для имён результата. */
  private star(ref: Obj, scope: Scope, usingJoins: boolean, pos: number): Output[] | null {
    const parts = this.columnParts(ref, pos)
    if (parts[parts.length - 1] !== null) return null
    const expand = (item: FromItem): Output[] => {
      if (item.kind === 'dataset') return [{ kind: 'dataset', datasetId: item.binding.dataset.id }]
      if (item.kind === 'join') return item.children.flatMap(expand)
      return item.columns ? [...item.columns] : [{ kind: 'unknown' }]
    }
    if (parts.length === 1) {
      // USING и NATURAL сливают одноимённые столбцы — порядок и состав известны только Postgres
      if (usingJoins) return [{ kind: 'unknown' }]
      return scope.items.flatMap(expand)
    }
    const qualifier = parts[0]
    for (let current: Scope | null = scope; current; current = current.parent) {
      const item = current.items.find((candidate) => candidate.ref === qualifier)
      if (item) return expand(item)
    }
    return [{ kind: 'unknown' }]
  }

  private groupItem(value: unknown, scope: Scope, outputs: readonly Output[], pos: number): void {
    if (isObj(value) && isObj(value.GroupingSet)) {
      const [, fields] = this.node(value, pos)
      const at = this.at(fields.location, pos)
      for (const item of list(fields.content)) this.groupItem(item, scope, outputs, at)
      return
    }
    this.orderItem(value, scope, outputs, 'group', pos)
  }

  private sortBy(
    value: unknown,
    scope: Scope,
    outputs: readonly Output[] | null,
    pos: number,
  ): void {
    const [type, fields] = this.node(value, pos)
    if (type !== 'SortBy') sqlFail('Конструкция SQL не поддерживается', pos)
    const at = this.at(fields.location, pos)
    if (fields.useOp !== undefined) this.operator(fields.useOp, 'AEXPR_OP', at)
    if (outputs) this.orderItem(fields.node, scope, outputs, 'order', at)
    else this.expr(fields.node, scope, INPUT, at)
  }

  /** Элемент ORDER BY / GROUP BY / DISTINCT ON: голое имя может быть именем результата. */
  private orderItem(
    value: unknown,
    scope: Scope,
    outputs: readonly Output[],
    names: 'order' | 'group',
    pos: number,
  ): void {
    if (isObj(value) && isObj(value.ColumnRef)) {
      const [, ref] = this.node(value, pos)
      const parts = this.columnParts(ref, pos)
      if (parts.length === 1 && parts[0] !== null) {
        this.columnRef(
          ref,
          scope,
          { names, outputs, bareTarget: false },
          this.at(ref.location, pos),
        )
        return
      }
    }
    this.expr(value, scope, INPUT, pos)
  }

  private windowDef(fields: Obj, scope: Scope, pos: number): void {
    this.check('WindowDef', fields, pos)
    const at = this.at(fields.location, pos)
    for (const item of list(fields.partitionClause)) this.expr(item, scope, INPUT, at)
    for (const item of list(fields.orderClause)) this.sortBy(item, scope, null, at)
    this.expr(fields.startOffset, scope, INPUT, at)
    this.expr(fields.endOffset, scope, INPUT, at)
  }

  // ─── Выражения ─────────────────────────────────────────────────────────────

  private expr(value: unknown, scope: Scope, ctx: ExprCtx, pos: number): void {
    if (value === undefined || value === null) return
    const [type, fields] = this.node(value, pos)
    const at = this.at(fields.location, pos)
    // Особые правила имён (голое поле выборки, ORDER BY) — только у элемента верхнего уровня
    const inner = INPUT
    switch (type) {
      case 'ColumnRef':
        this.columnRef(fields, scope, ctx, at)
        return
      case 'ParamRef':
        this.paramRef(fields, at)
        return
      case 'A_Const':
        return
      case 'TypeCast':
        // Сначала аргумент: в `x::a::b` ошибка указывает на первое приведение в тексте
        this.expr(fields.arg, scope, inner, at)
        this.typeName(fields.typeName, at)
        return
      case 'A_Expr': {
        const kind = String(fields.kind)
        if (!EXPR_KINDS.has(kind) && !BETWEEN_KINDS.has(kind)) {
          sqlFail('Конструкция SQL не поддерживается', at)
        }
        this.operator(fields.name, kind, at)
        this.expr(fields.lexpr, scope, inner, at)
        this.expr(fields.rexpr, scope, inner, at)
        return
      }
      case 'List':
        for (const item of list(fields.items)) this.expr(item, scope, inner, pos)
        return
      case 'BoolExpr':
      case 'CoalesceExpr':
      case 'MinMaxExpr':
      case 'GroupingFunc':
      case 'RowExpr':
        for (const item of list(fields.args)) this.expr(item, scope, inner, at)
        return
      case 'NullTest':
      case 'BooleanTest':
        this.expr(fields.arg, scope, inner, at)
        return
      case 'A_ArrayExpr':
        for (const item of list(fields.elements)) this.expr(item, scope, inner, at)
        return
      case 'FuncCall':
        this.funcCall(fields, scope, at)
        return
      case 'CaseExpr':
        this.expr(fields.arg, scope, inner, at)
        for (const item of list(fields.args)) this.expr(item, scope, inner, at)
        this.expr(fields.defresult, scope, inner, at)
        return
      case 'CaseWhen':
        this.expr(fields.expr, scope, inner, at)
        this.expr(fields.result, scope, inner, at)
        return
      case 'SQLValueFunction': {
        const op = String(fields.op)
        if (!TIME_VALUE_FUNCTIONS.has(op)) {
          const shown = op.replace(/^SVFOP_/, '').replace(/_N$/, '')
          sqlFail(`Системная функция «${shown}» недоступна`, at)
        }
        this.usesTime = true
        return
      }
      case 'SubLink': {
        if (!SUBLINKS.has(String(fields.subLinkType)))
          sqlFail('Конструкция SQL не поддерживается', at)
        this.expr(fields.testexpr, scope, inner, at)
        if (fields.operName !== undefined) this.operator(fields.operName, 'AEXPR_OP', at)
        const [, sub] = this.nodeSelect(fields.subselect, at)
        this.sublinkOutputs.set(fields, this.select(sub, scope, at))
        return
      }
      case 'A_Indirection':
        this.expr(fields.arg, scope, inner, at)
        for (const item of list(fields.indirection)) {
          const [kind, part] = this.node(item, at)
          if (kind === 'A_Indices') {
            this.expr(part.lidx, scope, INPUT, at)
            this.expr(part.uidx, scope, INPUT, at)
          } else if (kind !== 'String' && kind !== 'A_Star') {
            sqlFail('Конструкция SQL не поддерживается', at)
          }
        }
        return
      case 'CollateClause': {
        const names = this.strings(fields.collname, at)
        if (names.length > 2 || (names.length === 2 && names[0] !== 'pg_catalog')) {
          sqlFail(`Правило сортировки «${names.join('.')}» недоступно`, at)
        }
        this.expr(fields.arg, scope, inner, at)
        return
      }
      case 'JsonIsPredicate':
        if (fields.format !== undefined) {
          if (!isObj(fields.format)) sqlFail('Конструкция SQL не поддерживается', at)
          this.check('JsonFormat', fields.format, at)
        }
        this.expr(fields.expr, scope, inner, at)
        return
      case 'NamedArgExpr':
        this.expr(fields.arg, scope, inner, at)
        return
      default:
        sqlFail(UNSUPPORTED[type] ?? `Конструкция SQL «${type}» не поддерживается`, at)
    }
  }

  private funcCall(fields: Obj, scope: Scope, at: number): void {
    const names = this.strings(fields.funcname, at)
    const name = names[names.length - 1] ?? ''
    const shown = names.join('.')
    if (isDeniedFunction(name)) sqlFail(`Функция «${shown}» запрещена`, at)
    if (names.length > 2 || (names.length === 2 && names[0] !== 'pg_catalog')) {
      sqlFail(`Функция «${shown}» недоступна: функции других схем запрещены`, at)
    }
    if (!isAllowedFunction(name)) {
      const lower = name.toLowerCase()
      sqlFail(
        `Функция «${shown}» недоступна в SQL-лаборатории`,
        at,
        lower !== name && isAllowedFunction(lower)
          ? `Имя функции пишется без кавычек: ${lower}`
          : FUNCTION_HINT,
      )
    }
    if (VOLATILE_FUNCTIONS.has(name)) {
      if (['random', 'gen_random_uuid'].includes(name)) this.volatile = true
      else this.usesTime = true
    }
    for (const arg of list(fields.args)) this.expr(arg, scope, INPUT, at)
    for (const item of list(fields.agg_order)) this.sortBy(item, scope, null, at)
    this.expr(fields.agg_filter, scope, INPUT, at)
    if (fields.over !== undefined) {
      if (!isObj(fields.over)) sqlFail('Конструкция SQL не поддерживается', at)
      this.windowDef(fields.over, scope, at)
    }
  }

  private operator(value: unknown, kind: string, at: number): void {
    const names = this.strings(value, at)
    const name = names[0] ?? ''
    if (BETWEEN_KINDS.has(kind)) {
      if (names.length !== 1 || !/^(NOT )?BETWEEN( SYMMETRIC)?$/.test(name)) {
        sqlFail('Конструкция SQL не поддерживается', at)
      }
      return
    }
    if (names.length !== 1 || !OPERATOR.test(name)) {
      sqlFail(
        `Оператор «${names.join('.')}» недоступен: OPERATOR(схема.оператор) не поддерживается`,
        at,
      )
    }
  }

  private typeName(value: unknown, at: number): void {
    if (!isObj(value)) sqlFail('Конструкция SQL не поддерживается', at)
    if (value.pct_type !== undefined || value.setof !== undefined) {
      sqlFail('%TYPE и SETOF не поддерживаются', at)
    }
    this.check('TypeName', value, at)
    const pos = this.at(value.location, at)
    const names = this.strings(value.names, pos)
    const shown =
      names.length === 2 && names[0] === 'pg_catalog' ? (names[1] as string) : names.join('.')
    const name =
      names.length === 1
        ? names[0]
        : names.length === 2 && names[0] === 'pg_catalog'
          ? names[1]
          : null
    if (!name || !isAllowedType(name))
      sqlFail(`Приведение к типу «${shown}» запрещено`, pos, TYPE_HINT)
    for (const modifier of list(value.typmods)) {
      const [kind, fields] = this.node(modifier, pos)
      // geometry(Point, 4326): имя подтипа разборщик отдаёт ссылкой на столбец
      if (kind === 'ColumnRef' && this.columnParts(fields, pos).length === 1) continue
      if (kind !== 'A_Const') sqlFail('Модификатор типа: только константы', pos)
    }
    for (const bound of list(value.arrayBounds)) {
      const [kind] = this.node(bound, pos)
      if (kind !== 'Integer') sqlFail('Конструкция SQL не поддерживается', pos)
    }
  }

  private paramRef(fields: Obj, at: number): void {
    const placeholder = this.placeholders.get(at)
    if (!placeholder || fields.number !== placeholder.marker) {
      sqlFail('Параметры записываются как {{имя}}', at, 'Позиционные параметры $1, $2… недоступны')
    }
    if (!this.seen.has(placeholder.marker)) {
      this.seen.add(placeholder.marker)
      this.params.push(placeholder)
    }
  }

  /** Каждый `{{параметр}}` должен стать параметром запроса, а не частью имени. */
  checkPlaceholders(placeholders: readonly Placeholder[]): void {
    for (const placeholder of placeholders) {
      if (!this.seen.has(placeholder.marker)) {
        sqlFail(
          `Параметр {{${placeholder.name}}} не распознан`,
          placeholder.start,
          'Отделите параметр пробелами или скобками от соседних слов',
        )
      }
    }
  }

  // ─── Имена полей ───────────────────────────────────────────────────────────

  /** Части ссылки на поле; null — звёздочка (имя `"*"` в кавычках — обычная строка). */
  private columnParts(fields: Obj, pos: number): Array<string | null> {
    const parts = list(fields.fields).map((item) => {
      const [type, part] = this.node(item, pos)
      if (type === 'A_Star') return null
      if (type === 'String' && typeof part.sval === 'string') return part.sval
      return sqlFail('Конструкция SQL не поддерживается', pos)
    })
    if (parts.length === 0 || parts.slice(0, -1).includes(null)) {
      sqlFail('Конструкция SQL не поддерживается', pos)
    }
    return parts
  }

  /** Ссылка на поле: подпись → ключ, скрытое поле — отказ. Возвращает поле датасета, если нашлось. */
  private columnRef(fields: Obj, scope: Scope, ctx: ExprCtx, at: number): FieldRef | null {
    const parts = this.columnParts(fields, at)
    if (parts.length > 2) {
      sqlFail('Ссылка на поле: «поле» или «таблица.поле»', at, 'Схемы и вложенные имена недоступны')
    }
    const name = parts[parts.length - 1]
    if (name === null || name === undefined) return null
    if (SYSTEM_NAMES.has(name)) this.systemColumns.add(name)
    const qualifier = parts.length === 2 ? parts[0] : null
    if (qualifier) return this.qualified(qualifier, name, fields, scope, ctx, at)
    return this.unqualified(name, fields, scope, ctx, at)
  }

  private unqualified(
    name: string,
    ref: Obj,
    scope: Scope,
    ctx: ExprCtx,
    at: number,
  ): FieldRef | null {
    const outputs = ctx.outputs
    if (ctx.names === 'order' && outputs) {
      // Имя результата важнее поля; подпись за звёздочкой разрешится как поле ниже
      const result = outputsLookup(outputs, this.bindings, name)
      if (typeof result === 'object' && 'rename' in result && result.rename === null) {
        return result.field
      }
    }
    for (let current: Scope | null = scope; current; current = current.parent) {
      const found = this.lookupIn(current.items, name)
      const total = found.fields.length + found.others
      if (total === 1) {
        const match = found.fields[0]
        if (match) return this.apply(match.item.binding, match.lookup, ref, 1, name, ctx, at)
        return this.relationColumn(found.other, ref, 1, name, ctx, at)
      }
      if (total > 1) {
        if (found.others === 0) {
          const refs = found.fields.map((match) => `${match.item.ref}.${name}`)
          sqlFail(`Поле «${name}» неоднозначно`, at, `Укажите таблицу: ${refs.join(' или ')}`)
        }
        return null
      }
      const problem = found.problems[0]
      if (problem) this.problem(problem, at)
      if (found.maybe) return null
      // Имя таблицы без поля — ссылка на строку целиком
      if (current.items.some((item) => item.ref === name)) return null
    }
    if (
      outputs &&
      ctx.names !== 'input' &&
      outputsLookup(outputs, this.bindings, name) !== 'none'
    ) {
      return null
    }
    if (!this.catalog) return null
    const names = scope.items.flatMap((item) => this.itemNames(item))
    const similar = similarNames(names, name)
    return sqlFail(
      `Нет поля «${name}»`,
      at,
      similar.length ? `Возможно, имелось в виду: ${similar.join(', ')}` : undefined,
    )
  }

  private qualified(
    qualifier: string,
    name: string,
    ref: Obj,
    scope: Scope,
    ctx: ExprCtx,
    at: number,
  ): FieldRef | null {
    for (let current: Scope | null = scope; current; current = current.parent) {
      const item = current.items.find((candidate) => candidate.ref === qualifier)
      if (!item) continue
      if (item.kind === 'relation') {
        const result = outputsLookup(item.columns, this.bindings, name)
        if (typeof result !== 'object') return null
        if ('problem' in result) return this.problem(result.problem, at)
        return this.relationColumn(result, ref, 2, name, ctx, at)
      }
      const found =
        item.kind === 'dataset' ? this.lookupIn([item], name) : this.lookupIn(item.children, name)
      const match = found.fields[0]
      if (match && found.fields.length === 1 && found.others === 0) {
        return this.apply(match.item.binding, match.lookup, ref, 2, name, ctx, at)
      }
      if (found.fields.length > 1) {
        sqlFail(`Поле «${qualifier}.${name}» неоднозначно`, at)
      }
      const problem = found.problems[0]
      if (problem && found.others === 0) this.problem(problem, at)
      if (found.maybe || found.others > 0 || !this.catalog) return null
      const similar = similarNames(this.itemNames(item), name)
      return sqlFail(
        `Нет поля «${qualifier}.${name}»`,
        at,
        similar.length ? `Возможно, имелось в виду: ${similar.join(', ')}` : undefined,
      )
    }
    // Не таблица — поле составного значения или ошибка, которую покажет Postgres
    return null
  }

  private itemNames(item: FromItem): string[] {
    if (item.kind === 'dataset') return item.binding.names()
    if (item.kind === 'join') return item.children.flatMap((child) => this.itemNames(child))
    return (item.columns ?? []).flatMap((column) =>
      column.kind === 'column' && column.name ? [column.name] : [],
    )
  }

  private lookupIn(items: readonly FromItem[], name: string): Found {
    const found: Found = { fields: [], problems: [], others: 0, other: null, maybe: false }
    const visit = (item: FromItem) => {
      if (item.kind === 'join') {
        item.children.forEach(visit)
        return
      }
      if (item.kind === 'dataset') {
        const lookup = item.binding.lookup(name)
        if (!lookup) return
        if (lookup.kind === 'field' || lookup.kind === 'system') found.fields.push({ item, lookup })
        else found.problems.push(lookup)
        return
      }
      const result = outputsLookup(item.columns, this.bindings, name)
      if (result === 'maybe') found.maybe = true
      else if (result === 'none') return
      else if ('problem' in result) found.problems.push(result.problem)
      else {
        found.others++
        found.other = result
      }
    }
    items.forEach(visit)
    return found
  }

  private problem(problem: FieldLookup, at: number): never {
    switch (problem.kind) {
      case 'hidden':
        return sqlFail(`Нет доступа к полю «${problem.name}»`, at)
      case 'unavailable':
        return sqlFail(
          `Поле «${problem.name}» вычисляемое — в запросах к данным оно пока недоступно`,
          at,
        )
      case 'ambiguous':
        return sqlFail(
          `Подпись «${problem.name}» у нескольких полей`,
          at,
          `Укажите ключ поля: ${problem.keys.join(', ')}`,
        )
      default:
        return sqlFail('Конструкция SQL не поддерживается', at)
    }
  }

  /** Подпись поля → ключ (правка текста); голое поле в списке выборки сохраняет имя. */
  private apply(
    binding: DatasetBinding,
    lookup: ColumnLookup,
    ref: Obj,
    count: number,
    name: string,
    ctx: ExprCtx,
    at: number,
  ): FieldRef {
    const datasetId = binding.dataset.id
    if (lookup.kind === 'system') return { datasetId, column: lookup.name }
    const { field, viaLabel } = lookup
    if (viaLabel) this.rename(field.key, ref, count, name, ctx, at)
    return { datasetId, column: field.key }
  }

  /** Столбец CTE или подзапроса; подпись за звёздочкой заменяется ключом. */
  private relationColumn(
    match: OutputMatch | null,
    ref: Obj,
    count: number,
    name: string,
    ctx: ExprCtx,
    at: number,
  ): FieldRef | null {
    if (!match) return null
    if (match.rename !== null) this.rename(match.rename, ref, count, name, ctx, at)
    return match.field
  }

  /** Правка текста: последнее имя ссылки → ключ; голое поле выборки сохраняет имя через AS. */
  private rename(
    key: string,
    ref: Obj,
    count: number,
    name: string,
    ctx: ExprCtx,
    at: number,
  ): void {
    const tokens = readIdentifierChain(this.text, at, count)
    const token = tokens?.[count - 1]
    if (!token || token.value !== name) {
      sqlFail(`Не удалось прочитать имя поля «${name}»: используйте обычные двойные кавычки`, at)
    }
    this.edits.push({ start: token.start, end: token.end, text: quoteIdent(key) })
    if (ctx.bareTarget) {
      this.edits.push({ start: token.end, end: token.end, text: ` AS ${quoteIdent(name)}` })
    } else {
      this.renamed.set(ref, key)
    }
  }

  // ─── Имена столбцов результата (FigureColname в Postgres) ────────────────

  private figureName(value: unknown): string | null {
    const [name] = this.figure(value)
    return name ?? '?column?'
  }

  /** Имя и «сила» имени: 2 — имя столбца или функции, 1 — служебное, 0 — нет. */
  private figure(value: unknown): [string | null, number] {
    if (!isObj(value)) return [null, 0]
    const type = Object.keys(value)[0] ?? ''
    const fields = value[type]
    if (!isObj(fields)) return [null, 0]
    switch (type) {
      case 'ColumnRef': {
        const parts = list(fields.fields).flatMap((item) =>
          isObj(item) && isObj(item.String) && typeof item.String.sval === 'string'
            ? [item.String.sval]
            : [],
        )
        const last = parts[parts.length - 1]
        if (last === undefined) return [null, 0]
        return [this.renamed.get(fields) ?? last, 2]
      }
      case 'A_Indirection': {
        const parts = list(fields.indirection).flatMap((item) =>
          isObj(item) && isObj(item.String) && typeof item.String.sval === 'string'
            ? [item.String.sval]
            : [],
        )
        const last = parts[parts.length - 1]
        return last === undefined ? this.figure(fields.arg) : [last, 2]
      }
      case 'FuncCall': {
        const names = list(fields.funcname).flatMap((item) =>
          isObj(item) && isObj(item.String) && typeof item.String.sval === 'string'
            ? [item.String.sval]
            : [],
        )
        return [names[names.length - 1] ?? null, 2]
      }
      case 'A_Expr':
        return fields.kind === 'AEXPR_NULLIF' ? ['nullif', 2] : [null, 0]
      case 'TypeCast': {
        const inner = this.figure(fields.arg)
        if (inner[1] > 1) return inner
        const names = isObj(fields.typeName) ? list(fields.typeName.names) : []
        const last = names[names.length - 1]
        return isObj(last) && isObj(last.String) && typeof last.String.sval === 'string'
          ? [last.String.sval, 1]
          : inner
      }
      case 'CollateClause':
        return this.figure(fields.arg)
      case 'GroupingFunc':
        return ['grouping', 2]
      case 'SubLink':
        if (fields.subLinkType === 'EXISTS_SUBLINK') return ['exists', 2]
        if (fields.subLinkType === 'ARRAY_SUBLINK') return ['array', 2]
        if (fields.subLinkType === 'EXPR_SUBLINK') {
          const first = this.sublinkOutputs.get(fields)?.[0]
          return first?.kind === 'column' && first.name !== null ? [first.name, 2] : [null, 0]
        }
        return [null, 0]
      case 'CaseExpr': {
        const inner = this.figure(fields.defresult)
        return inner[1] > 1 ? inner : ['case', 1]
      }
      case 'A_ArrayExpr':
        return ['array', 2]
      case 'RowExpr':
        return ['row', 2]
      case 'CoalesceExpr':
        return ['coalesce', 2]
      case 'MinMaxExpr':
        return [fields.op === 'IS_LEAST' ? 'least' : 'greatest', 2]
      case 'SQLValueFunction':
        return [TIME_VALUE_NAMES[String(fields.op)] ?? null, 2]
      default:
        return [null, 0]
    }
  }
}

/** Алиас со списком столбцов переименовывает первые столбцы отношения. */
function renameOutputs(
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

export interface AnalyzeOptions {
  catalog: TableCatalog | null
  placeholders: readonly Placeholder[]
}

/** Проверка оператора и сбор правок; ошибки — `QueryCompileError` с позицией. */
export function analyzeSql(text: string, tree: ParseTree, options: AnalyzeOptions): Analysis {
  const positions = new SourcePositions(text)
  const statements = tree.stmts ?? []
  if (statements.length === 0) sqlFail('Пустой запрос: напишите SELECT', 0)
  if (statements.length > 1) {
    const second = statements[1]
    sqlFail('Разрешён только один оператор', positions.fromByte(second?.stmt_location ?? 0))
  }
  const raw = statements[0] as NonNullable<ParseTree['stmts']>[number]
  const startByte = raw.stmt_location ?? 0
  const start = positions.fromByte(startByte)
  const end = raw.stmt_len ? positions.fromByte(startByte + raw.stmt_len) : text.length
  const analyzer = new Analyzer(text, positions, options.catalog, options.placeholders)
  const outputs = analyzer.statement(raw.stmt, start)
  analyzer.checkPlaceholders(options.placeholders)
  return {
    statement: { start, end },
    edits: analyzer.edits,
    datasets: analyzer.datasets,
    params: analyzer.params,
    systemColumns: analyzer.systemColumns,
    tables: analyzer.tables,
    outputs,
    usesTime: analyzer.usesTime,
    volatile: analyzer.volatile,
  }
}
