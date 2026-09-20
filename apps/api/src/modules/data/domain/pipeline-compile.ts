import type {
  PipelineDefinition,
  PipelineStep,
  QueryResultField,
  QuerySpec,
  QueryStep,
} from '@kchs/contracts'
import { errors } from '~/shared/errors.js'

/**
 * Компилятор пайплайна (06-analytics-engine.md §16, ADR-0106): шаги —
 * табличные операции, каждая раскладывается в шаги `QuerySpec`. Дальше работает
 * обычный компилятор запросов: права, политики строк и столбцов,
 * параметризация и лимиты — общие с любым запросом платформы.
 *
 * Шаги, которым нужно знать текущий набор полей (переименование, приведение
 * типа, разбор строки), спрашивают его у вызывающего: тот компилирует уже
 * собранный префикс спецификации, не выполняя запрос.
 */

/** Кто сообщает поля результата префикса спецификации. */
export type FieldsResolver = (spec: QuerySpec) => Promise<QueryResultField[]>

export interface CompiledPipeline {
  spec: QuerySpec
  /** Поля результата последнего применённого шага. */
  fields: QueryResultField[]
  /** Шаг, на котором остановились (при предпросмотре) или null — весь пайплайн. */
  lastStepId: string | null
}

/** Ошибка шага пайплайна: сообщение и идентификатор шага для конструктора. */
export class PipelineStepError extends Error {
  constructor(
    readonly stepId: string,
    message: string,
  ) {
    super(message)
    this.name = 'PipelineStepError'
  }
}

const fail = (stepId: string, message: string): never => {
  throw new PipelineStepError(stepId, message)
}

/** Имя поля — без алиаса источника: после шага оно уже своё. */
const bare = (ref: string) => {
  const dot = ref.indexOf('.')
  return dot > 0 ? ref.slice(dot + 1) : ref
}

/** Экранирование поля в выражении: `alias.field` или `"поле с пробелами"`. */
function exprRef(ref: string): string {
  return /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(ref) ? ref : `"${ref.replace(/"/g, '')}"`
}

/** Строковый литерал языка выражений. */
const exprText = (value: string) => `'${value.replace(/'/g, "''")}'`

/** Уникальное имя в наборе — как в компиляторе запросов. */
function unique(name: string, taken: Set<string>): string {
  let result = name
  for (let n = 2; taken.has(result); n++) result = `${name}_${n}`
  taken.add(result)
  return result
}

/** Тип поля датасета → тип приведения языка выражений. */
const CAST_BY_TYPE: Record<string, string | undefined> = {
  text: 'text',
  long_text: 'text',
  url: 'text',
  email: 'text',
  phone: 'text',
  identifier: 'text',
  select: 'text',
  integer: 'number',
  number: 'number',
  decimal: 'number',
  money: 'number',
  percent: 'number',
  duration: 'number',
  boolean: 'boolean',
  date: 'date',
  datetime: 'datetime',
}

interface BuildState {
  steps: QueryStep[]
  /** Имена полей текущего результата — обновляются по мере надобности. */
  fields: QueryResultField[]
}

/**
 * Собирает `QuerySpec` из определения пайплайна. `untilStepId` обрезает цепочку
 * после названного шага (предпросмотр). Выключенные шаги пропускаются.
 */
export async function compilePipelineSpec(
  definition: PipelineDefinition,
  resolveFields: FieldsResolver,
  options: { untilStepId?: string | undefined } = {},
): Promise<CompiledPipeline> {
  const all = definition.steps
  const untilIndex =
    options.untilStepId === undefined
      ? all.length - 1
      : all.findIndex((step) => step.id === options.untilStepId)
  if (untilIndex < 0 && options.untilStepId !== undefined) {
    throw errors.validation('Шаг предпросмотра не найден в пайплайне')
  }
  const chain = all.slice(0, untilIndex + 1).filter((step) => !step.disabled)

  const sqlStep = chain.find((step) => step.type === 'custom_sql')
  if (sqlStep && chain[0]?.id !== sqlStep.id) {
    fail(sqlStep.id, 'Свой SQL задаёт выборку и может быть только первым шагом')
  }
  if (sqlStep && chain.length > 1) {
    fail(chain[1]?.id ?? sqlStep.id, 'После своего SQL шагов быть не может')
  }

  const spec: QuerySpec = {
    version: 1,
    source: sqlStep
      ? { kind: 'sql', sql: sqlStep.type === 'custom_sql' ? sqlStep.sql : '' }
      : definition.source,
    steps: [],
    params: {},
    options: { cache: false, approxCount: true },
  }
  if (sqlStep) {
    return { spec, fields: [], lastStepId: sqlStep.id }
  }

  const state: BuildState = { steps: [], fields: [] }
  const currentFields = async (): Promise<QueryResultField[]> => {
    if (state.fields.length > 0) return state.fields
    state.fields = await resolveFields({ ...spec, steps: [...state.steps] })
    return state.fields
  }
  const push = (...steps: QueryStep[]) => {
    state.steps.push(...steps)
    // Набор полей мог измениться — перечитаем, когда понадобится
    state.fields = []
  }

  for (const step of chain) {
    await applyStep(step, currentFields, push)
  }
  spec.steps = state.steps
  const fields = await resolveFields(spec)
  return { spec, fields, lastStepId: chain.at(-1)?.id ?? null }
}

async function applyStep(
  step: PipelineStep,
  currentFields: () => Promise<QueryResultField[]>,
  push: (...steps: QueryStep[]) => void,
): Promise<void> {
  switch (step.type) {
    case 'custom_sql':
      return
    case 'select': {
      push({
        type: 'select',
        fields: step.fields.map((item) =>
          item.as ? { field: item.field, alias: item.as } : item.field,
        ),
      })
      return
    }
    case 'rename': {
      const fields = await currentFields()
      const to = new Map(step.renames.map((item) => [bare(item.field), item.to]))
      for (const rename of step.renames) {
        if (!fields.some((field) => field.name === bare(rename.field))) {
          fail(step.id, `Поля «${rename.field}» в результате предыдущего шага нет`)
        }
      }
      push({
        type: 'select',
        fields: fields.map((field) => {
          const alias = to.get(field.name)
          return alias ? { field: field.name, alias } : field.name
        }),
      })
      return
    }
    case 'cast': {
      const fields = await currentFields()
      const taken = new Set(fields.map((field) => field.name))
      const temporary = new Map<string, string>()
      const computed = step.casts.map((item) => {
        const target = CAST_BY_TYPE[item.to]
        if (!target) fail(step.id, `Приведение к типу «${item.to}» не поддерживается`)
        const name = bare(item.field)
        if (!taken.has(name)) fail(step.id, `Поля «${item.field}» в результате нет`)
        const temp = unique(`${name}_cast`, taken)
        temporary.set(name, temp)
        return { name: temp, expr: `cast(${exprRef(item.field)}, ${exprText(target as string)})` }
      })
      push({ type: 'compute', fields: computed })
      push({
        type: 'select',
        fields: fields.map((field) => {
          const temp = temporary.get(field.name)
          return temp ? { field: temp, alias: field.name } : field.name
        }),
      })
      return
    }
    case 'filter':
      push({ type: 'filter', where: step.where })
      return
    case 'dedupe': {
      const fields = await currentFields()
      const keys = new Set(step.by.map(bare))
      for (const key of keys) {
        if (!fields.some((field) => field.name === key)) {
          fail(step.id, `Поля «${key}» в результате предыдущего шага нет`)
        }
      }
      if (step.orderBy.length > 0) push({ type: 'sort', by: step.orderBy })
      const agg = step.keep === 'last' ? ('last' as const) : ('first' as const)
      push({
        type: 'aggregate',
        groupBy: step.by.map((field) => ({ field, alias: bare(field) })),
        measures: fields
          .filter((field) => !keys.has(field.name))
          .map((field) => ({ alias: field.name, agg, field: field.name })),
      })
      return
    }
    case 'fill': {
      const fields = await currentFields()
      const name = bare(step.field)
      if (!fields.some((field) => field.name === name)) {
        fail(step.id, `Поля «${step.field}» в результате нет`)
      }
      const taken = new Set(fields.map((field) => field.name))
      const temp = unique(`${name}_fill`, taken)
      const value =
        step.with.kind === 'field'
          ? exprRef(step.with.field)
          : typeof step.with.value === 'string'
            ? exprText(step.with.value)
            : String(step.with.value)
      push({
        type: 'compute',
        fields: [{ name: temp, expr: `coalesce(${exprRef(step.field)}, ${value})` }],
      })
      push({
        type: 'select',
        fields: fields.map((field) =>
          field.name === name ? { field: temp, alias: name } : field.name,
        ),
      })
      return
    }
    case 'split': {
      const fields = await currentFields()
      const name = bare(step.field)
      if (!fields.some((field) => field.name === name)) {
        fail(step.id, `Поля «${step.field}» в результате нет`)
      }
      const separator = exprText(step.separator)
      push({
        type: 'compute',
        fields: step.into.map((alias, index) => ({
          name: alias,
          expr: `nullif(split_part(${exprRef(step.field)}, ${separator}, ${index + 1}), '')`,
        })),
      })
      if (step.drop) {
        push({
          type: 'select',
          fields: [
            ...fields.map((field) => field.name).filter((key) => key !== name),
            ...step.into,
          ],
        })
      }
      return
    }
    case 'merge_columns': {
      const fields = await currentFields()
      const parts = step.fields.map((field) => `coalesce(cast(${exprRef(field)}, 'text'), '')`)
      const separator = exprText(step.separator)
      const expr = parts.join(step.separator ? ` || ${separator} || ` : ' || ')
      push({ type: 'compute', fields: [{ name: step.into, expr }] })
      if (step.drop) {
        const dropped = new Set(step.fields.map(bare))
        push({
          type: 'select',
          fields: [
            ...fields.map((field) => field.name).filter((key) => !dropped.has(key)),
            step.into,
          ],
        })
      }
      return
    }
    case 'compute':
      push({ type: 'compute', fields: step.fields })
      return
    case 'join':
      push({ type: 'join', source: step.source, on: step.on, kind: step.kind })
      return
    case 'union':
      push({ type: 'union', source: step.source, mode: step.mode })
      return
    case 'aggregate':
      push({ type: 'aggregate', groupBy: step.groupBy, measures: step.measures })
      return
    case 'unpivot':
      push({
        type: 'unpivot',
        keep: step.keep,
        fields: step.fields,
        nameField: step.nameField,
        valueField: step.valueField,
        dropNulls: step.dropNulls,
      })
      return
    case 'pivot': {
      // Разрез с известным набором значений — условные меры сводки
      push({
        type: 'aggregate',
        groupBy: step.groupBy.map((field) => ({ field, alias: bare(field) })),
        measures: step.values.map((value, index) => ({
          alias: pivotAlias(value, index),
          agg: step.measure.agg,
          ...(step.measure.field ? { field: step.measure.field } : {}),
          filter: { field: step.column, op: 'eq' as const, value },
        })),
      })
      return
    }
    case 'geocode': {
      const alias = `t_${step.id.replace(/-/g, '_')}`
      push({
        type: 'join',
        source: { kind: 'system', name: 'territories', alias },
        on: [{ left: step.field, right: `${alias}.${step.match === 'name' ? 'name' : 'code'}` }],
        kind: 'left',
      })
      const computed = [{ name: step.as, expr: `${alias}.id` }]
      if (step.pointAs) {
        computed.push({ name: step.pointAs, expr: `st_centroid(${alias}.geom)` })
      }
      push({ type: 'compute', fields: computed })
      return
    }
    case 'assign_territory':
      push({
        type: 'spatial',
        op: 'assign_territory',
        params: {
          level: step.level,
          ...(step.as ? { as: step.as } : {}),
          ...(step.field ? { field: bare(step.field) } : {}),
        },
      })
      return
    case 'spatial_join':
      push({
        type: 'spatial',
        op: 'spatial_join',
        params: {
          predicate: step.predicate,
          ...(step.distance === undefined ? {} : { distance: step.distance }),
          ...(step.measures.length > 0 ? { measures: step.measures } : {}),
          ...(step.field ? { field: bare(step.field) } : {}),
        },
        ...(step.target === undefined ? {} : { target: step.target }),
      })
      return
  }
}

/** Имя столбца сводной таблицы: латиница и цифры, иначе — по номеру значения. */
export function pivotAlias(value: string, index: number): string {
  const key = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
  return /^[a-z_][a-z0-9_]*$/.test(key) ? key : `v_${index + 1}`
}
