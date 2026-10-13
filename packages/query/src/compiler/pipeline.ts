import type { QuerySource, QuerySpec, QueryStep } from '@kchs/contracts'
import { fail, type IssuePath, QueryCompileError } from '../errors.js'
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
import { AggregateSteps } from './pipeline/aggregate.js'
import {
  convertSql,
  intInRange,
  JOIN_KINDS,
  MAX_QUERY_DEPTH,
  mergeSets,
  type Pipeline,
  type Prefix,
  type Step,
} from './pipeline/defs.js'
import { type Column, columnSql, type Relation, resolveColumn, uniqueInternal } from './scope.js'
import { datasetSource, inlineSource } from './sources.js'
import { compileSpatial, type SpatialHost } from './spatial.js'
import type { CompileState } from './state.js'

export type { Ordering, Pipeline } from './pipeline/defs.js'
export { orderClause } from './pipeline/defs.js'

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

class StepCompiler extends AggregateSteps {
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
      case 'unpivot':
        this.unpivot(step, path)
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

  /**
   * Столбцы → строки (ADR-0106): `CROSS JOIN LATERAL (VALUES …)`. Значения
   * приводятся к общему типу; несводимые — к тексту, чтобы столбец значения был
   * одного типа.
   */
  private unpivot(step: Step<'unpivot'>, path: IssuePath): void {
    const relation = this.rel
    const d = this.d
    const kept = step.keep.map((ref, index) =>
      resolveColumn(relation, ref, [...path, 'keep', index]),
    )
    const targets = step.fields.map((ref, index) => {
      const column = resolveColumn(relation, ref, [...path, 'fields', index])
      if (column.type === 'geometry' || column.type === 'text[]' || column.type === 'json') {
        fail(
          [...path, 'fields', index],
          `Поле «${ref}» типа «${VALUE_TYPE_LABELS[column.type]}» в строки не разворачивается`,
        )
      }
      return column
    })
    let valueType: ValueType = targets[0]?.type ?? 'text'
    for (const column of targets.slice(1)) valueType = unify(valueType, column.type) ?? 'text'
    if (valueType === 'null') valueType = 'text'
    const valueSql = sqlTypeOfValue(valueType)
    const rows = targets.map((column, index) => {
      const label = this.state.binder.add(step.fields[index], 'text')
      return `(${label}, (${this.col(column)})::${valueSql})`
    })

    const taken = new Set<string>()
    const columns: Column[] = []
    const select: string[] = []
    for (const column of kept) {
      const internal = uniqueInternal(taken, column.name)
      taken.add(internal)
      select.push(`${this.col(column)} AS ${d.ident(internal)}`)
      columns.push({ ...column, internal, hidden: false })
    }
    const nameInternal = uniqueInternal(taken, step.nameField)
    taken.add(nameInternal)
    const valueInternal = uniqueInternal(taken, step.valueField)
    select.push(`${d.ident('u')}.${d.ident('name')} AS ${d.ident(nameInternal)}`)
    select.push(`${d.ident('u')}.${d.ident('value')} AS ${d.ident(valueInternal)}`)
    columns.push(
      {
        name: step.nameField,
        qualifier: null,
        internal: nameInternal,
        type: 'text',
        meta: { fieldType: 'text', semantic: 'dimension', label: null, format: null },
        hidden: false,
      },
      {
        name: step.valueField,
        qualifier: null,
        internal: valueInternal,
        type: valueType,
        meta: {
          fieldType: fieldTypeOfValue(valueType),
          semantic: semanticOfValue(valueType),
          label: null,
          format: null,
        },
        hidden: false,
      },
    )

    const where = step.dropNulls ? `\nWHERE ${d.ident('u')}.${d.ident('value')} IS NOT NULL` : ''
    const name = this.state.nextName(this.prefix)
    this.state.addCte(
      name,
      `SELECT ${select.join(', ')}\nFROM ${this.ref()}\nCROSS JOIN LATERAL (VALUES ${rows.join(', ')}) AS ${d.ident('u')}(${d.ident('name')}, ${d.ident('value')})${where}`,
    )
    this.pipeline.relation = { ...relation, name, columns, qualifiers: new Set() }
    this.pipeline.ordering = []
  }
}
