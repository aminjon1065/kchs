import {
  CHOROPLETH_FIELDS,
  type ChoroplethLevel,
  type ChoroplethParams,
  type DatasetField,
  type FieldFormat,
  type FieldType,
  type FilterNode,
  type LangText,
  type QuerySpec,
  type QueryStep,
} from '@kchs/contracts'
import { errors } from '~/shared/errors.js'

/** Числовые поля — мера суммы и среднего. */
const NUMERIC = new Set<FieldType>(['integer', 'number', 'decimal', 'money', 'percent'])
/** Служебные имена конвейера: не пересекаются с ключами полей результата. */
const KEY = 'choropleth_territory'
const MEASURE = 'choropleth_measure'
const VALUE = 'choropleth_value'
const RATE = 'choropleth_rate'
/** Алиасы источника и справочника территорий в запросе. */
const SOURCE = 'd'
const DIRECTORY = 't'

/** Подпись и формат поля результата хороплета. */
export interface ChoroplethFieldMeta {
  label: LangText
  format: FieldFormat | null
}

export interface ChoroplethQuery {
  query: QuerySpec
  /** Подписи и форматы полей результата по ключу — их получает датасет-результат. */
  fields: Record<string, ChoroplethFieldMeta>
}

const LEVEL_LABELS: Record<ChoroplethLevel, LangText> = {
  region: { ru: 'Регион', en: 'Region' },
  district: { ru: 'Район', en: 'District' },
  jamoat: { ru: 'Джамоат', en: 'Jamoat' },
}

const plain = (ru: string, en: string): LangText => ({ ru, en })

/** «1 000» и «1,000»: множитель нормализации в подписи на языке. */
function perText(per: number, locale: 'ru' | 'en'): string {
  return new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US').format(per)
}

/** Подпись меры: количество, сумма или среднее поля. */
function measureLabel(params: ChoroplethParams, field: DatasetField | null): LangText {
  if (params.measure.agg === 'count' || !field) return plain('Количество', 'Count')
  const ru = field.label.ru
  const en = field.label.en ?? field.label.ru
  return params.measure.agg === 'sum'
    ? plain(`Сумма: ${ru}`, `Sum: ${en}`)
    : plain(`Среднее: ${ru}`, `Average: ${en}`)
}

/** Подпись нормализованного значения: «Количество на 1 000 жителей», «… на 100 км²». */
function rateLabel(params: ChoroplethParams, measure: LangText): LangText {
  const per = params.per
  const ru = perText(per, 'ru')
  const en = perText(per, 'en')
  if (params.normalize === 'area') {
    return plain(`${measure.ru} на ${ru} км²`, `${measure.en ?? measure.ru} per ${en} km²`)
  }
  const one = new Intl.PluralRules('ru').select(per) === 'one'
  return plain(
    `${measure.ru} на ${ru} ${one ? 'жителя' : 'жителей'}`,
    `${measure.en ?? measure.ru} per ${en} ${per === 1 ? 'resident' : 'residents'}`,
  )
}

/** Тип значения меры: количество — целое, сумма — как поле, среднее — дробное. */
function valueType(params: ChoroplethParams, field: DatasetField | null): FieldType {
  if (params.measure.agg === 'count') return 'integer'
  if (params.measure.agg === 'sum' && field) return field.type
  return 'number'
}

function valueFormat(params: ChoroplethParams, field: DatasetField | null): FieldFormat | null {
  if (params.measure.agg === 'count' || !field) return { precision: 0 }
  const format = field.format ?? {}
  if (params.measure.agg === 'sum') return field.format ?? null
  return { ...format, precision: format.precision ?? 2 }
}

/**
 * Запрос хороплета (ADR-0077): строки источника относятся к территориям уровня —
 * точкой на поверхности геометрии (`assign_territory`, ADR-0069) или значением
 * поля-территории (`territory_level`, ADR-0057), — мера сводится по территории и
 * присоединяется к справочнику территорий: у каждой единицы уровня с границей
 * есть строка, даже без объектов (количество и сумма — ноль). Нормализация делит
 * меру на население или площадь справочника. Проверяет поля по схеме источника;
 * права и политики применит компилятор с контекстом пользователя.
 */
export function choroplethQuery(params: ChoroplethParams, fields: DatasetField[]): ChoroplethQuery {
  const byKey = new Map(fields.map((field) => [field.key, field]))
  const source = byKey.get(params.field)
  if (params.join === 'geometry' && source?.type !== 'geometry') {
    throw errors.validation(`В датасете нет поля геометрии «${params.field}»`)
  }
  if (params.join === 'territory' && source?.type !== 'territory') {
    throw errors.validation(`В датасете нет поля территории «${params.field}»`)
  }
  let measureField: DatasetField | null = null
  if (params.measure.field) {
    measureField = byKey.get(params.measure.field) ?? null
    if (!measureField || !NUMERIC.has(measureField.type)) {
      throw errors.validation(`Мера считается по числовому полю, а «${params.measure.field}» — нет`)
    }
  }

  const steps: QueryStep[] = []
  if (params.filter) steps.push({ type: 'filter', where: params.filter })
  if (params.join === 'territory') {
    // Отбор по территории — до сводки: условие по индексу поля, а не по всем строкам
    if (params.withinId) {
      steps.push({
        type: 'filter',
        where: { field: `${SOURCE}.${params.field}`, op: 'within', value: params.withinId },
      })
    }
    steps.push({
      type: 'compute',
      fields: [
        { name: KEY, expr: `territory_level(${SOURCE}.${params.field}, '${params.level}')` },
      ],
    })
  } else {
    steps.push({
      type: 'spatial',
      op: 'assign_territory',
      params: { field: `${SOURCE}.${params.field}`, level: params.level, as: KEY },
    })
  }
  steps.push({
    type: 'aggregate',
    groupBy: [{ field: KEY }],
    measures: [
      {
        alias: MEASURE,
        agg: params.measure.agg,
        ...(params.measure.field ? { field: `${SOURCE}.${params.measure.field}` } : {}),
      },
    ],
  })
  // Правое соединение: каждая территория уровня — строкой, даже без объектов
  steps.push({
    type: 'join',
    kind: 'right',
    source: { kind: 'system', name: 'territories', alias: DIRECTORY },
    on: [{ left: KEY, right: `${DIRECTORY}.id` }],
  })
  const territories: FilterNode[] = [
    { field: `${DIRECTORY}.level`, op: 'eq', value: params.level },
    { field: `${DIRECTORY}.geom`, op: 'not_empty' },
  ]
  if (params.withinId) {
    territories.push({ field: `${DIRECTORY}.id`, op: 'within', value: params.withinId })
  }
  steps.push({ type: 'filter', where: { and: territories } })

  const type = valueType(params, measureField)
  // Среднее без объектов не определено; количество и сумма без объектов — ноль
  const value = params.measure.agg === 'avg' ? MEASURE : `coalesce(${MEASURE}, 0)`
  const computed: Array<{ name: string; expr: string; type?: FieldType }> = [
    { name: VALUE, expr: value, type },
  ]
  if (params.normalize !== 'none') {
    const basis = params.normalize === 'population' ? 'population' : 'area_km2'
    computed.push({
      name: RATE,
      expr: `safe_div(${VALUE}, ${DIRECTORY}.${basis}) * ${params.per}`,
      type: 'number',
    })
  }
  steps.push({ type: 'compute', fields: computed })

  const selected: Array<{ field: string; alias: string }> = [
    { field: `${DIRECTORY}.id`, alias: CHOROPLETH_FIELDS.territory },
    { field: `${DIRECTORY}.code`, alias: CHOROPLETH_FIELDS.code },
    { field: `${DIRECTORY}.name`, alias: CHOROPLETH_FIELDS.name },
    { field: VALUE, alias: CHOROPLETH_FIELDS.value },
  ]
  if (params.normalize === 'population') {
    selected.push({ field: `${DIRECTORY}.population`, alias: CHOROPLETH_FIELDS.population })
  }
  if (params.normalize === 'area') {
    selected.push({ field: `${DIRECTORY}.area_km2`, alias: CHOROPLETH_FIELDS.area })
  }
  if (params.normalize !== 'none') selected.push({ field: RATE, alias: CHOROPLETH_FIELDS.rate })
  selected.push({ field: `${DIRECTORY}.geom`, alias: CHOROPLETH_FIELDS.geometry })
  steps.push({ type: 'select', fields: selected })
  steps.push({ type: 'sort', by: [{ field: CHOROPLETH_FIELDS.code, dir: 'asc' }] })

  const measure = measureLabel(params, measureField)
  const meta: Record<string, ChoroplethFieldMeta> = {
    [CHOROPLETH_FIELDS.territory]: { label: LEVEL_LABELS[params.level], format: null },
    [CHOROPLETH_FIELDS.code]: { label: plain('Код', 'Code'), format: null },
    [CHOROPLETH_FIELDS.name]: { label: plain('Название', 'Name'), format: null },
    [CHOROPLETH_FIELDS.value]: { label: measure, format: valueFormat(params, measureField) },
    [CHOROPLETH_FIELDS.geometry]: { label: plain('Граница', 'Boundary'), format: null },
  }
  if (params.normalize === 'population') {
    meta[CHOROPLETH_FIELDS.population] = {
      label: plain('Население', 'Population'),
      format: { precision: 0 },
    }
  }
  if (params.normalize === 'area') {
    meta[CHOROPLETH_FIELDS.area] = {
      label: plain('Площадь, км²', 'Area, km²'),
      format: { precision: 1 },
    }
  }
  if (params.normalize !== 'none') {
    // Точность доли не задана: легенда подбирает её по значениям (ADR-0065)
    meta[CHOROPLETH_FIELDS.rate] = { label: rateLabel(params, measure), format: null }
  }

  return {
    query: {
      version: 1,
      source: { kind: 'dataset', id: params.datasetId, alias: SOURCE },
      steps,
      params: {},
      options: { cache: true, approxCount: true },
    },
    fields: meta,
  }
}
