import type {
  ChoroplethAggregate,
  ChoroplethJoin,
  ChoroplethLevel,
  ChoroplethMethod,
  ChoroplethNormalization,
  ChoroplethParamsInput,
  DatasetField,
  DatasetRecord,
  FieldType,
  StylePaletteName,
} from '@kchs/contracts'

/**
 * Состояние хороплет-мастера (P2-E04 S04, ADR-0077): источник, территории,
 * мера и нормализация, классы и палитра. Из него строятся параметры
 * `ChoroplethParams` — запрос анализа строит сервер.
 */
export interface ChoroplethForm {
  datasetId: string | null
  join: ChoroplethJoin
  /** Поле геометрии или территории источника. */
  field: string | null
  level: ChoroplethLevel
  withinId: string | null
  agg: ChoroplethAggregate
  measureField: string | null
  normalize: ChoroplethNormalization
  per: number
  method: ChoroplethMethod
  classes: number
  palette: StylePaletteName
  reverse: boolean
}

/** Уровни мастера: у регионов и районов есть границы. */
export const WIZARD_LEVELS: readonly ChoroplethLevel[] = ['region', 'district']
export const WIZARD_METHODS: readonly ChoroplethMethod[] = ['jenks', 'quantile', 'equal', 'log']
/** Последовательные и расходящиеся шкалы карт (ADR-0065); категориальная — не для классов. */
export const WIZARD_PALETTES: readonly StylePaletteName[] = [
  'blue',
  'teal',
  'orange',
  'viridis',
  'red-blue',
  'brown-teal',
]
/** Множители нормализации: на 1 000 жителей, на 100 км². */
export const PER_OPTIONS: Record<Exclude<ChoroplethNormalization, 'none'>, readonly number[]> = {
  population: [1000, 10_000, 100_000],
  area: [1, 100, 1000],
}

const NUMERIC = new Set<FieldType>(['integer', 'number', 'decimal', 'money', 'percent'])

/** Поля источника: геометрии, территории и числовые — для меры. */
export function sourceFields(dataset: DatasetRecord | null | undefined): {
  geometry: DatasetField[]
  territory: DatasetField[]
  numeric: DatasetField[]
} {
  const fields = dataset?.fields ?? []
  return {
    geometry: fields.filter((field) => field.type === 'geometry'),
    territory: fields.filter((field) => field.type === 'territory'),
    numeric: fields.filter((field) => NUMERIC.has(field.type)),
  }
}

/** Датасет годится для хороплета: есть геометрия или поле территории. */
export function choroplethReady(dataset: DatasetRecord | null | undefined): boolean {
  const { geometry, territory } = sourceFields(dataset)
  return geometry.length > 0 || territory.length > 0
}

/**
 * Связь с территорией по умолчанию: поле территории датасета (быстрее и так,
 * как данные размечены), иначе — геометрия в границах.
 */
export function defaultJoin(dataset: DatasetRecord | null | undefined): {
  join: ChoroplethJoin
  field: string | null
} {
  const { geometry, territory } = sourceFields(dataset)
  const designated = territory.find((field) => field.key === dataset?.territoryField)
  const byTerritory = designated ?? territory[0]
  if (byTerritory) return { join: 'territory', field: byTerritory.key }
  return { join: 'geometry', field: geometry[0]?.key ?? null }
}

export function initialForm(dataset: DatasetRecord | null | undefined): ChoroplethForm {
  return {
    datasetId: dataset?.id ?? null,
    ...defaultJoin(dataset),
    level: 'district',
    withinId: null,
    agg: 'count',
    measureField: null,
    normalize: 'population',
    per: 1000,
    // Естественные границы: у хороплета много нулей — квантили слили бы их с малыми значениями
    method: 'jenks',
    classes: 5,
    palette: 'blue',
    reverse: false,
  }
}

/** Смена датасета: связь, поле и мера — по его схеме, остальное остаётся. */
export function withDataset(form: ChoroplethForm, dataset: DatasetRecord): ChoroplethForm {
  return {
    ...form,
    datasetId: dataset.id,
    ...defaultJoin(dataset),
    measureField: null,
    agg: 'count',
  }
}

/** Мера: у среднего нормализации нет, у суммы и среднего нужно числовое поле. */
export function withMeasure(
  form: ChoroplethForm,
  agg: ChoroplethAggregate,
  numeric: readonly DatasetField[],
): ChoroplethForm {
  const measureField = agg === 'count' ? null : (form.measureField ?? numeric[0]?.key ?? null)
  const normalize = agg === 'avg' ? 'none' : form.normalize
  return { ...form, agg, measureField, normalize }
}

/** Смена нормализации: множитель — первый из вариантов новой основы («на 1 000 жителей», «на км²»). */
export function withNormalize(
  form: ChoroplethForm,
  normalize: ChoroplethNormalization,
): ChoroplethForm {
  if (normalize === form.normalize) return form
  if (normalize === 'none') return { ...form, normalize }
  return { ...form, normalize, per: PER_OPTIONS[normalize][0] as number }
}

/** Параметры для API; null — форма не заполнена (источник, поле или мера). */
export function choroplethParams(form: ChoroplethForm): ChoroplethParamsInput | null {
  if (!form.datasetId || !form.field) return null
  if (form.agg !== 'count' && !form.measureField) return null
  return {
    datasetId: form.datasetId,
    join: form.join,
    field: form.field,
    level: form.level,
    withinId: form.withinId,
    filter: null,
    measure: { agg: form.agg, field: form.agg === 'count' ? null : form.measureField },
    normalize: form.normalize,
    per: form.normalize === 'none' ? 1 : form.per,
    style: {
      method: form.method,
      classes: form.classes,
      palette: { name: form.palette, reverse: form.reverse },
    },
  }
}

export const WIZARD_STEPS = ['source', 'territories', 'measure', 'style', 'result'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

/** Шаг заполнен — можно идти дальше. */
export function stepReady(step: WizardStep, form: ChoroplethForm): boolean {
  switch (step) {
    case 'source':
      return Boolean(form.datasetId && form.field)
    case 'territories':
      return true
    case 'measure':
      return form.agg === 'count' || Boolean(form.measureField)
    case 'style':
    case 'result':
      return choroplethParams(form) !== null
  }
}
