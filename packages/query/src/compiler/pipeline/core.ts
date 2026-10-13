import type { FieldType } from '@kchs/contracts'
import { atPath, ExpressionError, fail, type IssuePath } from '../../errors.js'
import { compileExpression, type ExprEnv, type ExprField } from '../../expr/compile.js'
import {
  fieldTypeOfValue,
  semanticOfValue,
  sqlTypeOfField,
  VALUE_TYPE_LABELS,
  valueTypeOfField,
} from '../../value-types.js'
import { compileFilter, type FilterScope } from '../filter.js'
import {
  type Column,
  columnSql,
  findColumn,
  type Relation,
  resolveColumn,
  uniqueInternal,
} from '../scope.js'
import { guard, userAttrValue } from '../sources.js'
import type { CompileState } from '../state.js'
import { orderClause, type Pipeline, type Prefix, type Step } from './defs.js'

/** Слой 1: текущее отношение конвейера, область имён и окружение выражений; шаги filter и compute. */
export abstract class StepCore {
  constructor(
    protected readonly state: CompileState,
    protected readonly pipeline: Pipeline,
    protected readonly prefix: Prefix,
  ) {}

  protected get d() {
    return this.state.dialect
  }

  protected get rel(): Relation {
    return this.pipeline.relation
  }

  protected ref(relation: Relation = this.rel): string {
    return this.d.ident(relation.name)
  }

  protected col(column: Column, relation: Relation = this.rel): string {
    return columnSql(this.d, relation, column)
  }

  /** Новый CTE над текущим отношением с тем же набором столбцов (или заданным). */
  protected derive(body: string, columns: Column[] = this.rel.columns): void {
    const name = this.state.nextName(this.prefix)
    this.state.addCte(name, body)
    this.pipeline.relation = { ...this.rel, name, columns }
  }

  protected scope(relation: Relation = this.rel): FilterScope {
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

  protected env(
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

  protected orderSql(): string {
    return orderClause(this.state, this.rel, this.pipeline.ordering)
  }

  protected filter(step: Step<'filter'>, path: IssuePath): void {
    const condition = compileFilter(this.state, step.where, this.scope(), [...path, 'where'])
    if (condition === null) return
    this.derive(`SELECT *\nFROM ${this.ref()}\nWHERE ${condition}`)
  }

  protected compute(step: Step<'compute'>, path: IssuePath): void {
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
          sql = this.d.cast('NULL', sqlTypeOfField(field.type))
          type = declared
        } else if (declared !== type) {
          fail(
            [...fieldPath, 'type'],
            `Выражение даёт «${VALUE_TYPE_LABELS[type]}», а объявлено «${VALUE_TYPE_LABELS[declared]}»`,
          )
        } else if (declared === 'number' && sqlTypeOfField(field.type) !== 'double precision') {
          sql = this.d.cast(`(${sql})`, sqlTypeOfField(field.type))
        }
        fieldType = field.type
      }
      if (type === 'null') {
        // Пустое значение без типа — строка (иначе Postgres не сравнит его с другими)
        sql = this.d.cast('NULL', 'text')
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
}
