import { z } from 'zod'
import { FilterNode } from '../common/filter.js'
import { Uuid } from '../common/primitives.js'
import { ClassificationMethod, LayerStyle, StylePalette } from './layer-style.js'

/**
 * Хороплет-мастер (07-gis-engine.md §11, P2-E04 S04, ADR-0077): строки датасета
 * относятся к территориям уровня — геометрией внутри границы или значением поля
 * территории; мера по территории нормализуется на население или площадь. Сервер
 * строит по этим параметрам запрос анализа (объект `analysis`, ADR-0069): его
 * результат — датасет «граница территории + значение», а слой с градуированным
 * стилем (`choroplethLayerStyle`) рисует его на карте.
 */

/** Уровни хороплета — единицы с границами-полигонами (страна одна, пункты — точки). */
export const CHOROPLETH_LEVELS = ['region', 'district', 'jamoat'] as const
export const ChoroplethLevel = z.enum(CHOROPLETH_LEVELS)
export type ChoroplethLevel = z.infer<typeof ChoroplethLevel>

/**
 * Как строка источника относится к территории: `geometry` — объект лежит в
 * границе (точка на поверхности, ADR-0069 `assign_territory`), `territory` —
 * значение поля-территории (с вложенными единицами).
 */
export const CHOROPLETH_JOINS = ['geometry', 'territory'] as const
export const ChoroplethJoin = z.enum(CHOROPLETH_JOINS)
export type ChoroplethJoin = z.infer<typeof ChoroplethJoin>

export const CHOROPLETH_AGGREGATES = ['count', 'sum', 'avg'] as const
export const ChoroplethAggregate = z.enum(CHOROPLETH_AGGREGATES)
export type ChoroplethAggregate = z.infer<typeof ChoroplethAggregate>

/** Нормализация: на население территории или на её площадь (км²). */
export const CHOROPLETH_NORMALIZATIONS = ['none', 'population', 'area'] as const
export const ChoroplethNormalization = z.enum(CHOROPLETH_NORMALIZATIONS)
export type ChoroplethNormalization = z.infer<typeof ChoroplethNormalization>

/** Классификация хороплета: границы классов считаются по значениям, ручных нет. */
export const ChoroplethMethod = ClassificationMethod.exclude(['manual'])
export type ChoroplethMethod = z.infer<typeof ChoroplethMethod>

const FieldKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z_][a-z0-9_]*$/, 'ключ поля: snake_case')

export const ChoroplethStyle = z.object({
  method: ChoroplethMethod.default('quantile'),
  classes: z.number().int().min(3).max(9).default(5),
  palette: StylePalette.default({ name: 'blue', reverse: false }),
})
export type ChoroplethStyle = z.infer<typeof ChoroplethStyle>

export const ChoroplethParams = z
  .object({
    /** Датасет-источник: строки с геометрией или полем территории. */
    datasetId: Uuid,
    join: ChoroplethJoin,
    /** Поле геометрии (`join: geometry`) или поле-территория (`join: territory`) источника. */
    field: FieldKey,
    level: ChoroplethLevel,
    /** Только территории внутри этой единицы (районы одного региона); null — вся страна. */
    withinId: Uuid.nullable().default(null),
    /** Отбор строк источника до подсчёта — в формате фильтра над его полями. */
    filter: FilterNode.nullable().default(null),
    measure: z.object({
      agg: ChoroplethAggregate,
      /** Числовое поле суммы или среднего; у количества — null. */
      field: FieldKey.nullable().default(null),
    }),
    normalize: ChoroplethNormalization.default('none'),
    /** Множитель нормализации: «на 1 000 жителей», «на 100 км²». */
    per: z.number().int().min(1).max(1_000_000).default(1),
    style: ChoroplethStyle.default({
      method: 'quantile',
      classes: 5,
      palette: { name: 'blue', reverse: false },
    }),
  })
  .superRefine((params, context) => {
    const { agg, field } = params.measure
    if (agg !== 'count' && !field) {
      context.addIssue({
        code: 'custom',
        path: ['measure', 'field'],
        message: 'Для суммы и среднего нужно числовое поле',
      })
    }
    if (agg === 'count' && field) {
      context.addIssue({
        code: 'custom',
        path: ['measure', 'field'],
        message: 'Количество считается по строкам — поле не указывается',
      })
    }
    // Среднее по территории на население или площадь не делится: это не плотность
    if (agg === 'avg' && params.normalize !== 'none') {
      context.addIssue({
        code: 'custom',
        path: ['normalize'],
        message: 'Среднее не нормализуется — выберите количество или сумму',
      })
    }
  })
export type ChoroplethParams = z.infer<typeof ChoroplethParams>
export type ChoroplethParamsInput = z.input<typeof ChoroplethParams>

/**
 * Поля датасета-результата хороплета: территория, код, название, значение меры,
 * основа нормализации (население или площадь), нормализованное значение и граница.
 */
export const CHOROPLETH_FIELDS = {
  territory: 'territory',
  code: 'code',
  name: 'name',
  value: 'value',
  population: 'population',
  area: 'area_km2',
  rate: 'rate',
  geometry: 'geom',
} as const

/** Поле, которое раскрашивает слой: нормализованное значение или сама мера. */
export function choroplethValueField(params: Pick<ChoroplethParams, 'normalize'>): string {
  return params.normalize === 'none' ? CHOROPLETH_FIELDS.value : CHOROPLETH_FIELDS.rate
}

/** Поле основы нормализации в результате; без нормализации — null. */
export function choroplethBasisField(params: Pick<ChoroplethParams, 'normalize'>): string | null {
  if (params.normalize === 'population') return CHOROPLETH_FIELDS.population
  if (params.normalize === 'area') return CHOROPLETH_FIELDS.area
  return null
}

/**
 * Стиль слоя хороплета: градуированная заливка по значению, подпись — название
 * территории, карточка — значение, мера и основа нормализации. Границы классов
 * не сохраняются: карта считает их по данным слоя с политиками смотрящего.
 */
export function choroplethLayerStyle(params: ChoroplethParams): LayerStyle {
  const field = choroplethValueField(params)
  const basis = choroplethBasisField(params)
  const popup =
    field === CHOROPLETH_FIELDS.value
      ? [CHOROPLETH_FIELDS.value]
      : [field, CHOROPLETH_FIELDS.value, ...(basis ? [basis] : [])]
  return LayerStyle.parse({
    version: 1,
    geometry: 'polygon',
    renderer: {
      kind: 'graduated',
      field,
      method: params.style.method,
      classes: params.style.classes,
      palette: params.style.palette,
    },
    polygon: { fillOpacity: 0.75, outline: { width: 0.75, color: 'auto' } },
    label: { field: CHOROPLETH_FIELDS.name, minZoom: 7, size: 11 },
    popup: { title: `{{${CHOROPLETH_FIELDS.name}}}`, fields: popup, actions: ['open'] },
  })
}
