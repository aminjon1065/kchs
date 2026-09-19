import {
  type FieldType,
  type QuerySource,
  type QuerySpec,
  type QueryStep,
  TIME_BUCKETS,
} from '@kchs/contracts'
import { atPath, ExpressionError, fail, type IssuePath, QueryCompileError } from '../errors.js'
import { compileExpression, type ExprEnv, type ExprField } from '../expr/compile.js'
import {
  fieldTypeOfValue,
  isOrderable,
  semanticOfValue,
  sqlTypeOfField,
  sqlTypeOfValue,
  unify,
  VALUE_TYPE_LABELS,
  type ValueType,
  valueTypeOfField,
} from '../value-types.js'
import { compileFilter, type FilterScope } from './filter.js'
import {
  type Column,
  type ColumnMeta,
  columnSql,
  findColumn,
  type Relation,
  resolveColumn,
  uniqueInternal,
} from './scope.js'
import { datasetSource, guard, inlineSource, userAttrValue } from './sources.js'
import { compileSpatial, type SpatialHost } from './spatial.js'
import type { CompileState } from './state.js'

export interface Ordering {
  column: Column
  dir: 'asc' | 'desc'
  nulls?: 'first' | 'last'
}

/** Состояние конвейера шагов: текущее отношение, порядок строк, была ли сводка. */
export interface Pipeline {
  relation: Relation
  ordering: Ordering[]
  aggregated: boolean
}

type Prefix = 'q' | 'j' | 'u'
type Step<T extends QueryStep['type']> = Extract<QueryStep, { type: T }>

const MAX_QUERY_DEPTH = 4
const JOIN_KINDS: Record<string, string | undefined> = {
  inner: 'JOIN',
  left: 'LEFT JOIN',
  right: 'RIGHT JOIN',
  full: 'FULL JOIN',
}
const PERCENTILES = { median: 0.5, p90: 0.9, p95: 0.95 } as const
const NUMERIC_FIELD_TYPES = new Set<FieldType>([
  'number',
  'decimal',
  'money',
  'percent',
  'duration',
])

/** Спецификация с заполненными значениями по умолчанию (на случай непроверенного ввода). */
export function normalizeSpec(spec: QuerySpec, path: IssuePath = []): QuerySpec {
  if (spec.version !== 1) {
    fail([...path, 'version'], `Версия спецификации ${String(spec.version)} не поддерживается`, {
      hint: 'Поддерживается version: 1',
    })
  }
  return {
    ...spec,
    steps: spec.steps ?? [],
    params: spec.params ?? {},
    options: spec.options ?? { cache: true, approxCount: true },
  }
}

/** Источник и шаги → цепочка CTE; возвращает итоговое отношение и порядок строк. */
export function compilePipeline(
  state: CompileState,
  spec: QuerySpec,
  prefix: Prefix,
  path: IssuePath,
): Pipeline {
  const relation = compileSource(state, spec.source, prefix, [...path, 'source'])
  const pipeline: Pipeline = { relation, ordering: [], aggregated: false }
  const steps = new StepCompiler(state, pipeline, prefix)
  spec.steps.forEach((step, index) => {
    steps.apply(step, [...path, 'steps', index])
  })
  return pipeline
}

function compileSource(
  state: CompileState,
  source: QuerySource,
  prefix: Prefix,
  path: IssuePath,
): Relation {
  const alias = source.alias ?? null
  switch (source.kind) {
    case 'dataset': {
      const dataset = state.ctx.datasets.get(source.id)
      if (!dataset) return fail([...path, 'id'], 'Датасет не найден или нет доступа')
      return datasetSource(state, dataset, alias, state.nextName(prefix), path)
    }
    case 'system': {
      const dataset = state.ctx.systemDatasets?.get(source.name)
      if (!dataset) return fail([...path, 'name'], `Системный датасет «${source.name}» недоступен`)
      return datasetSource(state, dataset, alias, state.nextName(prefix), path)
    }
    case 'inline':
      return inlineSource(state, source.rows, alias, state.nextName(prefix), path)
    case 'query':
      return savedQuery(state, source.id, alias, prefix, path)
    case 'sql':
      return fail(path, 'Источник SQL выполняется только в SQL-лаборатории', {
        hint: 'В визуальном запросе используйте датасет или сохранённый запрос',
      })
    default:
      return fail([...path, 'kind'], 'Неизвестный вид источника')
  }
}

/** Сохранённый запрос как подзапрос: его видимые поля под алиасом источника. */
function savedQuery(
  state: CompileState,
  id: string,
  alias: string | null,
  prefix: Prefix,
  path: IssuePath,
): Relation {
  const spec = state.ctx.queries?.get(id)
  if (!spec) return fail([...path, 'id'], 'Сохранённый запрос не найден или нет доступа')
  if (state.queryStack.includes(id)) {
    fail([...path, 'id'], 'Сохранённый запрос ссылается сам на себя')
  }
  if (state.queryStack.length >= MAX_QUERY_DEPTH) {
    fail([...path, 'id'], `Вложенность сохранённых запросов больше ${MAX_QUERY_DEPTH}`)
  }
  const normalized = normalizeSpec(spec, path)
  state.queries.set(id, normalized)
  const inner = state.nested(id, normalized, () => {
    try {
      return compilePipeline(state, state.spec, prefix, [])
    } catch (error) {
      if (!(error instanceof QueryCompileError)) throw error
      throw new QueryCompileError(
        error.issues.map((issue) => ({
          ...issue,
          path: [...path, ...issue.path],
          message: issue.message.startsWith('Сохранённый запрос')
            ? issue.message
            : `Сохранённый запрос: ${issue.message}`,
        })),
      )
    }
  })
  const d = state.dialect
  const visible = inner.relation.columns.filter((column) => !column.hidden)
  const names = new Set<string>()
  for (const column of visible) {
    if (names.has(column.name)) {
      fail(path, `В сохранённом запросе поле «${column.name}» повторяется`, {
        hint: 'Переименуйте поля шагом select в сохранённом запросе',
      })
    }
    names.add(column.name)
  }
  const name = state.nextName(prefix)
  const select = visible.map(
    (column) => `${columnSql(d, inner.relation, column)} AS ${d.ident(column.name)}`,
  )
  state.addCte(name, `SELECT ${select.join(', ')}\nFROM ${d.ident(inner.relation.name)}`)
  return {
    name,
    columns: visible.map((column) => ({
      name: column.name,
      qualifier: alias,
      internal: column.name,
      type: column.type,
      meta: column.meta,
      hidden: false,
    })),
    restricted: new Map(),
    unavailable: new Map(),
    qualifiers: new Set(alias ? [alias] : []),
  }
}

/** Приведение значения при соединении и объединении (дата → момент, строка → ссылка). */
function convertSql(state: CompileState, sql: string, from: ValueType, to: ValueType): string {
  if (from === to) return sql
  if (from === 'null') return `${sql}::${sqlTypeOfValue(to)}`
  if (from === 'date' && to === 'datetime') {
    return state.dialect.atTimeZone(`${sql}::timestamp`, state.tz())
  }
  if (from === 'text' && to === 'uuid') return state.dialect.tryCast(sql, 'uuid')
  return sql
}

function intInRange(value: unknown, path: IssuePath, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return fail(path, `Нужно целое число от ${min} до ${max}`)
  }
  return value
}

interface Argument {
  sql: string
  type: ValueType
  meta: ColumnMeta | null
}

class StepCompiler {
  constructor(
    private readonly state: CompileState,
    private readonly pipeline: Pipeline,
    private readonly prefix: Prefix,
  ) {}

  private get d() {
    return this.state.dialect
  }

  private get rel(): Relation {
    return this.pipeline.relation
  }

  private ref(relation: Relation = this.rel): string {
    return this.d.ident(relation.name)
  }

  private col(column: Column, relation: Relation = this.rel): string {
    return columnSql(this.d, relation, column)
  }

  apply(step: QueryStep, path: IssuePath): void {
    switch (step.type) {
      case 'filter':
        this.filter(step, path)
        break
      case 'compute':
        this.compute(step, path)
        break
      case 'aggregate':
        this.aggregate(step, path)
        break
      case 'window':
        this.window(step, path)
        break
      case 'sort':
        this.sort(step, path)
        break
      case 'limit':
        this.limit(step, path)
        break
      case 'select':
        this.select(step, path)
        break
      case 'join':
        this.join(step, path)
        break
      case 'union':
        this.union(step, path)
        break
      case 'sample':
        this.sample(step, path)
        break
      case 'unnest':
        this.unnest(step, path)
        break
      case 'pivot':
        fail([...path, 'type'], 'Шаг «pivot» не поддерживается в фазе 1', {
          hint: 'Сводную таблицу строит клиент по результату шага aggregate',
        })
        break
      case 'spatial':
        compileSpatial(this.spatialHost(), step, path)
        break
      default:
        fail([...path, 'type'], `Неизвестный шаг «${String((step as { type: unknown }).type)}»`)
    }
  }

  /** Конвейер для шага spatial: цели — источники соединения (CTE j…) с политиками. */
  private spatialHost(): SpatialHost {
    const pipeline = this.pipeline
    return {
      state: this.state,
      get relation() {
        return pipeline.relation
      },
      update: (relation, restructured) => {
        pipeline.relation = relation
        if (restructured) {
          pipeline.ordering = []
          pipeline.aggregated = true
        }
      },
      nextName: () => this.state.nextName(this.prefix),
      source: (source, path) => compileSource(this.state, source, 'j', path),
    }
  }

  /** Новый CTE над текущим отношением с тем же набором столбцов (или заданным). */
  private derive(body: string, columns: Column[] = this.rel.columns): void {
    const name = this.state.nextName(this.prefix)
    this.state.addCte(name, body)
    this.pipeline.relation = { ...this.rel, name, columns }
  }

  private scope(relation: Relation = this.rel): FilterScope {
    return {
      field: (ref, path) => {
        const column = resolveColumn(relation, ref, path)
        return {
          sql: this.col(column, relation),
          type: column.type,
          fieldType: column.meta.fieldType,
        }
      },
    }
  }

  private env(
    path: IssuePath,
    extra: Partial<ExprEnv> = {},
    local?: ReadonlyMap<string, ExprField>,
  ): ExprEnv {
    const state = this.state
    const relation = this.rel
    return {
      dialect: state.dialect,
      binder: state.binder,
      mode: 'row',
      resolveField: (qualifier, name, pos) => {
        const own = qualifier === null ? local?.get(name) : undefined
        if (own) return own
        const found = findColumn(relation, qualifier, name)
        if ('message' in found) throw new ExpressionError(found.message, pos, found.hint)
        return {
          sql: this.col(found, relation),
          type: found.type,
          fieldType: found.meta.fieldType,
          ...(found.meta.lookup ? { lookup: found.meta.lookup } : {}),
        }
      },
      resolveParam: (name, pos) => guard(pos, () => state.paramExpr(name, path)),
      resolveMacro: (name, pos) => guard(pos, () => state.macroExpr(name, path)),
      userAttr: (key) => userAttrValue(state, key),
      reference: (request) => state.reference(request),
      timezone: () => state.tz(),
      now: () => state.now(),
      ...extra,
    }
  }

  private orderSql(): string {
    return orderClause(this.state, this.rel, this.pipeline.ordering)
  }

  // ─── Шаги ──────────────────────────────────────────────────────────────────

  private filter(step: Step<'filter'>, path: IssuePath): void {
    const condition = compileFilter(this.state, step.where, this.scope(), [...path, 'where'])
    if (condition === null) return
    this.derive(`SELECT *\nFROM ${this.ref()}\nWHERE ${condition}`)
  }

  private compute(step: Step<'compute'>, path: IssuePath): void {
    const taken = new Set(this.rel.columns.map((column) => column.internal))
    const local = new Map<string, ExprField>()
    const added: Column[] = []
    const select: string[] = []
    step.fields.forEach((field, index) => {
      const fieldPath = [...path, 'fields', index]
      if (this.rel.columns.some((column) => column.name === field.name) || local.has(field.name)) {
        fail([...fieldPath, 'name'], `Поле «${field.name}» уже есть`, {
          hint: 'Выберите другое имя',
        })
      }
      const compiled = atPath([...fieldPath, 'expr'], () =>
        compileExpression(field.expr, this.env(fieldPath, {}, local)),
      )
      let { sql, type } = compiled
      let fieldType: FieldType = compiled.fieldType ?? fieldTypeOfValue(type)
      if (field.type) {
        const declared = valueTypeOfField(field.type)
        if (!declared) {
          fail([...fieldPath, 'type'], `Тип «${field.type}» не подходит для вычисляемого поля`)
        }
        if (type === 'null') {
          sql = `NULL::${sqlTypeOfField(field.type)}`
          type = declared
        } else if (declared !== type) {
          fail(
            [...fieldPath, 'type'],
            `Выражение даёт «${VALUE_TYPE_LABELS[type]}», а объявлено «${VALUE_TYPE_LABELS[declared]}»`,
          )
        } else if (declared === 'number' && sqlTypeOfField(field.type) !== 'double precision') {
          sql = `(${sql})::${sqlTypeOfField(field.type)}`
        }
        fieldType = field.type
      }
      if (type === 'null') {
        // Пустое значение без типа — строка (иначе Postgres не сравнит его с другими)
        sql = 'NULL::text'
        type = 'text'
        fieldType = 'text'
      }
      const internal = uniqueInternal(taken, field.name)
      taken.add(internal)
      select.push(`${sql} AS ${this.d.ident(internal)}`)
      local.set(field.name, { sql: `(${sql})`, type, fieldType })
      added.push({
        name: field.name,
        qualifier: null,
        internal,
        type,
        meta: { fieldType, semantic: semanticOfValue(type), label: null, format: null },
        hidden: false,
      })
    })
    this.derive(`SELECT ${this.ref()}.*, ${select.join(', ')}\nFROM ${this.ref()}`, [
      ...this.rel.columns,
      ...added,
    ])
  }

  private aggregate(step: Step<'aggregate'>, path: IssuePath): void {
    const relation = this.rel
    const groupBy = step.groupBy ?? []
    const measures = step.measures ?? []
    if (!groupBy.length && !measures.length) {
      fail(path, 'В сводке нужны группировка или меры')
    }
    const tz = () => this.state.tz()
    const names = new Set<string>()
    const claim = (name: string, at: IssuePath) => {
      if (names.has(name)) {
        fail(at, `Имя «${name}» в сводке повторяется`, { hint: 'Задайте другой alias' })
      }
      names.add(name)
    }
    const select: string[] = []
    const columns: Column[] = []
    const groupKeys = new Set<string>()
    groupBy.forEach((group, index) => {
      const groupPath = [...path, 'groupBy', index]
      const column = resolveColumn(relation, group.field, [...groupPath, 'field'])
      const sql = this.col(column, relation)
      let key = sql
      let type = column.type
      let meta = column.meta
      if (group.bucket) {
        if (!TIME_BUCKETS.includes(group.bucket)) {
          fail([...groupPath, 'bucket'], `Интервал — один из: ${TIME_BUCKETS.join(', ')}`)
        }
        if (column.type !== 'date' && column.type !== 'datetime') {
          fail(
            [...groupPath, 'bucket'],
            `Интервал времени применим к дате, а «${group.field}» — ${VALUE_TYPE_LABELS[column.type]}`,
          )
        }
        if (group.bucket === 'hour') {
          if (column.type === 'date') fail([...groupPath, 'bucket'], 'Дату нельзя разбить по часам')
          key = this.d.dateTrunc('hour', sql, 'datetime', tz)
          type = 'datetime'
        } else {
          const day = column.type === 'date' ? sql : this.d.localDate(sql, tz())
          key = this.d.dateTrunc(group.bucket, day, 'date', tz)
          type = 'date'
        }
        meta = { fieldType: type, semantic: 'time', label: column.meta.label, format: null }
      }
      const name = group.alias ?? (group.bucket ? `${column.name}_${group.bucket}` : column.name)
      claim(name, groupPath)
      if (!group.bucket) groupKeys.add(sql)
      select.push(`${key} AS ${this.d.ident(name)}`)
      columns.push({ name, qualifier: null, internal: name, type, meta, hidden: false })
    })
    measures.forEach((measure, index) => {
      const measurePath = [...path, 'measures', index]
      claim(measure.alias, [...measurePath, 'alias'])
      const filter = measure.filter
        ? compileFilter(this.state, measure.filter, this.scope(relation), [
            ...measurePath,
            'filter',
          ])
        : null
      const compiled = this.measure(measure, filter, groupKeys, measurePath)
      select.push(`${compiled.sql} AS ${this.d.ident(measure.alias)}`)
      columns.push({
        name: measure.alias,
        qualifier: null,
        internal: measure.alias,
        type: compiled.type,
        meta: compiled.meta,
        hidden: false,
      })
    })
    const groupClause = groupBy.length
      ? `\nGROUP BY ${groupBy.map((_, index) => index + 1).join(', ')}`
      : ''
    const name = this.state.nextName(this.prefix)
    this.state.addCte(name, `SELECT ${select.join(', ')}\nFROM ${this.ref(relation)}${groupClause}`)
    this.pipeline.relation = {
      name,
      columns,
      restricted: new Map(),
      unavailable: new Map(),
      qualifiers: new Set(),
    }
    this.pipeline.ordering = []
    this.pipeline.aggregated = true
  }

  private measure(
    measure: Step<'aggregate'>['measures'][number],
    filter: string | null,
    groupKeys: ReadonlySet<string>,
    path: IssuePath,
  ): { sql: string; type: ValueType; meta: ColumnMeta } {
    const withFilter = (sql: string) => (filter ? `${sql} FILTER (WHERE ${filter})` : sql)
    const agg = measure.agg
    if (agg === 'expr') {
      if (!measure.expr) return fail([...path, 'expr'], 'Для меры expr нужно выражение')
      if (measure.field)
        fail([...path, 'field'], 'У меры expr поле не указывается — только выражение')
      const expr = measure.expr
      const compiled = atPath([...path, 'expr'], () =>
        compileExpression(
          expr,
          this.env(path, {
            mode: 'aggregate',
            groupKeys,
            ...(filter ? { aggregateFilter: filter } : {}),
          }),
        ),
      )
      const type = compiled.type === 'null' ? 'text' : compiled.type
      return {
        sql: compiled.type === 'null' ? 'NULL::text' : compiled.sql,
        type,
        meta: {
          fieldType: compiled.fieldType ?? fieldTypeOfValue(type),
          semantic: semanticOfValue(type),
          label: null,
          format: null,
        },
      }
    }
    if (measure.field && measure.expr) {
      fail(path, 'Укажите поле или выражение меры, но не оба')
    }
    let arg: Argument | null = null
    if (measure.field) {
      const column = resolveColumn(this.rel, measure.field, [...path, 'field'])
      arg = { sql: this.col(column), type: column.type, meta: column.meta }
    } else if (measure.expr) {
      const expr = measure.expr
      const compiled = atPath([...path, 'expr'], () => compileExpression(expr, this.env(path)))
      arg = {
        sql: compiled.sql,
        type: compiled.type,
        meta: compiled.fieldType
          ? { fieldType: compiled.fieldType, semantic: null, label: null, format: null }
          : null,
      }
    }
    const argPath = [...path, measure.field ? 'field' : 'expr']
    const need = (): Argument => {
      if (!arg) return fail([...path, 'field'], `Для меры «${agg}» нужно поле`)
      return arg
    }
    const numeric = (): Argument => {
      const value = need()
      if (value.type !== 'number') {
        fail(
          argPath,
          `Мера «${agg}» считается по числам, а получено: ${VALUE_TYPE_LABELS[value.type]}`,
        )
      }
      return value
    }
    const measureMeta = (fieldType: FieldType, source?: ColumnMeta | null): ColumnMeta => ({
      fieldType,
      semantic: 'measure',
      label: null,
      format: source?.format ?? null,
    })
    switch (agg) {
      case 'count':
        return {
          sql: withFilter(arg ? `count(${arg.sql})` : 'count(*)'),
          type: 'number',
          meta: measureMeta('integer'),
        }
      case 'count_distinct':
        return {
          sql: withFilter(`count(DISTINCT ${need().sql})`),
          type: 'number',
          meta: measureMeta('integer'),
        }
      case 'sum': {
        const value = numeric()
        return {
          sql: withFilter(`sum(${value.sql})`),
          type: 'number',
          meta: measureMeta(value.meta?.fieldType ?? 'number', value.meta),
        }
      }
      case 'avg':
      case 'median':
      case 'p90':
      case 'p95': {
        const value = numeric()
        const source = value.meta?.fieldType
        const fieldType = source && NUMERIC_FIELD_TYPES.has(source) ? source : 'number'
        const sql =
          agg === 'avg' ? `avg(${value.sql})` : this.d.percentile(PERCENTILES[agg], value.sql)
        return { sql: withFilter(sql), type: 'number', meta: measureMeta(fieldType, value.meta) }
      }
      case 'min':
      case 'max': {
        const value = need()
        if (!isOrderable(value.type)) {
          fail(
            argPath,
            `Мера «${agg}» не считается по значениям «${VALUE_TYPE_LABELS[value.type]}»`,
          )
        }
        const type = value.type === 'null' ? 'text' : value.type
        const meta = value.meta ?? {
          fieldType: fieldTypeOfValue(type),
          semantic: semanticOfValue(type),
          label: null,
          format: null,
        }
        return {
          sql: withFilter(`${agg}(${value.sql})`),
          type,
          meta:
            type === 'number'
              ? { ...meta, semantic: 'measure', label: null }
              : { ...meta, label: null },
        }
      }
      case 'first':
      case 'last': {
        const value = need()
        if (value.type === 'text[]') fail(argPath, `Мера «${agg}» не считается по спискам`)
        const order = this.firstLastOrder(agg === 'last', path)
        const type = value.type === 'null' ? 'text' : value.type
        const filterClause = filter ? ` FILTER (WHERE ${filter})` : ''
        return {
          sql: `(array_agg(${value.sql} ORDER BY ${order})${filterClause})[1]`,
          type,
          meta: value.meta
            ? { ...value.meta, label: null }
            : {
                fieldType: fieldTypeOfValue(type),
                semantic: semanticOfValue(type),
                label: null,
                format: null,
              },
        }
      }
      case 'string_agg': {
        const text = `(${need().sql})::text`
        return {
          sql: withFilter(`string_agg(${text}, ', ' ORDER BY ${text})`),
          type: 'text',
          meta: { fieldType: 'long_text', semantic: 'text', label: null, format: null },
        }
      }
      default:
        return fail([...path, 'agg'], `Неизвестная мера «${String(agg)}»`)
    }
  }

  /** Порядок для first/last: текущая сортировка, иначе порядок добавления строк (`_id`). */
  private firstLastOrder(reverse: boolean, path: IssuePath): string {
    const flip = (dir: 'asc' | 'desc') => (dir === 'asc' ? 'desc' : 'asc')
    if (this.pipeline.ordering.length) {
      return this.pipeline.ordering
        .map((item) => {
          const dir = reverse ? flip(item.dir) : item.dir
          const nulls = item.nulls
            ? reverse
              ? item.nulls === 'first'
                ? 'last'
                : 'first'
              : item.nulls
            : null
          return `${this.col(item.column)} ${dir.toUpperCase()}${nulls ? ` NULLS ${nulls.toUpperCase()}` : ''}`
        })
        .join(', ')
    }
    const id = this.rel.columns.find((column) => column.system && column.name === '_id')
    if (id) return `${this.col(id)}${reverse ? ' DESC' : ''}`
    return fail(path, 'Для first/last нужен порядок строк', {
      hint: 'Добавьте шаг сортировки перед сводкой',
    })
  }

  private window(step: Step<'window'>, path: IssuePath): void {
    const relation = this.rel
    const taken = new Set(relation.columns.map((column) => column.internal))
    const select: string[] = []
    const added: Column[] = []
    step.fields.forEach((field, index) => {
      const fieldPath = [...path, 'fields', index]
      if (
        relation.columns.some((column) => column.name === field.alias) ||
        added.some((column) => column.name === field.alias)
      ) {
        fail([...fieldPath, 'alias'], `Поле «${field.alias}» уже есть`, {
          hint: 'Выберите другое имя',
        })
      }
      const partition = (field.partitionBy ?? []).map((ref, i) =>
        this.col(resolveColumn(relation, ref, [...fieldPath, 'partitionBy', i])),
      )
      const order = (field.orderBy ?? []).map((ref, i) =>
        this.orderItem(ref, [...fieldPath, 'orderBy', i]),
      )
      if (field.fn !== 'row_number' && !order.length) {
        fail([...fieldPath, 'orderBy'], `Для «${field.fn}» нужен порядок (orderBy)`)
      }
      const target = field.field
        ? resolveColumn(relation, field.field, [...fieldPath, 'field'])
        : null
      const need = (): Column => {
        if (!target) return fail([...fieldPath, 'field'], `Для «${field.fn}» нужно поле`)
        return target
      }
      const numeric = (): Column => {
        const column = need()
        if (column.type !== 'number') {
          fail(
            [...fieldPath, 'field'],
            `«${field.fn}» считается по числам, а «${field.field}» — ${VALUE_TYPE_LABELS[column.type]}`,
          )
        }
        return column
      }
      const over = (frame?: string) => {
        const parts = [
          partition.length ? `PARTITION BY ${partition.join(', ')}` : '',
          order.length ? `ORDER BY ${order.join(', ')}` : '',
          frame ?? '',
        ].filter(Boolean)
        return `OVER (${parts.join(' ')})`
      }
      let sql: string
      let type: ValueType = 'number'
      let meta: ColumnMeta = {
        fieldType: 'integer',
        semantic: 'measure',
        label: null,
        format: null,
      }
      switch (field.fn) {
        case 'lag':
        case 'lead': {
          const column = need()
          const n = intInRange(field.n ?? 1, [...fieldPath, 'n'], 1, 1000)
          sql = `${field.fn}(${this.col(column)}, ${n}) ${over()}`
          type = column.type
          meta = { ...column.meta, label: null }
          break
        }
        case 'running_sum': {
          const column = numeric()
          sql = `sum(${this.col(column)}) ${over('ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW')}`
          meta = { ...column.meta, semantic: 'measure', label: null }
          break
        }
        case 'moving_avg': {
          const column = numeric()
          const n = intInRange(field.n ?? 3, [...fieldPath, 'n'], 1, 1000)
          sql = `avg(${this.col(column)}) ${over(`ROWS BETWEEN ${n - 1} PRECEDING AND CURRENT ROW`)}`
          const source = column.meta.fieldType
          meta = {
            fieldType: NUMERIC_FIELD_TYPES.has(source) ? source : 'number',
            semantic: 'measure',
            label: null,
            format: column.meta.format,
          }
          break
        }
        case 'rank':
        case 'dense_rank':
        case 'row_number':
          sql = `${field.fn}() ${over()}`
          break
        default:
          fail([...fieldPath, 'fn'], `Неизвестная оконная функция «${String(field.fn)}»`)
      }
      const internal = uniqueInternal(taken, field.alias)
      taken.add(internal)
      select.push(`${sql} AS ${this.d.ident(internal)}`)
      added.push({ name: field.alias, qualifier: null, internal, type, meta, hidden: false })
    })
    this.derive(`SELECT ${this.ref()}.*, ${select.join(', ')}\nFROM ${this.ref()}`, [
      ...relation.columns,
      ...added,
    ])
  }

  /** Элемент порядка окна: «поле» или «поле desc». */
  private orderItem(ref: string, path: IssuePath): string {
    const match = /^(.*?)(?:\s+(asc|desc))?$/i.exec(ref.trim())
    const field = match?.[1] ?? ref
    const dir = (match?.[2] ?? 'asc').toUpperCase()
    const column = resolveColumn(this.rel, field, path)
    if (!isOrderable(column.type)) {
      fail(path, `По полю типа «${VALUE_TYPE_LABELS[column.type]}» нельзя упорядочить`)
    }
    return `${this.col(column)} ${dir}`
  }

  private sort(step: Step<'sort'>, path: IssuePath): void {
    this.pipeline.ordering = step.by.map((item, index) => {
      const itemPath = [...path, 'by', index]
      const column = resolveColumn(this.rel, item.field, [...itemPath, 'field'])
      if (!isOrderable(column.type)) {
        fail(
          [...itemPath, 'field'],
          `По полю типа «${VALUE_TYPE_LABELS[column.type]}» нельзя сортировать`,
        )
      }
      const dir = item.dir ?? 'asc'
      if (dir !== 'asc' && dir !== 'desc') fail([...itemPath, 'dir'], 'Направление — asc или desc')
      if (item.nulls !== undefined && item.nulls !== 'first' && item.nulls !== 'last') {
        fail([...itemPath, 'nulls'], 'Пустые значения — first или last')
      }
      return { column, dir, ...(item.nulls ? { nulls: item.nulls } : {}) }
    })
  }

  private limit(step: Step<'limit'>, path: IssuePath): void {
    const limit = intInRange(step.limit, [...path, 'limit'], 0, 1_000_000)
    const offset = intInRange(step.offset ?? 0, [...path, 'offset'], 0, Number.MAX_SAFE_INTEGER)
    const order = this.orderSql()
    this.derive(
      `SELECT *\nFROM ${this.ref()}${order ? `\n${order}` : ''}\nLIMIT ${limit}${offset ? ` OFFSET ${offset}` : ''}`,
    )
  }

  private select(step: Step<'select'>, path: IssuePath): void {
    const relation = this.rel
    const seen = new Set<string>()
    const chosen = step.fields.map((item, index) => {
      const itemPath = [...path, 'fields', index]
      const ref = typeof item === 'string' ? item : item.field
      const alias = typeof item === 'string' ? null : item.alias
      const column = resolveColumn(
        relation,
        ref,
        typeof item === 'string' ? itemPath : [...itemPath, 'field'],
      )
      const name = alias ?? column.name
      const qualifier = alias !== null && alias !== column.name ? null : column.qualifier
      const key = `${qualifier ?? ''}.${name}`
      if (seen.has(key)) {
        fail(itemPath, `Поле «${name}» выбрано дважды`, { hint: 'Задайте другой alias' })
      }
      seen.add(key)
      return { column, name, qualifier }
    })
    const taken = new Set<string>()
    const columns: Column[] = []
    const select: string[] = []
    const remap = new Map<string, Column>()
    const add = (source: Column, column: Column) => {
      taken.add(column.internal)
      select.push(`${this.col(source, relation)} AS ${this.d.ident(column.internal)}`)
      columns.push(column)
      if (!remap.has(source.internal)) remap.set(source.internal, column)
    }
    for (const { column, name, qualifier } of chosen) {
      add(column, {
        ...column,
        name,
        qualifier,
        internal: uniqueInternal(taken, name),
        hidden: false,
      })
    }
    // Системные столбцы и столбцы порядка остаются скрытыми: режим таблицы и сортировка
    const ordered = new Set(this.pipeline.ordering.map((item) => item.column.internal))
    for (const column of relation.columns) {
      if (remap.has(column.internal) || !(column.system || ordered.has(column.internal))) continue
      add(column, { ...column, internal: uniqueInternal(taken, column.internal), hidden: true })
    }
    const name = this.state.nextName(this.prefix)
    this.state.addCte(name, `SELECT ${select.join(', ')}\nFROM ${this.ref(relation)}`)
    this.pipeline.relation = {
      ...relation,
      name,
      columns,
      qualifiers: new Set(
        columns.map((column) => column.qualifier).filter((q): q is string => q !== null),
      ),
    }
    this.pipeline.ordering = this.pipeline.ordering.map((item) => ({
      ...item,
      column: remap.get(item.column.internal) as Column,
    }))
  }

  private join(step: Step<'join'>, path: IssuePath): void {
    const left = this.rel
    const right = compileSource(this.state, step.source, 'j', [...path, 'source'])
    for (const qualifier of right.qualifiers) {
      if (left.qualifiers.has(qualifier)) {
        fail([...path, 'source', 'alias'], `Алиас «${qualifier}» уже используется`, {
          hint: 'Задайте источнику другой alias',
        })
      }
    }
    const on = step.on.map((pair, index) => {
      const pairPath = [...path, 'on', index]
      const l = resolveColumn(left, pair.left, [...pairPath, 'left'])
      const r = resolveColumn(right, pair.right, [...pairPath, 'right'])
      const type = unify(l.type, r.type)
      if (!type || type === 'geometry' || type === 'json') {
        return fail(
          pairPath,
          `Нельзя соединить «${VALUE_TYPE_LABELS[l.type]}» и «${VALUE_TYPE_LABELS[r.type]}»`,
          { hint: 'Поля соединения должны быть одного типа' },
        )
      }
      const lsql = convertSql(this.state, this.col(l, left), l.type, type)
      const rsql = convertSql(this.state, this.col(r, right), r.type, type)
      return `${lsql} = ${rsql}`
    })
    const taken = new Set(left.columns.map((column) => column.internal))
    const prefix = [...right.qualifiers][0] ?? right.name
    const added: Column[] = []
    const select: string[] = []
    for (const column of right.columns) {
      // Системные столбцы присоединённого источника в результат не переходят
      if (column.hidden) continue
      const internal = uniqueInternal(taken, column.internal, prefix)
      taken.add(internal)
      select.push(`${this.col(column, right)} AS ${this.d.ident(internal)}`)
      added.push({ ...column, internal })
    }
    const kind = JOIN_KINDS[step.kind ?? 'left']
    if (!kind) fail([...path, 'kind'], 'Вид соединения — inner, left, right или full')
    const name = this.state.nextName(this.prefix)
    this.state.addCte(
      name,
      `SELECT ${this.ref(left)}.*${select.length ? `, ${select.join(', ')}` : ''}\nFROM ${this.ref(left)}\n${kind} ${this.ref(right)} ON ${on.join(' AND ')}`,
    )
    this.pipeline.relation = {
      name,
      columns: [...left.columns, ...added],
      restricted: mergeSets(left.restricted, right.restricted),
      unavailable: mergeSets(left.unavailable, right.unavailable),
      qualifiers: new Set([...left.qualifiers, ...right.qualifiers]),
    }
  }

  private union(step: Step<'union'>, path: IssuePath): void {
    const left = this.rel
    const right = compileSource(this.state, step.source, 'u', [...path, 'source'])
    const lv = left.columns.filter((column) => !column.hidden)
    const rv = right.columns.filter((column) => !column.hidden)
    for (const [side, columns] of [
      ['текущем результате', lv],
      ['объединяемом источнике', rv],
    ] as const) {
      const names = columns.map((column) => column.name)
      const duplicate = names.find((name, index) => names.indexOf(name) !== index)
      if (duplicate) {
        fail(path, `Поле «${duplicate}» повторяется в ${side}`, {
          hint: 'Перед объединением переименуйте поля шагом select',
        })
      }
    }
    const names = [
      ...lv.map((column) => column.name),
      ...rv
        .filter((column) => !lv.some((l) => l.name === column.name))
        .map((column) => column.name),
    ]
    const columns: Column[] = []
    const ls: string[] = []
    const rs: string[] = []
    for (const name of names) {
      const l = lv.find((column) => column.name === name)
      const r = rv.find((column) => column.name === name)
      const type = unify(l?.type ?? 'null', r?.type ?? 'null')
      if (!type) {
        fail(
          [...path, 'source'],
          `Поле «${name}»: нельзя объединить «${VALUE_TYPE_LABELS[l?.type ?? 'null']}» и «${VALUE_TYPE_LABELS[r?.type ?? 'null']}»`,
        )
      }
      const effective = type === 'null' ? 'text' : type
      // Пустое значение недостающего поля — в точном типе поля другой стороны
      const counterpart = (l ?? r) as Column
      const nullType =
        valueTypeOfField(counterpart.meta.fieldType) === effective
          ? sqlTypeOfField(counterpart.meta.fieldType)
          : sqlTypeOfValue(effective)
      const side = (relation: Relation, column: Column | undefined) =>
        column
          ? convertSql(this.state, this.col(column, relation), column.type, effective)
          : `NULL::${nullType}`
      ls.push(`${side(left, l)} AS ${this.d.ident(name)}`)
      rs.push(`${side(right, r)} AS ${this.d.ident(name)}`)
      const source = (l ?? r) as Column
      const meta =
        l && r && l.type !== r.type
          ? { ...source.meta, fieldType: fieldTypeOfValue(effective) }
          : source.meta
      columns.push({ name, qualifier: null, internal: name, type: effective, meta, hidden: false })
    }
    const op = step.mode === 'distinct' ? 'UNION' : 'UNION ALL'
    const name = this.state.nextName(this.prefix)
    this.state.addCte(
      name,
      `SELECT ${ls.join(', ')}\nFROM ${this.ref(left)}\n${op}\nSELECT ${rs.join(', ')}\nFROM ${this.ref(right)}`,
    )
    this.pipeline.relation = {
      name,
      columns,
      restricted: new Map(),
      unavailable: new Map(),
      qualifiers: new Set(),
    }
    this.pipeline.ordering = []
  }

  private sample(step: Step<'sample'>, path: IssuePath): void {
    if (step.n !== undefined) {
      const n = intInRange(step.n, [...path, 'n'], 1, 100_000)
      this.derive(`SELECT *\nFROM ${this.ref()}\nORDER BY ${this.d.randomOrder()}\nLIMIT ${n}`)
    } else {
      const fraction = step.fraction
      if (typeof fraction !== 'number' || !(fraction > 0 && fraction <= 1)) {
        fail([...path, 'fraction'], 'Доля выборки — число больше 0 и не больше 1')
      }
      const param = this.state.binder.add(fraction, 'double precision')
      this.derive(`SELECT *\nFROM ${this.ref()}\nWHERE ${this.d.randomOrder()} < ${param}`)
    }
    this.pipeline.ordering = []
  }

  private unnest(step: Step<'unnest'>, path: IssuePath): void {
    const relation = this.rel
    const target = resolveColumn(relation, step.field, [...path, 'field'])
    if (target.type !== 'text[]') {
      fail(
        [...path, 'field'],
        `Развернуть можно только список, а «${step.field}» — ${VALUE_TYPE_LABELS[target.type]}`,
      )
    }
    const d = this.d
    const element = `${d.ident('u')}.${d.ident('value')}`
    const select = relation.columns.map((column) =>
      column.internal === target.internal
        ? `${element} AS ${d.ident(column.internal)}`
        : this.col(column),
    )
    const columns = relation.columns.map(
      (column): Column =>
        column.internal === target.internal
          ? {
              ...column,
              type: 'text',
              meta: {
                ...column.meta,
                fieldType: column.meta.fieldType === 'multi_select' ? 'select' : 'text',
              },
            }
          : column,
    )
    this.derive(
      `SELECT ${select.join(', ')}\nFROM ${this.ref()}\nLEFT JOIN LATERAL unnest(${this.col(target)}) AS ${d.ident('u')}(${d.ident('value')}) ON TRUE`,
      columns,
    )
  }
}

function mergeSets(
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

/** ORDER BY по порядку конвейера (пусто — без сортировки). */
export function orderClause(
  state: CompileState,
  relation: Relation,
  ordering: readonly Ordering[],
): string {
  if (!ordering.length) return ''
  const items = ordering.map(
    (item) =>
      `${columnSql(state.dialect, relation, item.column)} ${item.dir.toUpperCase()}${item.nulls ? ` NULLS ${item.nulls.toUpperCase()}` : ''}`,
  )
  return `ORDER BY ${items.join(', ')}`
}
