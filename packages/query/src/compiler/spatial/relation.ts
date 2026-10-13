import type { FieldType } from '@kchs/contracts'
import { fail, type IssuePath } from '../../errors.js'
import type { ValueType } from '../../value-types.js'
import { type Column, type ColumnMeta, columnSql, type Relation } from '../scope.js'
import type { CompileState } from '../state.js'
import { geometryColumn, NAME, PARAMS, type SpatialHost, type SpatialStep } from './defs.js'
import { ParamReader } from './params.js'

/** Слой 1: текущее отношение шага — ссылки, столбцы, новые отношения поверх. */
export abstract class SpatialRelation {
  protected readonly params: ParamReader

  constructor(
    protected readonly host: SpatialHost,
    protected readonly step: SpatialStep,
    params: Record<string, unknown>,
    protected readonly path: IssuePath,
  ) {
    this.params = new ParamReader(host.state, params, [...path, 'params'], PARAMS[step.op])
  }

  protected get state(): CompileState {
    return this.host.state
  }

  protected get d() {
    return this.host.state.dialect
  }

  protected get rel(): Relation {
    return this.host.relation
  }

  protected ident(name: string): string {
    return this.d.ident(name)
  }

  protected ref(relation: Relation = this.rel): string {
    return this.d.ident(relation.name)
  }

  protected col(column: Column, relation: Relation = this.rel): string {
    return columnSql(this.d, relation, column)
  }

  protected geography(sql: string): string {
    return this.d.geography(sql)
  }

  protected meters(value: number): string {
    return this.state.binder.add(value, 'double precision')
  }

  /** Новый CTE над текущим отношением с заданными столбцами. */
  protected derive(body: string, columns: Column[], extra: Partial<Relation> = {}): void {
    const name = this.host.nextName()
    this.state.addCte(name, body)
    this.host.update({ ...this.rel, ...extra, name, columns }, false)
  }

  /** Отношение с новыми строками (ячейки, растворение): поля только результата. */
  protected restructure(body: string, columns: Column[]): void {
    const name = this.host.nextName()
    this.state.addCte(name, body)
    this.host.update(
      { name, columns, restricted: new Map(), unavailable: new Map(), qualifiers: new Set() },
      true,
    )
  }

  /** Те же строки, значение одного столбца (геометрии) заменено выражением. */
  protected replaceColumn(target: Column, sql: string): void {
    const select = this.rel.columns.map((column) =>
      column.internal === target.internal
        ? `${sql} AS ${this.ident(column.internal)}`
        : this.col(column),
    )
    this.derive(`SELECT ${select.join(', ')}\nFROM ${this.ref()}`, this.rel.columns)
  }

  /** Те же строки и добавленные столбцы. */
  protected addColumns(select: string[], added: Column[]): void {
    this.derive(`SELECT ${this.ref()}.*, ${select.join(', ')}\nFROM ${this.ref()}`, [
      ...this.rel.columns,
      ...added,
    ])
  }

  /** Поле геометрии: `params.field` или единственное поле геометрии отношения. */
  protected geometry(): Column {
    return geometryColumn(this.rel, this.params.string('field'), this.params.at('field'), 'данных')
  }

  /**
   * Имя добавляемого поля: `params.as` (занятое — ошибка) или имя по умолчанию,
   * при совпадении с полем данных — с номером (`area_km2_2`).
   */
  protected outputName(fallback: string): string {
    const names = new Set(
      this.rel.columns.filter((column) => !column.hidden).map((column) => column.name),
    )
    const value = this.params.string('as')
    if (value === undefined) {
      let name = fallback
      for (let n = 2; names.has(name); n++) name = `${fallback}_${n}`
      return name
    }
    if (!NAME.test(value) || value.length > 64) {
      fail(
        this.params.at('as'),
        'Имя поля — латиница в нижнем регистре, цифры и подчёркивание (до 64 символов)',
      )
    }
    if (names.has(value)) {
      fail(this.params.at('as'), `Поле «${value}» уже есть`, {
        hint: 'Задайте другое имя в params.as',
      })
    }
    return value
  }

  protected column(
    name: string,
    internal: string,
    type: ValueType,
    meta: Partial<ColumnMeta> & { fieldType: FieldType },
  ): Column {
    return {
      name,
      qualifier: null,
      internal,
      type,
      meta: { semantic: null, label: null, format: null, ...meta },
      hidden: false,
    }
  }

  protected taken(relation: Relation = this.rel): Set<string> {
    return new Set(relation.columns.map((column) => column.internal))
  }
}
