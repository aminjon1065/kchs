import {
  type ChartSpec,
  DashboardCreateInput,
  type DashboardTile,
  type LangText,
  MetricCreateInput,
  type QuerySpec,
} from '@kchs/contracts'
import { Dashboards, Metrics } from '~/modules/data/public.js'
import { db } from '~/shared/db/client.js'
import { findPackObject, type PackContext, packKey } from './context.js'

type Ids = ReadonlyMap<string, string>

const ru = (text: string): LangText => ({ ru: text })
const today = { unit: 'day' as const, from: 0, to: 0 }
const lastDays = (field: string, days: number) => ({
  field,
  op: 'relative' as const,
  value: { unit: 'day' as const, from: 1 - days, to: 0 },
})
/**
 * Уже случившееся: время события не позже «сейчас». На настоящих данных условие ничего
 * не отсекает, а строка с будущим временем — ошибка ввода, и в оперативную обстановку
 * она не попадает (демо-набор генератора тянется до конца года, ADR-0063).
 */
const happened = (field: string) => ({ field, op: 'lte' as const, value: '@now' })
const recent = (field: string, days: number) => ({
  and: [lastDays(field, days), happened(field)],
})

interface PackMetric {
  key: string
  /** Датасет пакета или системный датасет (`tasks`) — права смотрящего применяет он сам. */
  source: { dataset: string } | { system: 'tasks' }
  /** Определение без пространства и датасета — их подставляет установка. */
  input: Record<string, unknown>
}

/**
 * Показатели пакета (04-domain-pack-emergency.md «Показатели»): одно определение —
 * одно число на ситуационном экране, в сводке, в алерте и в паспорте территории.
 */
function packMetrics(spaceId: string): PackMetric[] {
  const count = { agg: 'count' as const }
  return [
    {
      key: 'metric.hq_tasks_overdue',
      source: { system: 'tasks' },
      input: {
        name: 'Просроченные поручения штаба',
        description:
          'Открытые поручения пространства штаба, срок которых прошёл: из распоряжений, протоколов заседаний и правил',
        definition: {
          measure: count,
          filter: {
            and: [
              { field: 'overdue', op: 'is_true' },
              { field: 'space', op: 'eq', value: spaceId },
            ],
          },
          timeField: 'due_at',
          dimensions: ['assignee', 'controller'],
          period: null,
          comparison: 'none',
        },
        format: { precision: 0 },
        direction: 'down',
        thresholds: [
          { value: 1, status: 'warning' },
          { value: 5, status: 'danger' },
        ],
      },
    },
    {
      key: 'metric.incidents_today',
      source: { dataset: 'incidents' },
      input: {
        name: 'Происшествия за сутки',
        description: 'Происшествия и ЧС с начала текущих суток — по всем источникам',
        definition: {
          measure: count,
          filter: happened('occurred_at'),
          timeField: 'occurred_at',
          dimensions: ['territory', 'type_code', 'scale'],
          period: today,
          comparison: 'previous_period',
        },
        format: { precision: 0 },
        direction: 'down',
      },
    },
    {
      key: 'metric.injured_today',
      source: { dataset: 'incidents' },
      input: {
        name: 'Пострадавшие за сутки',
        definition: {
          measure: { agg: 'sum', field: 'injured' },
          filter: happened('occurred_at'),
          timeField: 'occurred_at',
          dimensions: ['territory', 'type_code'],
          period: today,
          comparison: 'previous_period',
        },
        format: { precision: 0 },
        direction: 'down',
        thresholds: [{ value: 10, status: 'warning' }],
      },
    },
    {
      key: 'metric.deaths_today',
      source: { dataset: 'incidents' },
      input: {
        name: 'Погибшие за сутки',
        definition: {
          measure: { agg: 'sum', field: 'deaths' },
          filter: happened('occurred_at'),
          timeField: 'occurred_at',
          dimensions: ['territory', 'type_code'],
          period: today,
          comparison: 'previous_period',
        },
        format: { precision: 0 },
        direction: 'down',
        thresholds: [{ value: 1, status: 'danger' }],
      },
    },
    {
      key: 'metric.incidents_month',
      source: { dataset: 'incidents' },
      input: {
        name: 'Происшествия за месяц',
        definition: {
          measure: count,
          filter: happened('occurred_at'),
          timeField: 'occurred_at',
          dimensions: ['territory', 'type_code', 'scale'],
          period: { unit: 'month', from: 0, to: 0 },
          comparison: 'previous_year',
        },
        format: { precision: 0 },
        direction: 'down',
      },
    },
    {
      key: 'metric.damage_month',
      source: { dataset: 'incidents' },
      input: {
        name: 'Ущерб за месяц',
        definition: {
          measure: { agg: 'sum', field: 'damage' },
          filter: happened('occurred_at'),
          timeField: 'occurred_at',
          dimensions: ['territory', 'type_code'],
          period: { unit: 'month', from: 0, to: 0 },
          comparison: 'previous_year',
        },
        unit: 'сомони',
        format: { precision: 0, thousands: true },
        direction: 'down',
      },
    },
    {
      key: 'metric.posts_above_danger',
      source: { dataset: 'water_levels' },
      input: {
        name: 'Гидропосты выше опасного уровня',
        description: 'Посты, у которых сегодняшний уровень воды выше опасной отметки',
        definition: {
          measure: count,
          filter: { field: 'above_danger', op: 'is_true' },
          timeField: 'observed_on',
          dimensions: ['post_code', 'territory'],
          period: today,
          comparison: 'previous_period',
        },
        format: { precision: 0 },
        direction: 'down',
        thresholds: [
          { value: 1, status: 'warning' },
          { value: 5, status: 'danger' },
        ],
      },
    },
    {
      key: 'metric.messages_new',
      source: { dataset: 'hazard_messages' },
      input: {
        name: 'Нерассмотренные сообщения об опасных явлениях',
        description: 'Сообщения лент и служб, по которым дежурный ещё не принял решения',
        definition: {
          measure: count,
          filter: { field: 'status', op: 'eq', value: 'new' },
          timeField: 'occurred_at',
          dimensions: ['source', 'hazard', 'territory'],
          period: null,
          comparison: 'none',
        },
        format: { precision: 0 },
        direction: 'down',
        thresholds: [{ value: 1, status: 'warning' }],
      },
    },
    {
      key: 'metric.shelter_free',
      source: { dataset: 'shelters' },
      input: {
        name: 'Свободные места в ПВР',
        definition: {
          measure: { agg: 'expr', expr: 'sum(capacity) - sum(occupied)' },
          dimensions: ['territory', 'status'],
          period: null,
          comparison: 'none',
        },
        unit: 'чел.',
        format: { precision: 0, thousands: true },
        direction: 'up',
      },
    },
    {
      key: 'metric.shelter_occupied',
      source: { dataset: 'shelters' },
      input: {
        name: 'Размещено в ПВР',
        definition: {
          measure: { agg: 'sum', field: 'occupied' },
          dimensions: ['territory', 'status'],
          period: null,
          comparison: 'none',
        },
        unit: 'чел.',
        format: { precision: 0, thousands: true },
        direction: 'neutral',
      },
    },
    {
      key: 'metric.forces_ready',
      source: { dataset: 'forces' },
      input: {
        name: 'Готовность сил и средств',
        description: 'Доля сил и средств в готовности от положенных по штату',
        definition: {
          measure: { agg: 'expr', expr: '100.0 * sum(ready) / sum(quantity)' },
          dimensions: ['unit', 'resource_type', 'territory'],
          period: null,
          comparison: 'none',
        },
        format: { precision: 0, scale: 'percent' },
        direction: 'up',
        thresholds: [
          { value: 0, status: 'danger' },
          { value: 80, status: 'warning' },
          { value: 90, status: 'success' },
        ],
      },
    },
  ]
}

async function ensureMetrics(pack: PackContext, datasets: Ids): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const metric of packMetrics(pack.spaceId)) {
    const found = await findPackObject('metric', metric.key)
    if (found) {
      ids.set(metric.key, found)
      continue
    }
    const origin =
      'system' in metric.source
        ? { systemSource: metric.source.system }
        : { datasetId: datasets.get(metric.source.dataset) }
    if (!('systemSource' in origin) && !origin.datasetId) continue
    const id = await db().transaction((tx) =>
      Metrics.create(
        tx,
        pack.ctx,
        MetricCreateInput.parse({ ...metric.input, spaceId: pack.spaceId, ...origin }),
        { systemKey: packKey(metric.key) },
      ),
    )
    ids.set(metric.key, id)
  }
  return ids
}

// ── Построители плиток ────────────────────────────────────────────────────────

const source = (id: string, alias: string) => ({ kind: 'dataset' as const, id, alias })

interface Column {
  field: string
  label: string
  type: 'temporal' | 'nominal' | 'quantitative'
}

/** Таблица: столбцы — каналы кодировки с подписями (без кодировки были бы все поля). */
function table(query: QuerySpec, columns: Column[]): ChartSpec {
  const channel = (column: Column) => ({
    field: column.field,
    type: column.type,
    label: ru(column.label),
  })
  const [first, ...rest] = columns as [Column, ...Column[]]
  return {
    version: 1,
    type: 'table',
    data: { query },
    encoding: {
      x: channel(first),
      y: rest.map((column) => ({ ...channel(column), axis: 'left' as const })),
      tooltip: [],
    },
  } as unknown as ChartSpec
}

function chart(
  type: 'bar' | 'line' | 'area',
  query: QuerySpec,
  x: Column,
  y: Column[],
  options: Record<string, unknown> = {},
  color?: Column,
): ChartSpec {
  return {
    version: 1,
    type,
    data: { query },
    encoding: {
      x: { field: x.field, type: x.type, label: ru(x.label) },
      y: y.map((item) => ({
        field: item.field,
        type: item.type,
        label: ru(item.label),
        axis: 'left' as const,
      })),
      ...(color ? { color: { field: color.field, type: color.type, label: ru(color.label) } } : {}),
      tooltip: [],
    },
    options,
  } as unknown as ChartSpec
}

function metricTile(
  id: string,
  metricId: string | undefined,
  x: number,
  y: number,
  w = 2,
  h = 2,
  /** Короткий заголовок вместо имени показателя — для узких плиток экрана. */
  title?: string,
): DashboardTile[] {
  if (!metricId) return []
  return [
    {
      id,
      kind: 'metric',
      metricId,
      filterBindings: {},
      x,
      y,
      w,
      h,
      ...(title ? { title } : {}),
    } as DashboardTile,
  ]
}

function specTile(
  id: string,
  title: string,
  spec: ChartSpec,
  place: { x: number; y: number; w: number; h: number },
  filterBindings: Record<string, string> = {},
): DashboardTile {
  return { id, kind: 'chart', title, spec, filterBindings, ...place } as DashboardTile
}

function mapTile(
  id: string,
  title: string,
  mapId: string,
  place: { x: number; y: number; w: number; h: number },
): DashboardTile {
  return {
    id,
    kind: 'map',
    title,
    mapId,
    map: { camera: null, bindings: {} },
    filterBindings: {},
    ...place,
  } as DashboardTile
}

// ── Запросы ───────────────────────────────────────────────────────────────────

/** Происшествия последних суток с видом словами — соединение со справочником видов. */
function recentIncidents(ids: Ids, days: number, limit: number): QuerySpec {
  return {
    version: 1,
    source: source(ids.get('incidents') as string, 'inc'),
    steps: [
      { type: 'filter', where: recent('inc.occurred_at', days) },
      {
        type: 'join',
        source: source(ids.get('incident_types') as string, 'kinds'),
        on: [{ left: 'inc.type_code', right: 'kinds.code' }],
        kind: 'left',
      },
      { type: 'sort', by: [{ field: 'inc.occurred_at', dir: 'desc' }] },
      { type: 'limit', limit, offset: 0 },
      {
        type: 'select',
        fields: [
          { field: 'inc.occurred_at', alias: 'occurred_at' },
          { field: 'kinds.name', alias: 'kind' },
          { field: 'inc.territory', alias: 'territory' },
          { field: 'inc.injured', alias: 'injured' },
          { field: 'inc.deaths', alias: 'deaths' },
        ],
      },
    ],
  } as unknown as QuerySpec
}

function incidentsByDay(ids: Ids, days: number): QuerySpec {
  return {
    version: 1,
    source: source(ids.get('incidents') as string, 'inc'),
    steps: [
      { type: 'filter', where: recent('inc.occurred_at', days) },
      {
        type: 'join',
        source: source(ids.get('incident_types') as string, 'kinds'),
        on: [{ left: 'inc.type_code', right: 'kinds.code' }],
        kind: 'left',
      },
      {
        type: 'aggregate',
        groupBy: [
          { field: 'inc.occurred_at', bucket: 'day', alias: 'day' },
          { field: 'kinds.group_name', alias: 'kind_group' },
        ],
        measures: [{ alias: 'incidents', agg: 'count' }],
      },
      { type: 'sort', by: [{ field: 'day', dir: 'asc' }] },
    ],
  } as unknown as QuerySpec
}

/** Происшествия по регионам (предок уровня «регион» у района происшествия). */
function incidentsByRegion(ids: Ids, days: number): QuerySpec {
  return {
    version: 1,
    source: source(ids.get('incidents') as string, 'inc'),
    steps: [
      { type: 'filter', where: recent('inc.occurred_at', days) },
      {
        type: 'compute',
        fields: [
          {
            name: 'region',
            expr: "territory_level(inc.territory, 'region')",
            type: 'territory',
          },
        ],
      },
      {
        type: 'aggregate',
        groupBy: [{ field: 'region', alias: 'region' }],
        measures: [
          { alias: 'incidents', agg: 'count' },
          { alias: 'injured', agg: 'sum', field: 'inc.injured' },
        ],
      },
      { type: 'sort', by: [{ field: 'incidents', dir: 'desc' }] },
    ],
  } as unknown as QuerySpec
}

function hazardFeed(ids: Ids, days: number, limit: number): QuerySpec {
  return {
    version: 1,
    source: source(ids.get('hazard_messages') as string, 'msg'),
    steps: [
      { type: 'filter', where: lastDays('msg.occurred_at', days) },
      { type: 'sort', by: [{ field: 'msg.occurred_at', dir: 'desc' }] },
      { type: 'limit', limit, offset: 0 },
      {
        type: 'select',
        fields: [
          { field: 'msg.occurred_at', alias: 'occurred_at' },
          { field: 'msg.hazard', alias: 'hazard' },
          { field: 'msg.magnitude', alias: 'magnitude' },
          { field: 'msg.territory', alias: 'territory' },
          { field: 'msg.status', alias: 'status' },
        ],
      },
    ],
  } as unknown as QuerySpec
}

function dutyToday(ids: Ids): QuerySpec {
  return {
    version: 1,
    source: source(ids.get('duty_roster') as string, 'duty'),
    steps: [
      { type: 'filter', where: { field: 'duty.duty_date', op: 'eq', value: '@today' } },
      {
        type: 'select',
        fields: [
          { field: 'duty.shift_head', alias: 'shift_head' },
          { field: 'duty.duty_officer', alias: 'duty_officer' },
          { field: 'duty.assistant', alias: 'assistant' },
        ],
      },
    ],
  } as unknown as QuerySpec
}

function waterLevels(ids: Ids, days: number): QuerySpec {
  return {
    version: 1,
    source: source(ids.get('water_levels') as string, 'wl'),
    steps: [
      { type: 'filter', where: lastDays('wl.observed_on', days) },
      {
        type: 'aggregate',
        groupBy: [{ field: 'wl.observed_on', bucket: 'day', alias: 'day' }],
        measures: [
          {
            alias: 'above',
            agg: 'count',
            filter: { field: 'wl.above_danger', op: 'is_true' },
          },
          { alias: 'posts', agg: 'count_distinct', field: 'wl.post_code' },
        ],
      },
      { type: 'sort', by: [{ field: 'day', dir: 'asc' }] },
    ],
  } as unknown as QuerySpec
}

function incidentsOfKinds(ids: Ids, kinds: string[], days: number): QuerySpec {
  return {
    version: 1,
    source: source(ids.get('incidents') as string, 'inc'),
    steps: [
      {
        type: 'filter',
        where: {
          and: [
            lastDays('inc.occurred_at', days),
            happened('inc.occurred_at'),
            { field: 'inc.type_code', op: 'in', value: kinds },
          ],
        },
      },
      {
        type: 'aggregate',
        groupBy: [
          { field: 'inc.occurred_at', bucket: 'week', alias: 'week' },
          { field: 'inc.type_code', alias: 'kind' },
        ],
        measures: [{ alias: 'incidents', agg: 'count' }],
      },
      { type: 'sort', by: [{ field: 'week', dir: 'asc' }] },
    ],
  } as unknown as QuerySpec
}

function earthquakes(ids: Ids, days: number, limit: number): QuerySpec {
  return {
    version: 1,
    source: source(ids.get('hazard_messages') as string, 'msg'),
    steps: [
      {
        type: 'filter',
        where: {
          and: [
            lastDays('msg.occurred_at', days),
            { field: 'msg.hazard', op: 'eq', value: 'earthquake' },
          ],
        },
      },
      { type: 'sort', by: [{ field: 'msg.magnitude', dir: 'desc', nulls: 'last' }] },
      { type: 'limit', limit, offset: 0 },
      {
        type: 'select',
        fields: [
          { field: 'msg.occurred_at', alias: 'occurred_at' },
          { field: 'msg.magnitude', alias: 'magnitude' },
          { field: 'msg.depth_km', alias: 'depth_km' },
          { field: 'msg.title', alias: 'title' },
          { field: 'msg.source', alias: 'source' },
        ],
      },
    ],
  } as unknown as QuerySpec
}

function forcesByUnit(ids: Ids): QuerySpec {
  return {
    version: 1,
    source: source(ids.get('forces') as string, 'f'),
    steps: [
      {
        type: 'aggregate',
        groupBy: [{ field: 'f.unit', alias: 'unit' }],
        measures: [
          { alias: 'quantity', agg: 'sum', field: 'f.quantity' },
          { alias: 'ready', agg: 'sum', field: 'f.ready' },
        ],
      },
      { type: 'sort', by: [{ field: 'quantity', dir: 'desc' }] },
    ],
  } as unknown as QuerySpec
}

function sheltersByStatus(ids: Ids): QuerySpec {
  return {
    version: 1,
    source: source(ids.get('shelters') as string, 's'),
    steps: [
      {
        type: 'compute',
        fields: [
          { name: 'region', expr: "territory_level(s.territory, 'region')", type: 'territory' },
        ],
      },
      {
        type: 'aggregate',
        groupBy: [{ field: 'region', alias: 'region' }],
        measures: [
          { alias: 'capacity', agg: 'sum', field: 's.capacity' },
          { alias: 'occupied', agg: 'sum', field: 's.occupied' },
        ],
      },
      { type: 'sort', by: [{ field: 'capacity', dir: 'desc' }] },
    ],
  } as unknown as QuerySpec
}

// ── Дашборды ──────────────────────────────────────────────────────────────────

interface PackDashboard {
  key: string
  name: string
  refreshInterval?: number
  theme?: 'auto' | 'dark'
  filters?: DashboardCreateInput['spec']['filters']
  tiles: DashboardTile[]
}

function packDashboards(ids: Ids, metrics: Ids, mapId: string): PackDashboard[] {
  const m = (key: string) => metrics.get(`metric.${key}`)
  return [
    {
      key: 'dashboard.situation',
      name: 'Ситуационный экран',
      refreshInterval: 60,
      theme: 'dark',
      tiles: [
        ...metricTile('incidents_today', m('incidents_today'), 0, 0, 2, 2, 'Происшествия'),
        ...metricTile('injured_today', m('injured_today'), 2, 0, 2, 2, 'Пострадавшие'),
        ...metricTile('deaths_today', m('deaths_today'), 4, 0, 2, 2, 'Погибшие'),
        ...metricTile('posts_above', m('posts_above_danger'), 6, 0, 2, 2, 'Превышения уровня воды'),
        ...metricTile('messages_new', m('messages_new'), 8, 0, 2, 2, 'Новые сообщения'),
        ...metricTile('shelter_free', m('shelter_free'), 10, 0, 2, 2, 'Свободно в ПВР'),
        mapTile('map', 'Обстановка', mapId, { x: 0, y: 2, w: 8, h: 7 }),
        specTile(
          'incidents',
          'Происшествия за трое суток',
          table(recentIncidents(ids, 3, 12), [
            { field: 'occurred_at', label: 'Время', type: 'temporal' },
            { field: 'kind', label: 'Вид', type: 'nominal' },
            { field: 'territory', label: 'Район', type: 'nominal' },
            { field: 'injured', label: 'Пострад.', type: 'quantitative' },
            { field: 'deaths', label: 'Погибло', type: 'quantitative' },
          ]),
          { x: 8, y: 2, w: 4, h: 4 },
        ),
        specTile(
          'hazards',
          'Опасные явления за неделю',
          table(hazardFeed(ids, 7, 10), [
            { field: 'occurred_at', label: 'Время', type: 'temporal' },
            { field: 'hazard', label: 'Явление', type: 'nominal' },
            { field: 'magnitude', label: 'M', type: 'quantitative' },
            { field: 'territory', label: 'Район', type: 'nominal' },
            { field: 'status', label: 'Решение', type: 'nominal' },
          ]),
          { x: 8, y: 6, w: 4, h: 3 },
        ),
        specTile(
          'by_day',
          'Происшествия за 14 суток',
          chart(
            'bar',
            incidentsByDay(ids, 14),
            { field: 'day', label: 'Сутки', type: 'temporal' },
            [{ field: 'incidents', label: 'Происшествия', type: 'quantitative' }],
            { stacked: true },
            { field: 'kind_group', label: 'Группа', type: 'nominal' },
          ),
          { x: 0, y: 9, w: 6, h: 3 },
        ),
        specTile(
          'duty',
          'Дежурная смена сегодня',
          table(dutyToday(ids), [
            { field: 'shift_head', label: 'Начальник смены', type: 'nominal' },
            { field: 'duty_officer', label: 'Дежурный', type: 'nominal' },
            { field: 'assistant', label: 'Помощник', type: 'nominal' },
          ]),
          { x: 6, y: 9, w: 3, h: 3 },
        ),
        specTile(
          'by_region',
          'За сутки по регионам',
          chart(
            'bar',
            incidentsByRegion(ids, 1),
            { field: 'region', label: 'Регион', type: 'nominal' },
            [{ field: 'incidents', label: 'Происшествия', type: 'quantitative' }],
            { horizontal: true },
          ),
          { x: 9, y: 9, w: 3, h: 3 },
        ),
      ],
    },
    {
      key: 'dashboard.summary',
      name: 'Сводка обстановки',
      filters: [
        {
          id: 'period',
          kind: 'period',
          label: { ru: 'Период', en: 'Period' },
          default: { unit: 'day', from: -6, to: 0 },
        },
        { id: 'territory', kind: 'territory', label: { ru: 'Территория', en: 'Territory' } },
      ],
      tiles: [
        ...metricTile('incidents_month', m('incidents_month'), 0, 0, 3),
        ...metricTile('damage_month', m('damage_month'), 3, 0, 3),
        ...metricTile('deaths_today', m('deaths_today'), 6, 0),
        ...metricTile('injured_today', m('injured_today'), 8, 0),
        ...metricTile('hq_tasks_overdue', m('hq_tasks_overdue'), 10, 0),
        specTile(
          'by_day',
          'Происшествия по суткам',
          chart(
            'bar',
            incidentsByDay(ids, 60),
            { field: 'day', label: 'Сутки', type: 'temporal' },
            [{ field: 'incidents', label: 'Происшествия', type: 'quantitative' }],
            { stacked: true },
            { field: 'kind_group', label: 'Группа', type: 'nominal' },
          ),
          { x: 0, y: 2, w: 8, h: 4 },
          { period: 'inc.occurred_at', territory: 'inc.territory' },
        ),
        specTile(
          'by_region',
          'По регионам',
          chart(
            'bar',
            incidentsByRegion(ids, 60),
            { field: 'region', label: 'Регион', type: 'nominal' },
            [
              { field: 'incidents', label: 'Происшествия', type: 'quantitative' },
              { field: 'injured', label: 'Пострадавшие', type: 'quantitative' },
            ],
            { horizontal: true },
          ),
          { x: 8, y: 2, w: 4, h: 4 },
          { period: 'inc.occurred_at', territory: 'inc.territory' },
        ),
        specTile(
          'list',
          'Происшествия',
          table(recentIncidents(ids, 60, 200), [
            { field: 'occurred_at', label: 'Время', type: 'temporal' },
            { field: 'kind', label: 'Вид', type: 'nominal' },
            { field: 'territory', label: 'Район', type: 'nominal' },
            { field: 'injured', label: 'Пострадавшие', type: 'quantitative' },
            { field: 'deaths', label: 'Погибшие', type: 'quantitative' },
          ]),
          { x: 0, y: 6, w: 12, h: 5 },
          { period: 'inc.occurred_at', territory: 'inc.territory' },
        ),
      ],
    },
    {
      key: 'dashboard.flood',
      name: 'Паводки и сели',
      tiles: [
        ...metricTile('posts_above', m('posts_above_danger'), 0, 0, 3),
        ...metricTile('shelter_occupied', m('shelter_occupied'), 3, 0, 3),
        ...metricTile('shelter_free', m('shelter_free'), 6, 0, 3),
        ...metricTile('incidents_today', m('incidents_today'), 9, 0, 3),
        specTile(
          'levels',
          'Гидропосты выше опасного уровня по суткам',
          chart('line', waterLevels(ids, 60), { field: 'day', label: 'Сутки', type: 'temporal' }, [
            { field: 'above', label: 'Постов выше опасного уровня', type: 'quantitative' },
          ]),
          { x: 0, y: 2, w: 6, h: 4 },
        ),
        specTile(
          'kinds',
          'Паводки, сели, оползни по неделям',
          chart(
            'bar',
            incidentsOfKinds(ids, ['FLOOD', 'MUDFLOW', 'LANDSLIDE', 'DAM'], 180),
            { field: 'week', label: 'Неделя', type: 'temporal' },
            [{ field: 'incidents', label: 'Происшествия', type: 'quantitative' }],
            { stacked: true },
            { field: 'kind', label: 'Вид', type: 'nominal' },
          ),
          { x: 6, y: 2, w: 6, h: 4 },
        ),
        mapTile('map', 'Обстановка', mapId, { x: 0, y: 6, w: 12, h: 6 }),
      ],
    },
    {
      key: 'dashboard.seismic',
      name: 'Сейсмическая обстановка',
      tiles: [
        ...metricTile('messages_new', m('messages_new'), 0, 0, 4),
        ...metricTile('incidents_month', m('incidents_month'), 4, 0, 4),
        ...metricTile('shelter_free', m('shelter_free'), 8, 0, 4),
        specTile(
          'quakes',
          'Землетрясения за 30 суток',
          table(earthquakes(ids, 30, 50), [
            { field: 'occurred_at', label: 'Время', type: 'temporal' },
            { field: 'magnitude', label: 'Магнитуда', type: 'quantitative' },
            { field: 'depth_km', label: 'Глубина, км', type: 'quantitative' },
            { field: 'title', label: 'Сообщение', type: 'nominal' },
            { field: 'source', label: 'Источник', type: 'nominal' },
          ]),
          { x: 0, y: 2, w: 6, h: 6 },
        ),
        mapTile('map', 'Эпицентры и зоны риска', mapId, { x: 6, y: 2, w: 6, h: 6 }),
      ],
    },
    {
      key: 'dashboard.forces',
      name: 'Готовность сил и средств',
      tiles: [
        ...metricTile('forces_ready', m('forces_ready'), 0, 0, 4),
        ...metricTile('shelter_free', m('shelter_free'), 4, 0, 4),
        ...metricTile('shelter_occupied', m('shelter_occupied'), 8, 0, 4),
        specTile(
          'units',
          'Силы и средства по подразделениям',
          chart(
            'bar',
            forcesByUnit(ids),
            { field: 'unit', label: 'Подразделение', type: 'nominal' },
            [
              { field: 'quantity', label: 'По штату', type: 'quantitative' },
              { field: 'ready', label: 'В готовности', type: 'quantitative' },
            ],
            { horizontal: true },
          ),
          { x: 0, y: 2, w: 6, h: 5 },
        ),
        specTile(
          'shelters',
          'ПВР по регионам',
          chart(
            'bar',
            sheltersByStatus(ids),
            { field: 'region', label: 'Регион', type: 'nominal' },
            [
              { field: 'capacity', label: 'Вместимость', type: 'quantitative' },
              { field: 'occupied', label: 'Размещено', type: 'quantitative' },
            ],
            { horizontal: true },
          ),
          { x: 6, y: 2, w: 6, h: 5 },
        ),
      ],
    },
  ]
}

export async function ensureDashboards(
  pack: PackContext,
  datasets: Ids,
  mapId: string,
): Promise<{ metrics: Map<string, string>; dashboards: Map<string, string> }> {
  const metrics = await ensureMetrics(pack, datasets)
  const dashboards = new Map<string, string>()
  const created: string[] = []
  for (const dashboard of packDashboards(datasets, metrics, mapId)) {
    const found = await findPackObject('dashboard', dashboard.key)
    if (found) {
      dashboards.set(dashboard.key, found)
      continue
    }
    const id = await db().transaction((tx) =>
      Dashboards.create(
        tx,
        pack.ctx,
        DashboardCreateInput.parse({
          name: dashboard.name,
          spaceId: pack.spaceId,
          spec: {
            tiles: dashboard.tiles,
            filters: dashboard.filters ?? [],
            refreshInterval: dashboard.refreshInterval ?? null,
            theme: dashboard.theme ?? 'auto',
          },
        }),
        { systemKey: packKey(dashboard.key) },
      ),
    )
    dashboards.set(dashboard.key, id)
    created.push(dashboard.key)
  }
  pack.log('показатели и дашборды пакета ЧС готовы', {
    metrics: metrics.size,
    dashboards: created,
  })
  return { metrics, dashboards }
}
