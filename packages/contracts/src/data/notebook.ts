import { z } from 'zod'
import { type FilterNode, RelativeRange, WithinValue } from '../common/filter.js'
import { DateOnly, Timestamp, Uuid } from '../common/primitives.js'
import { RichBody } from '../discussions/message.js'
import { MapCamera } from '../gis/map.js'
import { ChartType } from './chart.js'
import { ExplorePlan } from './explore.js'
import type { QuerySpec } from './query.js'
import { SQL_MAX_LENGTH } from './sql.js'

/**
 * Тетрадь (06-analytics-engine.md §11, 03-screens.md §9) — объект реестра
 * `notebook`: ячейки по порядку и параметры, общие для всех ячеек. Тело
 * правится совместно — документ Yjs (ADR-0070, ADR-0071); здесь — его
 * JSON-снимок для поиска, экспорта и создания тетради через API.
 */

/** Виды ячеек. `map` — сохранённая карта или слой со своим видом (ADR-0074). */
export const NOTEBOOK_CELL_KINDS = ['text', 'query', 'chart', 'metric', 'ai', 'map'] as const
export const NotebookCellKind = z.enum(NOTEBOOK_CELL_KINDS)
export type NotebookCellKind = z.infer<typeof NotebookCellKind>

/** Ячеек в тетради не больше — документ остаётся лёгким для совместной правки. */
export const NOTEBOOK_MAX_CELLS = 200

export const NotebookCellId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)

/**
 * Поле источника ячейки, к которому применяется параметр тетради: не задано —
 * выбирается автоматически (первое поле даты, поле территории датасета),
 * `null` — параметр к ячейке не применяется.
 */
export const NotebookBindings = z.object({
  period: z.string().min(1).max(64).nullable().optional(),
  territory: z.string().min(1).max(64).nullable().optional(),
})
export type NotebookBindings = z.infer<typeof NotebookBindings>

/** План новой ячейки-запроса: количество строк, как у пустого «Исследования». */
export const EMPTY_EXPLORE_PLAN: ExplorePlan = {
  filter: null,
  groups: [],
  measures: [{ agg: 'count' }],
  sort: null,
  limit: null,
}

const base = {
  id: NotebookCellId,
  /** Подпись ячейки в оглавлении; у текста оглавление — его заголовки. */
  title: z.string().max(200).nullable().default(null),
}

/** Запрос ячейки (визуальный конструктор «Исследования») и его вид. */
const query = {
  datasetId: Uuid.nullable().default(null),
  plan: ExplorePlan.default(EMPTY_EXPLORE_PLAN),
  view: z.enum(['table', 'chart']).default('chart'),
  /** null — тип графика подбирается по результату. */
  chartType: ChartType.nullable().default(null),
  bindings: NotebookBindings.default({}),
}

export const NotebookTextCell = z.object({
  ...base,
  kind: z.literal('text'),
  body: RichBody.default({ type: 'doc', content: [] }),
})

export const NotebookQueryCell = z.object({
  ...base,
  kind: z.literal('query'),
  /** Визуальный конструктор или SQL (нужна способность `data.sql`). */
  mode: z.enum(['visual', 'sql']).default('visual'),
  /** SQL: параметры тетради — `{{period_from}}`, `{{period_to}}`, `{{territory}}`. */
  sql: z.string().max(SQL_MAX_LENGTH).default(''),
  ...query,
})

/**
 * ИИ-ячейка: вопрос → план «Спросить данные» (ADR-0061) с графиком; дальше план
 * правится, как в ячейке-запросе («показать запрос»).
 */
export const NotebookAiCell = z.object({
  ...base,
  kind: z.literal('ai'),
  question: z.string().max(500).default(''),
  /** Ответ модели: название и как она поняла вопрос; null — вопрос ещё не задан. */
  answer: z
    .object({ title: z.string().max(200), explanation: z.string().max(2000) })
    .nullable()
    .default(null),
  ...query,
})

export const NotebookChartCell = z.object({
  ...base,
  kind: z.literal('chart'),
  chartId: Uuid.nullable().default(null),
  bindings: NotebookBindings.default({}),
})

export const NotebookMetricCell = z.object({
  ...base,
  kind: z.literal('metric'),
  metricId: Uuid.nullable().default(null),
  bindings: NotebookBindings.default({}),
})

/**
 * Ячейка карты (ADR-0074): сохранённая карта или один слой на подложке по
 * умолчанию; вид ячейки — свой. Параметры тетради уходят тайлам слоёв условием
 * по полям их датасетов (территория — поле территории, период — поле времени слоя).
 */
export const NotebookMapCell = z.object({
  ...base,
  kind: z.literal('map'),
  mapId: Uuid.nullable().default(null),
  /** Слой вместо карты; задан один из двух. */
  layerId: Uuid.nullable().default(null),
  /** Вид ячейки; null — вид карты или охват слоя. */
  camera: MapCamera.nullable().default(null),
})

export const NotebookCell = z.discriminatedUnion('kind', [
  NotebookTextCell,
  NotebookQueryCell,
  NotebookAiCell,
  NotebookChartCell,
  NotebookMetricCell,
  NotebookMapCell,
])
export type NotebookCell = z.infer<typeof NotebookCell>
export type NotebookCellInput = z.input<typeof NotebookCell>

/** Период тетради: относительный (как фильтр-период дашборда) или интервал дат. */
export const NotebookPeriod = z.union([RelativeRange, z.object({ from: DateOnly, to: DateOnly })])
export type NotebookPeriod = z.infer<typeof NotebookPeriod>

/** Параметры тетради — общие для всех ячеек; null — параметр не задан. */
export const NotebookParams = z.object({
  period: NotebookPeriod.nullable().default(null),
  /** Единица справочника территорий вместе с вложенными (ADR-0057). */
  territory: WithinValue.nullable().default(null),
})
export type NotebookParams = z.infer<typeof NotebookParams>

export const NotebookRecord = z.object({
  id: Uuid,
  name: z.string(),
  spaceId: Uuid,
  parentId: Uuid.nullable(),
  cells: z.array(NotebookCell),
  params: NotebookParams,
  version: z.number().int().nonnegative(),
  updatedAt: Timestamp,
})
export type NotebookRecord = z.infer<typeof NotebookRecord>

export const NotebookCreateInput = z.object({
  name: z.string().trim().min(1).max(200),
  spaceId: Uuid,
  parentId: Uuid.nullable().optional(),
  cells: z.array(NotebookCell).max(NOTEBOOK_MAX_CELLS).default([]),
  params: NotebookParams.default({ period: null, territory: null }),
})
export type NotebookCreateInput = z.infer<typeof NotebookCreateInput>

/** Ячейки, добавленные сервером (из «Исследования», ИИ): сразу видны всем, кто открыл тетрадь. */
export const NotebookCellsInput = z.object({
  cells: z.array(NotebookCell).min(1).max(20),
  /** Позиция вставки; по умолчанию — в конец. */
  index: z.number().int().min(0).optional(),
})
export type NotebookCellsInput = z.infer<typeof NotebookCellsInput>

// ─── Документ Yjs ────────────────────────────────────────────────────────────

/**
 * Раскладка документа Yjs тетради (ADR-0071): `cells` — `Y.Map` ячеек по
 * идентификатору, `order` — `Y.Array` идентификаторов по порядку (перенос ячейки
 * не трогает её содержимое, и правка, идущая в ней в этот момент, не теряется),
 * `params` — `Y.Map` параметров. Ячейка — `Y.Map` с ключами из раскладки её
 * вида: `rich` — `Y.XmlFragment` (текст Tiptap), `text` — `Y.Text` (SQL: правки
 * двух авторов сливаются посимвольно), `json` — значение целиком (побеждает
 * последняя запись).
 */
export const NOTEBOOK_DOC = { cells: 'cells', order: 'order', params: 'params' } as const

export type NotebookValueKind = 'rich' | 'text' | 'json'

const COMMON_LAYOUT = { id: 'json', kind: 'json', title: 'json' } as const
const QUERY_LAYOUT = {
  datasetId: 'json',
  plan: 'json',
  view: 'json',
  chartType: 'json',
  bindings: 'json',
} as const

export const NOTEBOOK_CELL_LAYOUT = {
  text: { ...COMMON_LAYOUT, body: 'rich' },
  query: { ...COMMON_LAYOUT, ...QUERY_LAYOUT, mode: 'json', sql: 'text' },
  ai: { ...COMMON_LAYOUT, ...QUERY_LAYOUT, question: 'json', answer: 'json' },
  chart: { ...COMMON_LAYOUT, chartId: 'json', bindings: 'json' },
  metric: { ...COMMON_LAYOUT, metricId: 'json', bindings: 'json' },
  map: { ...COMMON_LAYOUT, mapId: 'json', layerId: 'json', camera: 'json' },
} as const satisfies Record<NotebookCellKind, Record<string, NotebookValueKind>>

// ─── Параметры → запрос ──────────────────────────────────────────────────────

/** Поля источника, к которым применяются параметры тетради; null — не применять. */
export interface NotebookParamFields {
  period: string | null
  territory: string | null
}

const PERIOD_TYPES = new Set(['date', 'datetime'])

/**
 * Поля параметров для источника ячейки: привязка ячейки или первое подходящее
 * поле схемы — поле даты для периода, поле территории датасета для территории.
 */
export function notebookParamFields(
  bindings: NotebookBindings | undefined,
  fields: ReadonlyArray<{ key: string; type: string }>,
  territoryField?: string | null,
): NotebookParamFields {
  const keys = new Set(fields.map((field) => field.key))
  const pick = (bound: string | null | undefined, auto: string | null): string | null => {
    if (bound === null) return null
    if (bound !== undefined) return keys.has(bound) ? bound : null
    return auto
  }
  const autoTerritory =
    (territoryField && keys.has(territoryField) ? territoryField : null) ??
    fields.find((field) => field.type === 'territory')?.key ??
    null
  return {
    period: pick(
      bindings?.period,
      fields.find((field) => PERIOD_TYPES.has(field.type))?.key ?? null,
    ),
    territory: pick(bindings?.territory, autoTerritory),
  }
}

/** Условие параметров тетради над полями источника; параметры не заданы — null. */
export function notebookParamsFilter(
  params: NotebookParams,
  fields: NotebookParamFields,
): FilterNode | null {
  const conditions: FilterNode[] = []
  if (params.period && fields.period) {
    conditions.push(
      'unit' in params.period
        ? { field: fields.period, op: 'relative', value: params.period }
        : { field: fields.period, op: 'between', value: [params.period.from, params.period.to] },
    )
  }
  if (params.territory && fields.territory) {
    conditions.push({ field: fields.territory, op: 'within', value: params.territory })
  }
  if (conditions.length === 0) return null
  return conditions.length === 1 ? (conditions[0] as FilterNode) : { and: conditions }
}

/**
 * Параметры тетради → шаг `filter` в начале запроса ячейки: условия действуют
 * на строки источника до сводок (как глобальные фильтры дашборда).
 */
export function applyNotebookParams(
  spec: QuerySpec,
  params: NotebookParams,
  fields: NotebookParamFields,
): QuerySpec {
  const where = notebookParamsFilter(params, fields)
  if (!where) return spec
  return { ...spec, steps: [{ type: 'filter', where }, ...spec.steps] }
}
