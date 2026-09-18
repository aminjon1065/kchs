import type { FieldType, QueryIssue } from '@kchs/contracts'
import { postgresDialect } from './dialect.js'
import { ExpressionError } from './errors.js'
import { compileCondition, compileExpression, type ExprEnv } from './expr/compile.js'
import { ParamBinder } from './params.js'
import type { LookupRef } from './types.js'
import { fieldTypeOfValue, type ValueType, valueTypeOfField } from './value-types.js'

export interface ExpressionCheck {
  /** Поля, доступные выражению (схема датасета или объекта); справочник — для lookup_label(). */
  fields: ReadonlyArray<{ key: string; type: FieldType; lookup?: LookupRef | null }>
  /** `aggregate` — мера или показатель: агрегаты разрешены. */
  mode?: 'row' | 'aggregate'
  /** Поля, допустимые вне агрегатов в режиме `aggregate`. */
  groupBy?: readonly string[]
  /** Результат обязан быть логическим (условие, политика строк). */
  condition?: boolean
  /** Объявленные параметры и их типы значений; не объявленные — ошибка. */
  params?: Readonly<Record<string, ValueType>>
}

export type ExpressionCheckResult =
  | { ok: true; type: ValueType; fieldType: FieldType; aggregate: boolean }
  | { ok: false; issue: QueryIssue }

const MACRO_TYPES: Record<string, { type: ValueType; array?: boolean }> = {
  me: { type: 'uuid' },
  my_unit: { type: 'uuid' },
  my_units: { type: 'uuid', array: true },
  my_territories: { type: 'uuid', array: true },
  today: { type: 'date' },
  now: { type: 'datetime' },
}

/**
 * Проверка выражения без выполнения: разбор, типы, функции. Для редакторов
 * вычисляемых полей, политик строк и показателей — ошибка с позицией и подсказкой.
 */
export function checkExpression(source: string, input: ExpressionCheck): ExpressionCheckResult {
  const fields = new Map(input.fields.map((field) => [field.key, field]))
  const groupBy = new Set((input.groupBy ?? []).map((key) => `"${key}"`))
  const env: ExprEnv = {
    dialect: postgresDialect,
    binder: new ParamBinder(postgresDialect),
    mode: input.mode ?? 'row',
    groupKeys: groupBy,
    resolveField(qualifier, name, pos) {
      const field = qualifier === null ? fields.get(name) : undefined
      const type = field ? valueTypeOfField(field.type) : undefined
      if (!field) {
        throw new ExpressionError(`Нет поля «${qualifier ? `${qualifier}.` : ''}${name}»`, pos)
      }
      if (!type)
        throw new ExpressionError(`Поле «${name}» вычисляемое — в выражении недоступно`, pos)
      return {
        sql: `"${name}"`,
        type,
        fieldType: field.type,
        ...(field.lookup ? { lookup: field.lookup } : {}),
      }
    },
    resolveParam(name, pos) {
      const type = input.params?.[name]
      if (!type) throw new ExpressionError(`Неизвестный параметр «${name}»`, pos)
      return { value: null, type }
    },
    resolveMacro(name, pos) {
      const macro = MACRO_TYPES[name]
      if (!macro) throw new ExpressionError(`Неизвестный макрос «@${name}»`, pos)
      return {
        value: macro.array ? [] : sampleOf(macro.type),
        type: macro.type,
        ...(macro.array ? { array: true } : {}),
      }
    },
    userAttr: () => ({ value: null, type: null }),
    // Справочники при проверке не нужны: важны только типы
    reference: () => `'{}'::jsonb`,
    timezone: () => '$tz',
    now: () => '$now',
  }
  try {
    const compiled = input.condition
      ? compileCondition(source, env)
      : compileExpression(source, env)
    return {
      ok: true,
      type: compiled.type,
      fieldType: compiled.fieldType ?? fieldTypeOfValue(compiled.type),
      aggregate: compiled.aggregate,
    }
  } catch (error) {
    if (!(error instanceof ExpressionError)) throw error
    return {
      ok: false,
      issue: {
        path: [],
        message: error.message,
        position: error.position,
        ...(error.hint ? { hint: error.hint } : {}),
      },
    }
  }
}

/** Пример значения макроса для проверки типов (в SQL не попадает). */
function sampleOf(type: ValueType): unknown {
  switch (type) {
    case 'uuid':
      return '00000000-0000-0000-0000-000000000000'
    case 'date':
      return '2026-01-01'
    default:
      return '2026-01-01T00:00:00Z'
  }
}
