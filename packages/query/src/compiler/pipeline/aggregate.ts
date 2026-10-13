import { type FieldType, TIME_BUCKETS } from '@kchs/contracts'
import { atPath, fail, type IssuePath } from '../../errors.js'
import { compileExpression } from '../../expr/compile.js'
import {
  fieldTypeOfValue,
  isOrderable,
  semanticOfValue,
  VALUE_TYPE_LABELS,
  type ValueType,
} from '../../value-types.js'
import { compileFilter } from '../filter.js'
import { type Column, type ColumnMeta, resolveColumn, uniqueInternal } from '../scope.js'
import { StepCore } from './core.js'
import { type Argument, intInRange, NUMERIC_FIELD_TYPES, PERCENTILES, type Step } from './defs.js'

/** Слой 2: шаги aggregate и window — группировка, меры, оконные функции. */
export abstract class AggregateSteps extends StepCore {
  protected aggregate(step: Step<'aggregate'>, path: IssuePath): void {
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

  protected measure(
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
        sql: compiled.type === 'null' ? this.d.cast('NULL', 'text') : compiled.sql,
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
        const text = this.d.cast(`(${need().sql})`, 'text')
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
  protected firstLastOrder(reverse: boolean, path: IssuePath): string {
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

  protected window(step: Step<'window'>, path: IssuePath): void {
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
  protected orderItem(ref: string, path: IssuePath): string {
    const match = /^(.*?)(?:\s+(asc|desc))?$/i.exec(ref.trim())
    const field = match?.[1] ?? ref
    const dir = (match?.[2] ?? 'asc').toUpperCase()
    const column = resolveColumn(this.rel, field, path)
    if (!isOrderable(column.type)) {
      fail(path, `По полю типа «${VALUE_TYPE_LABELS[column.type]}» нельзя упорядочить`)
    }
    return `${this.col(column)} ${dir}`
  }
}
