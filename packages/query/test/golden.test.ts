import type { FilterNode, QuerySpec } from '@kchs/contracts'
import { describe, expect, it } from 'vitest'
import { type CompileContext, compileQuery } from '../src/index.js'
import {
  archive,
  ctx,
  dataset,
  IDS,
  incidents,
  q,
  regions,
  render,
  SUB_1,
  src,
  staff,
  TERR_DU,
  TERR_KH,
  UNIT_A,
  USER_ID,
  withDatasets,
} from './fixtures.js'

/**
 * Эталоны «спецификация → SQL + параметры» (снимки в __snapshots__). Любое
 * изменение SQL видно в ревью снимка; семантика SQL проверяется выполнением
 * на Postgres (execute.test.ts).
 */
type Case = [name: string, spec: QuerySpec, overrides?: Partial<CompileContext>]

function golden(cases: Case[]) {
  it.each(cases)('%s', (_name, spec, overrides) => {
    const compiled = compileQuery(spec, ctx(overrides))
    expect(render(compiled)).toMatchSnapshot()
    // Каждый параметр упомянут в тексте, лишних номеров нет (иначе Postgres отвергнет запрос)
    expect(placeholders(compiled.sql)).toEqual(range(compiled.params.length))
    expect(placeholders(compiled.countSql)).toEqual(range(compiled.countParams.length))
    // Строки пользователя не попадают в текст SQL
    for (const value of compiled.params) {
      if (typeof value === 'string' && value.length >= 5) expect(compiled.sql).not.toContain(value)
    }
  })
}

function placeholders(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort(
    (a, b) => a - b,
  )
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, index) => index + 1)
}

const regionsSource = { kind: 'dataset', id: IDS.regions, alias: 'reg' } as const
const archiveSource = { kind: 'dataset', id: IDS.archive, alias: 'arc' } as const
const tasks = dataset('99999999-9999-4999-8999-999999999999', 'ds.v_tasks', [
  ['title', 'text'],
  ['status', 'select'],
  ['assignee_id', 'user'],
  ['due_at', 'datetime'],
])
const polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [68.7, 38.5],
      [68.9, 38.5],
      [68.9, 38.6],
      [68.7, 38.5],
    ],
  ],
}

const savedTotals = q(src('inc'), [
  { type: 'aggregate', groupBy: [{ field: 'kind' }], measures: [{ alias: 'total', agg: 'count' }] },
])
const savedNested = q({ kind: 'query', id: IDS.savedTotals, alias: 't' }, [
  { type: 'filter', where: { field: 'total', op: 'gt', value: 1 } },
])
const savedArchiveAt = q(archiveSource, [
  { type: 'select', fields: [{ field: 'occurred_at', alias: 'at' }, 'title'] },
])
const queries: Partial<CompileContext> = {
  queries: new Map([
    [IDS.savedTotals, savedTotals],
    [IDS.savedNested, savedNested],
    [IDS.savedArchiveAt, savedArchiveAt],
  ]),
}

describe('источники', () => {
  golden([
    ['датасет без алиаса', q(src())],
    ['датасет с алиасом', q(src('inc'))],
    ['режим таблицы: _id и _ver', q(src()), { rowMeta: true }],
    ['без предела строк', q(src()), { maxRows: null }],
    ['предел 100 строк', q(src()), { maxRows: 100 }],
    [
      'системный датасет',
      q({ kind: 'system', name: 'tasks', alias: 'tk' }),
      { systemDatasets: new Map([['tasks', { ...tasks, systemColumns: false }]]) },
    ],
    [
      'встроенные строки',
      q({
        kind: 'inline',
        alias: 'plan',
        rows: [
          { kind: 'fire', target: 10, active: true },
          { kind: 'flood', target: 2.5, active: false },
        ],
      }),
    ],
    [
      'встроенные строки: пустые значения, список, объект',
      q({
        kind: 'inline',
        rows: [
          { code: 'a', tags: ['x', 'y'], extra: { level: 1 } },
          { code: null, note: 'только во второй строке' },
        ],
      }),
    ],
    ['сохранённый запрос', q({ kind: 'query', id: IDS.savedTotals, alias: 't' }), queries],
    ['вложенный сохранённый запрос', q({ kind: 'query', id: IDS.savedNested }), queries],
    [
      'датасет без системных столбцов',
      q(src()),
      withDatasets({ ...incidents, systemColumns: false }),
    ],
  ])
})

describe('политики', () => {
  golden([
    ['строки: ничего', q(src()), withDatasets({ ...incidents, rowPolicy: { kind: 'none' } })],
    [
      'строки: исполнитель — я',
      q(src()),
      withDatasets({
        ...incidents,
        rowPolicy: { kind: 'filter', where: { field: 'assignee', op: 'eq', value: '@me' } },
      }),
    ],
    [
      'строки: мои территории с дочерними',
      q(src()),
      withDatasets({
        ...incidents,
        rowPolicy: {
          kind: 'filter',
          where: { field: 'territory_id', op: 'within', value: '@my_territories' },
        },
      }),
    ],
    [
      'строки: объединение политик через OR',
      q(src()),
      withDatasets({
        ...incidents,
        rowPolicy: {
          kind: 'filter',
          where: {
            or: [
              { field: 'unit_id', op: 'in', value: '@my_units' },
              { field: '_created_by', op: 'is_me' },
            ],
          },
        },
      }),
    ],
    [
      'строки: выражение',
      q(src()),
      withDatasets({
        ...incidents,
        rowPolicy: { kind: 'expr', expr: 'territory_id in (@my_territories) or victims > 10' },
      }),
    ],
    [
      'строки: выражение с атрибутом пользователя',
      q(src()),
      withDatasets({
        ...incidents,
        rowPolicy: { kind: 'expr', expr: "kind in (user_attr('territory_codes'))" },
      }),
    ],
    [
      'столбцы: скрытые не выбираются',
      q(src()),
      withDatasets({ ...incidents, columnPolicy: { hide: ['damage', 'phone', 'geom'], mask: [] } }),
    ],
    [
      'столбцы: маски сотрудников',
      q({ kind: 'dataset', id: IDS.staff }),
      withDatasets({
        ...staff,
        columnPolicy: {
          hide: [],
          mask: ['name', 'salary', 'phone', 'email', 'hired_on', 'unit_id', 'passport'],
        },
      }),
    ],
    [
      'столбцы: маски остальных типов',
      q(src()),
      withDatasets({
        ...incidents,
        columnPolicy: {
          hide: [],
          mask: [
            'victims',
            'occurred_at',
            'geom',
            'tags',
            'is_confirmed',
            'meta',
            'start_time',
            'response',
            'ratio',
            'share',
            'notes',
          ],
        },
      }),
    ],
    [
      'политика источника соединения',
      q(src('inc'), [
        {
          type: 'join',
          source: regionsSource,
          on: [{ left: 'inc.territory_id', right: 'reg.territory_id' }],
          kind: 'inner',
        },
      ]),
      withDatasets({
        ...regions,
        rowPolicy: { kind: 'filter', where: { field: 'territory_id', op: 'eq', value: TERR_DU } },
        columnPolicy: { hide: ['population'], mask: [] },
      }),
    ],
    [
      'политика источника объединения',
      q(src('inc'), [
        { type: 'select', fields: ['title', 'kind', 'damage'] },
        { type: 'union', source: archiveSource, mode: 'all' },
      ]),
      withDatasets({ ...archive, rowPolicy: { kind: 'none' } }),
    ],
    [
      'политика по скрытому полю',
      q(src()),
      withDatasets({
        ...incidents,
        rowPolicy: { kind: 'filter', where: { field: 'damage', op: 'lt', value: 1000000 } },
        columnPolicy: { hide: ['damage'], mask: [] },
      }),
    ],
  ])
})

const filter = (where: FilterNode) => q(src(), [{ type: 'filter', where }])

describe('фильтры', () => {
  golden([
    ['текст: равно', filter({ field: 'title', op: 'eq', value: 'Пожар' })],
    ['текст: не равно', filter({ field: 'title', op: 'neq', value: 'Пожар' })],
    [
      'текст: содержит со спецсимволами',
      filter({ field: 'title', op: 'contains', value: '50%_\\' }),
    ],
    ['текст: не содержит', filter({ field: 'title', op: 'not_contains', value: 'учения' })],
    ['текст: начинается', filter({ field: 'code', op: 'starts_with', value: 'DU-' })],
    ['текст: заканчивается', filter({ field: 'email', op: 'ends_with', value: '@gov.tj' })],
    [
      'текст: регулярное выражение',
      filter({ field: 'code', op: 'regex', value: '^[A-Z]{2}-\\d+$' }),
    ],
    ['текст: пусто', filter({ field: 'notes', op: 'is_empty' })],
    ['текст: не пусто', filter({ field: 'notes', op: 'not_empty' })],
    ['выбор: в списке', filter({ field: 'kind', op: 'in', value: ['fire', 'flood'] })],
    ['выбор: не в списке с пустым', filter({ field: 'kind', op: 'not_in', value: ['fire', null] })],
    ['выбор: в пустом списке', filter({ field: 'kind', op: 'in', value: [] })],
    [
      'число: между с открытым концом',
      filter({ field: 'damage', op: 'between', value: [10, null] }),
    ],
    [
      'число: между объектом',
      filter({ field: 'victims', op: 'between', value: { from: 1, to: 5 } }),
    ],
    [
      'число: сравнения',
      filter({
        and: [
          { field: 'victims', op: 'gt', value: 0 },
          { field: 'victims', op: 'lte', value: 10 },
          { field: 'ratio', op: 'gte', value: '0.5' },
          { field: 'share', op: 'lt', value: 1 },
        ],
      }),
    ],
    ['целое: дробное значение', filter({ field: 'victims', op: 'eq', value: 2.5 })],
    ['целое: в списке', filter({ field: 'victims', op: 'in', value: [1, 2, 3] })],
    [
      'дата: равно, до, после',
      filter({
        and: [
          { field: 'reported_on', op: 'eq', value: '2026-09-01' },
          { field: 'reported_on', op: 'before', value: '2026-10-01' },
          { field: 'reported_on', op: 'after', value: '2026-01-01' },
        ],
      }),
    ],
    [
      'дата: между',
      filter({ field: 'reported_on', op: 'between', value: ['2026-01-01', '2026-03-31'] }),
    ],
    [
      'дата: прошлая неделя',
      filter({ field: 'reported_on', op: 'relative', value: { unit: 'week', from: -1, to: -1 } }),
    ],
    [
      'дата: макрос @today и момент @now',
      filter({
        and: [
          { field: 'reported_on', op: 'lte', value: '@today' },
          { field: 'reported_on', op: 'lt', value: '@now' },
        ],
      }),
    ],
    ['дата и время: равно дню', filter({ field: 'occurred_at', op: 'eq', value: '2026-09-01' })],
    [
      'дата и время: до дня, после момента',
      filter({
        and: [
          { field: 'occurred_at', op: 'before', value: '2026-09-01' },
          { field: 'occurred_at', op: 'after', value: '2026-01-01T08:00:00Z' },
          { field: 'occurred_at', op: 'gte', value: '2026-01-01T08:00' },
        ],
      }),
    ],
    [
      'дата и время: между днями',
      filter({ field: 'occurred_at', op: 'between', value: ['2026-09-01', '2026-09-30'] }),
    ],
    [
      'дата и время: текущий год',
      filter({ field: 'occurred_at', op: 'relative', value: { unit: 'year', from: 0, to: 0 } }),
    ],
    [
      'дата и время: не равно дню, не больше дня',
      filter({
        or: [
          { field: 'occurred_at', op: 'neq', value: '2026-09-01' },
          { field: 'occurred_at', op: 'lte', value: '2026-09-01' },
        ],
      }),
    ],
    [
      'логическое',
      filter({
        or: [
          { field: 'is_confirmed', op: 'is_true' },
          { field: 'is_confirmed', op: 'is_false' },
          { field: 'is_confirmed', op: 'eq', value: 'true' },
        ],
      }),
    ],
    [
      'пользователь: я, подчинённые',
      filter({
        or: [
          { field: 'assignee', op: 'is_me' },
          { field: 'assignee', op: 'eq', value: '@me' },
          { field: 'assignee', op: 'is_my_subordinate' },
        ],
      }),
    ],
    ['подразделение: моё', filter({ field: 'unit_id', op: 'in_my_unit' })],
    ['пользователь: из моего подразделения', filter({ field: 'assignee', op: 'in_my_unit' })],
    [
      'территория: с дочерними',
      filter({
        field: 'territory_id',
        op: 'within',
        value: { id: TERR_DU, includeChildren: true },
      }),
    ],
    [
      'территория: без дочерних и список',
      filter({
        or: [
          { field: 'territory_id', op: 'within', value: { id: TERR_DU, includeChildren: false } },
          { field: 'territory_id', op: 'in', value: [TERR_KH] },
          { field: 'territory_id', op: 'eq', value: TERR_KH },
        ],
      }),
    ],
    ['территория: мои', filter({ field: 'territory_id', op: 'within', value: '@my_territories' })],
    ['геометрия: внутри полигона', filter({ field: 'geom', op: 'within', value: polygon })],
    [
      'геометрия: пересекает объект Feature',
      filter({ field: 'geom', op: 'intersects', value: { type: 'Feature', geometry: polygon } }),
    ],
    [
      'геометрия: в радиусе от точки',
      filter({ field: 'geom', op: 'dwithin', value: { lon: 68.78, lat: 38.56, distance: 500 } }),
    ],
    [
      'геометрия: пусто',
      filter({
        or: [
          { field: 'geom', op: 'is_empty' },
          { field: 'geom', op: 'not_empty' },
        ],
      }),
    ],
    [
      'список: пересечение и исключение',
      filter({
        and: [
          { field: 'tags', op: 'in', value: ['urgent', 'night'] },
          { field: 'tags', op: 'not_in', value: ['test'] },
        ],
      }),
    ],
    [
      'список: содержит элемент',
      filter({
        and: [
          { field: 'tags', op: 'contains', value: 'urgent' },
          { field: 'tags', op: 'eq', value: 'night' },
          { field: 'tags', op: 'not_contains', value: 'test' },
        ],
      }),
    ],
    [
      'список: пусто',
      filter({
        or: [
          { field: 'tags', op: 'is_empty' },
          { field: 'tags', op: 'not_empty' },
        ],
      }),
    ],
    ['время: между', filter({ field: 'start_time', op: 'between', value: ['08:00', '18:30'] })],
    ['JSON: равно', filter({ field: 'meta', op: 'eq', value: { level: 2 } })],
    ['длительность в минутах', filter({ field: 'response', op: 'gt', value: 90 })],
    ['отрицание', filter({ not: { field: 'kind', op: 'eq', value: 'fire' } })],
    [
      'вложенные группы',
      filter({
        and: [
          {
            or: [
              { field: 'kind', op: 'eq', value: 'fire' },
              { field: 'victims', op: 'gt', value: 0 },
            ],
          },
          { not: { field: 'title', op: 'contains', value: 'учения' } },
        ],
      }),
    ],
    ['пусто: явное null', filter({ field: 'kind', op: 'eq', value: null })],
    [
      'системные поля',
      filter({
        and: [
          { field: '_created_at', op: 'relative', value: { unit: 'day', from: -7, to: 0 } },
          { field: '_created_by', op: 'is_me' },
          { field: '_id', op: 'gt', value: 100 },
        ],
      }),
    ],
  ])
})

describe('параметры фильтров', () => {
  const params = {
    kind: { type: 'text' as const },
    kinds: { type: 'list' as const },
    since: { type: 'date' as const, default: '@today' },
    period: { type: 'text' as const },
    min: { type: 'number' as const },
    max: { type: 'number' as const },
  }
  golden([
    [
      'необязательный параметр не задан — условие снимается',
      q(
        src(),
        [{ type: 'filter', where: { field: 'kind', op: 'eq', value: '@param:kind' } }],
        params,
      ),
    ],
    [
      'параметр задан',
      q(
        src(),
        [{ type: 'filter', where: { field: 'kind', op: 'eq', value: '@param:kind' } }],
        params,
      ),
      { params: { kind: 'fire' } },
    ],
    [
      'параметр по умолчанию — макрос',
      q(
        src(),
        [{ type: 'filter', where: { field: 'reported_on', op: 'gte', value: '@param:since' } }],
        params,
      ),
    ],
    [
      'параметр-список',
      q(
        src(),
        [{ type: 'filter', where: { field: 'kind', op: 'in', value: '@param:kinds' } }],
        params,
      ),
      { params: { kinds: ['fire', 'flood'] } },
    ],
    [
      'параметр — относительный период',
      q(
        src(),
        [
          {
            type: 'filter',
            where: { field: 'occurred_at', op: 'relative', value: '@param:period' },
          },
        ],
        params,
      ),
      { params: { period: { unit: 'month', from: -2, to: 0 } } },
    ],
    [
      'между: задан один конец',
      q(
        src(),
        [
          {
            type: 'filter',
            where: { field: 'damage', op: 'between', value: ['@param:min', '@param:max'] },
          },
        ],
        params,
      ),
      { params: { max: 5000 } },
    ],
    [
      'группа из незаданных параметров снимается целиком',
      q(
        src(),
        [
          {
            type: 'filter',
            where: {
              or: [
                { field: 'kind', op: 'eq', value: '@param:kind' },
                { field: 'victims', op: 'gt', value: 0 },
              ],
            },
          },
        ],
        params,
      ),
    ],
    [
      '@my_unit без подразделения в списке',
      filter({ field: 'unit_id', op: 'in', value: ['@my_unit'] }),
      {
        user: {
          id: USER_ID,
          unitIds: [],
          territoryIds: [],
          subordinateIds: [],
          attributes: {},
        },
      },
    ],
    [
      '@my_unit без подразделения',
      filter({ field: 'unit_id', op: 'eq', value: '@my_unit' }),
      {
        user: {
          id: USER_ID,
          unitIds: [],
          territoryIds: [],
          subordinateIds: [],
          attributes: {},
        },
      },
    ],
  ])
})

describe('вычисления', () => {
  golden([
    [
      'вычисляемое поле',
      q(src(), [{ type: 'compute', fields: [{ name: 'k', expr: 'damage / 1000' }] }]),
    ],
    [
      'цепочка вычислений в одном шаге',
      q(src(), [
        {
          type: 'compute',
          fields: [
            { name: 'per_victim', expr: 'safe_div(damage, victims)' },
            { name: 'label', expr: "kind || ': ' || round(per_victim, 1)" },
          ],
        },
      ]),
    ],
    [
      'объявленный тип integer',
      q(src(), [
        { type: 'compute', fields: [{ name: 'k', expr: 'damage / 1000', type: 'integer' }] },
      ]),
    ],
    [
      'объявленный тип money',
      q(src(), [
        { type: 'compute', fields: [{ name: 'fine', expr: 'victims * 150.5', type: 'money' }] },
      ]),
    ],
    [
      'пустое значение с объявленным типом',
      q(src(), [{ type: 'compute', fields: [{ name: 'due', expr: 'null', type: 'date' }] }]),
    ],
    [
      'параметр в выражении',
      q(src(), [{ type: 'compute', fields: [{ name: 'over', expr: 'damage > @param:limit' }] }], {
        limit: { type: 'number', default: 1000 },
      }),
    ],
    [
      'вычисление после соединения',
      q(src('inc'), [
        {
          type: 'join',
          source: regionsSource,
          on: [{ left: 'inc.territory_id', right: 'reg.territory_id' }],
          kind: 'left',
        },
        {
          type: 'compute',
          fields: [{ name: 'per_100k', expr: 'victims / reg.population * 100000' }],
        },
      ]),
    ],
    [
      'фильтр по вычисленному полю',
      q(src(), [
        {
          type: 'compute',
          fields: [{ name: 'age_days', expr: "date_diff(reported_on, today(), 'day')" }],
        },
        { type: 'filter', where: { field: 'age_days', op: 'lte', value: 30 } },
      ]),
    ],
  ])
})

describe('сводка', () => {
  golden([
    [
      'только количество',
      q(src(), [{ type: 'aggregate', groupBy: [], measures: [{ alias: 'n', agg: 'count' }] }]),
    ],
    [
      'только группировка',
      q(src(), [{ type: 'aggregate', groupBy: [{ field: 'kind' }], measures: [] }]),
    ],
    [
      'интервалы дат',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [
            { field: 'occurred_at', bucket: 'year' },
            { field: 'occurred_at', bucket: 'quarter' },
            { field: 'occurred_at', bucket: 'week' },
            { field: 'occurred_at', bucket: 'day' },
            { field: 'occurred_at', bucket: 'hour' },
            { field: 'reported_on', bucket: 'month', alias: 'month' },
          ],
          measures: [{ alias: 'n', agg: 'count' }],
        },
      ]),
    ],
    [
      'все виды мер',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind', alias: 'k' }],
          measures: [
            { alias: 'n', agg: 'count' },
            { alias: 'n_titles', agg: 'count', field: 'title' },
            { alias: 'units', agg: 'count_distinct', field: 'unit_id' },
            { alias: 'total', agg: 'sum', field: 'damage' },
            { alias: 'mean', agg: 'avg', field: 'victims' },
            { alias: 'first_day', agg: 'min', field: 'reported_on' },
            { alias: 'last_day', agg: 'max', field: 'reported_on' },
            { alias: 'med', agg: 'median', field: 'damage' },
            { alias: 'p90', agg: 'p90', field: 'damage' },
            { alias: 'p95', agg: 'p95', field: 'response' },
            { alias: 'titles', agg: 'string_agg', field: 'title' },
          ],
        },
      ]),
    ],
    [
      'первое и последнее по порядку добавления',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind' }],
          measures: [
            { alias: 'first_title', agg: 'first', field: 'title' },
            { alias: 'last_title', agg: 'last', field: 'title' },
          ],
        },
      ]),
    ],
    [
      'первое и последнее по сортировке',
      q(src(), [
        { type: 'sort', by: [{ field: 'occurred_at', dir: 'desc', nulls: 'last' }] },
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind' }],
          measures: [
            { alias: 'latest', agg: 'first', field: 'title' },
            { alias: 'earliest', agg: 'last', field: 'title' },
          ],
        },
      ]),
    ],
    [
      'мера-выражение',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind' }],
          measures: [
            { alias: 'avg_damage', agg: 'expr', expr: 'round(sum(damage) / count(), 2)' },
            { alias: 'label', agg: 'expr', expr: "kind || ' (' || count() || ')'" },
          ],
        },
      ]),
    ],
    [
      'условные меры',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'territory_id' }],
          measures: [
            { alias: 'fires', agg: 'count', filter: { field: 'kind', op: 'eq', value: 'fire' } },
            {
              alias: 'fire_damage',
              agg: 'sum',
              field: 'damage',
              filter: { field: 'kind', op: 'eq', value: 'fire' },
            },
            {
              alias: 'fire_share',
              agg: 'expr',
              expr: 'count() / 1.0',
              filter: { field: 'kind', op: 'in', value: ['fire'] },
            },
            {
              alias: 'last_fire',
              agg: 'last',
              field: 'occurred_at',
              filter: { field: 'kind', op: 'eq', value: 'fire' },
            },
          ],
        },
      ]),
    ],
    [
      'мера по выражению-аргументу',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [],
          measures: [{ alias: 'total', agg: 'sum', expr: 'damage * victims' }],
        },
      ]),
    ],
    [
      'сводка после соединения',
      q(src('inc'), [
        {
          type: 'join',
          source: regionsSource,
          on: [{ left: 'inc.territory_id', right: 'reg.territory_id' }],
          kind: 'left',
        },
        {
          type: 'aggregate',
          groupBy: [{ field: 'reg.name', alias: 'region' }],
          measures: [
            { alias: 'incidents', agg: 'count' },
            { alias: 'per_100k', agg: 'expr', expr: 'count() / max(reg.population) * 100000' },
          ],
        },
      ]),
    ],
    [
      'фильтр по мере',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
        { type: 'filter', where: { field: 'n', op: 'gte', value: 5 } },
      ]),
    ],
    [
      'сводка, сортировка, лимит',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
        { type: 'sort', by: [{ field: 'n', dir: 'desc' }] },
        { type: 'limit', limit: 10, offset: 0 },
      ]),
    ],
    [
      'режим таблицы после сводки — без _id',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
      ]),
      { rowMeta: true },
    ],
  ])
})

describe('окно', () => {
  golden([
    [
      'lag и lead',
      q(src(), [
        {
          type: 'window',
          fields: [
            {
              alias: 'prev',
              fn: 'lag',
              field: 'damage',
              partitionBy: ['kind'],
              orderBy: ['occurred_at'],
            },
            {
              alias: 'next2',
              fn: 'lead',
              field: 'damage',
              partitionBy: [],
              orderBy: ['occurred_at'],
              n: 2,
            },
          ],
        },
      ]),
    ],
    [
      'нарастающий итог',
      q(src(), [
        {
          type: 'window',
          fields: [
            {
              alias: 'cum',
              fn: 'running_sum',
              field: 'damage',
              partitionBy: ['kind'],
              orderBy: ['reported_on'],
            },
          ],
        },
      ]),
    ],
    [
      'скользящее среднее',
      q(src(), [
        {
          type: 'window',
          fields: [
            {
              alias: 'ma',
              fn: 'moving_avg',
              field: 'victims',
              partitionBy: [],
              orderBy: ['reported_on'],
              n: 7,
            },
          ],
        },
      ]),
    ],
    [
      'ранги и номер строки',
      q(src(), [
        {
          type: 'window',
          fields: [
            { alias: 'r', fn: 'rank', partitionBy: ['kind'], orderBy: ['damage desc'] },
            { alias: 'dr', fn: 'dense_rank', partitionBy: [], orderBy: ['damage DESC', 'title'] },
            { alias: 'rn', fn: 'row_number', partitionBy: [], orderBy: [] },
          ],
        },
      ]),
    ],
    [
      'окно после сводки',
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'reported_on', bucket: 'month', alias: 'month' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
        {
          type: 'window',
          fields: [
            { alias: 'prev', fn: 'lag', field: 'n', partitionBy: [], orderBy: ['month'] },
            { alias: 'cum', fn: 'running_sum', field: 'n', partitionBy: [], orderBy: ['month'] },
          ],
        },
      ]),
    ],
  ])
})

describe('сортировка, лимит, выбор полей', () => {
  golden([
    [
      'сортировка по нескольким полям',
      q(src(), [
        {
          type: 'sort',
          by: [
            { field: 'kind', dir: 'asc' },
            { field: 'damage', dir: 'desc', nulls: 'last' },
            { field: 'reported_on', dir: 'asc', nulls: 'first' },
          ],
        },
      ]),
    ],
    [
      'лимит со смещением после сортировки',
      q(src(), [
        { type: 'sort', by: [{ field: 'damage', dir: 'desc' }] },
        { type: 'limit', limit: 20, offset: 40 },
      ]),
    ],
    ['лимит без сортировки', q(src(), [{ type: 'limit', limit: 5, offset: 0 }])],
    [
      'выбор и переименование',
      q(src(), [{ type: 'select', fields: ['title', { field: 'damage', alias: 'loss_amount' }] }]),
    ],
    [
      'выбор после сортировки сохраняет порядок',
      q(src(), [
        { type: 'sort', by: [{ field: 'damage', dir: 'desc' }] },
        { type: 'select', fields: ['title', 'kind'] },
      ]),
    ],
    [
      'выбор в режиме таблицы сохраняет _id и _ver',
      q(src(), [{ type: 'select', fields: ['title'] }]),
      { rowMeta: true },
    ],
    [
      'явный выбор _id',
      q(src(), [{ type: 'select', fields: ['_id', 'title'] }]),
      { rowMeta: true },
    ],
    [
      'сортировка по новому имени',
      q(src(), [
        { type: 'select', fields: [{ field: 'damage', alias: 'loss' }, 'kind'] },
        { type: 'sort', by: [{ field: 'loss', dir: 'desc' }] },
      ]),
    ],
  ])
})

describe('соединения и объединения', () => {
  const on = [{ left: 'inc.territory_id', right: 'reg.territory_id' }]
  golden([
    [
      'внутреннее соединение',
      q(src('inc'), [{ type: 'join', source: regionsSource, on, kind: 'inner' }]),
    ],
    [
      'левое соединение',
      q(src('inc'), [{ type: 'join', source: regionsSource, on, kind: 'left' }]),
    ],
    [
      'правое соединение',
      q(src('inc'), [{ type: 'join', source: regionsSource, on, kind: 'right' }]),
    ],
    [
      'полное соединение',
      q(src('inc'), [{ type: 'join', source: regionsSource, on, kind: 'full' }]),
    ],
    [
      'одинаковые имена после соединения',
      q(src('inc'), [
        {
          type: 'join',
          source: archiveSource,
          on: [{ left: 'inc.title', right: 'arc.title' }],
          kind: 'left',
        },
      ]),
    ],
    [
      'соединение даты с датой и временем',
      q(src('inc'), [
        {
          type: 'join',
          source: archiveSource,
          on: [{ left: 'inc.reported_on', right: 'arc.occurred_at' }],
          kind: 'inner',
        },
        { type: 'select', fields: ['inc.title', { field: 'arc.title', alias: 'archived' }] },
      ]),
    ],
    [
      'соединение с сохранённым запросом',
      q(src('inc'), [
        {
          type: 'join',
          source: { kind: 'query', id: IDS.savedTotals, alias: 'tot' },
          on: [{ left: 'inc.kind', right: 'tot.kind' }],
          kind: 'left',
        },
        { type: 'select', fields: ['inc.title', 'tot.total'] },
      ]),
      queries,
    ],
    [
      'соединение со встроенными строками',
      q(src('inc'), [
        {
          type: 'join',
          source: {
            kind: 'inline',
            alias: 'lbl',
            rows: [
              { kind: 'fire', label: 'Пожар' },
              { kind: 'flood', label: 'Паводок' },
            ],
          },
          on: [{ left: 'inc.kind', right: 'lbl.kind' }],
          kind: 'left',
        },
      ]),
    ],
    [
      'объединение всех строк',
      q(src(), [
        { type: 'select', fields: ['title', 'kind', 'damage', 'occurred_at'] },
        { type: 'union', source: archiveSource, mode: 'all' },
      ]),
    ],
    [
      'объединение без повторов с недостающими полями',
      q(src(), [
        { type: 'select', fields: ['title', 'victims'] },
        { type: 'union', source: archiveSource, mode: 'distinct' },
      ]),
    ],
    [
      'объединение даты с датой и временем',
      q(src(), [
        { type: 'select', fields: [{ field: 'reported_on', alias: 'at' }, 'title'] },
        {
          type: 'union',
          source: { kind: 'query', id: IDS.savedArchiveAt, alias: 'x' },
          mode: 'all',
        },
      ]),
      queries,
    ],
    [
      'объединение и сводка',
      q(src(), [
        { type: 'select', fields: ['kind', 'damage'] },
        { type: 'union', source: archiveSource, mode: 'all' },
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind' }],
          measures: [{ alias: 'total', agg: 'sum', field: 'damage' }],
        },
      ]),
    ],
  ])
})

describe('выборка, развёртка, геометрия, настройки', () => {
  golden([
    ['выборка n строк', q(src(), [{ type: 'sample', n: 100 }])],
    ['выборка доли', q(src(), [{ type: 'sample', fraction: 0.1 }])],
    [
      'развёртка списка и подсчёт по меткам',
      q(src(), [
        { type: 'unnest', field: 'tags' },
        {
          type: 'aggregate',
          groupBy: [{ field: 'tags', alias: 'tag' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
      ]),
    ],
    [
      'развёртка сохраняет остальные поля и порядок',
      q(src(), [
        { type: 'sort', by: [{ field: 'title', dir: 'asc' }] },
        { type: 'unnest', field: 'tags' },
        { type: 'select', fields: ['title', 'tags'] },
      ]),
    ],
    ['геометрия в результате — GeoJSON', q(src(), [{ type: 'select', fields: ['title', 'geom'] }])],
    [
      'тайм-аут из спецификации',
      q(src(), [], {}, { timeoutMs: 5000, cache: true, approxCount: true }),
    ],
    [
      'пояс UTC',
      q(src(), [
        { type: 'filter', where: { field: 'occurred_at', op: 'eq', value: '2026-09-01' } },
        {
          type: 'aggregate',
          groupBy: [{ field: 'occurred_at', bucket: 'day' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
      ]),
      { timezone: 'UTC' },
    ],
    [
      'пример из контракта',
      q(
        src('inc'),
        [
          {
            type: 'filter',
            where: {
              and: [
                {
                  field: 'inc.occurred_at',
                  op: 'relative',
                  value: { unit: 'month', from: -12, to: 0 },
                },
                { field: 'inc.territory_id', op: 'within', value: '@param:territory' },
              ],
            },
          },
          {
            type: 'join',
            source: regionsSource,
            on: [{ left: 'inc.territory_id', right: 'reg.territory_id' }],
            kind: 'left',
          },
          {
            type: 'aggregate',
            groupBy: [
              { field: 'inc.occurred_at', bucket: 'month', alias: 'month' },
              { field: 'reg.name', alias: 'region' },
            ],
            measures: [
              { alias: 'incidents', agg: 'count' },
              { alias: 'damage', agg: 'sum', field: 'inc.damage' },
              { alias: 'per_100k', agg: 'expr', expr: 'count() / max(reg.population) * 100000' },
            ],
          },
          {
            type: 'window',
            fields: [
              {
                alias: 'incidents_prev',
                fn: 'lag',
                field: 'incidents',
                partitionBy: ['region'],
                orderBy: ['month'],
              },
            ],
          },
          {
            type: 'sort',
            by: [
              { field: 'month', dir: 'asc' },
              { field: 'incidents', dir: 'desc' },
            ],
          },
          { type: 'limit', limit: 5000, offset: 0 },
        ],
        {
          territory: { type: 'territory', default: '@my_territories', label: { ru: 'Территория' } },
        },
        { timeoutMs: 30000, cache: true, approxCount: true },
      ),
    ],
    [
      'подчинённый видит своё: пользователь в контексте',
      filter({ field: 'assignee', op: 'in', value: [SUB_1, '@me'] }),
    ],
    [
      'подразделение: список с макросом',
      filter({ field: 'unit_id', op: 'in', value: ['@my_units', UNIT_A] }),
    ],
  ])
})
