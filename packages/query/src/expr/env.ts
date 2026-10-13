import type { FieldType } from '@kchs/contracts'
import type { Dialect } from '../dialect.js'
import type { ParamBinder } from '../params.js'
import type { LookupRef, ReferenceRequest } from '../types.js'
import type { ValueType } from '../value-types.js'

/** Поле, на которое ссылается выражение: SQL-ссылка и тип. */
export interface ExprField {
  sql: string
  type: ValueType
  fieldType?: FieldType
  /** Справочник поля — для `lookup_label()`. */
  lookup?: LookupRef
}

/** Значение параметра или макроса и его тип (null — вывести по значению). */
export interface ExprValue {
  value: unknown
  type: ValueType | null
  /** Массив значений (`@my_units`, список-параметр) — только внутри `in (…)`. */
  array?: boolean
}

export interface ExprEnv {
  dialect: Dialect
  binder: ParamBinder
  /** `row` — выражение строки; `aggregate` — мера шага aggregate (агрегаты разрешены). */
  mode: 'row' | 'aggregate'
  resolveField(qualifier: string | null, name: string, pos: number): ExprField
  /** Ключи группировки (SQL-ссылки) — единственные поля, допустимые вне агрегатов. */
  groupKeys?: ReadonlySet<string>
  /** Условие условной меры: каждый агрегат выражения получает `FILTER (WHERE …)`. */
  aggregateFilter?: string
  resolveParam(name: string, pos: number): ExprValue
  resolveMacro(name: string, pos: number): ExprValue
  userAttr(key: string, pos: number): ExprValue
  /**
   * SQL подстановки jsonb «значение → результат» для справочной функции
   * (`territory_level`, `territory_name`, `lookup_label`); нет — функции недоступны.
   */
  reference?(request: ReferenceRequest): string
  /** SQL часового пояса (общий параметр запроса). */
  timezone(): string
  /** SQL момента «сейчас» (общий параметр запроса). */
  now(): string
}

/** Скомпилированное выражение: SQL, тип, признаки. */
export interface CompiledExpr {
  sql: string
  type: ValueType
  aggregate: boolean
  fieldType?: FieldType
}
