import type { FilterNode, QuerySpec } from '@kchs/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CompileContext,
  compileQuery,
  type ReferenceMap,
  type ReferenceRequest,
  type ResolvedDataset,
} from '../src/index.js'
import { databaseUrl, dataSql, ddlSql, dropSql, testTables } from './db.js'
import {
  archive,
  ctx,
  IDS,
  incidents,
  q,
  regions,
  src,
  staff,
  TERR_DU,
  TERR_DU_1,
  TERR_DU_2,
  TERR_KH,
  USER_ID,
} from './fixtures.js'

/**
 * Выполнение скомпилированного SQL на настоящем Postgres (PostGIS) под ролью
 * `kchs_query` в транзакции только для чтения (база — test/db.ts; без неё набор
 * пропускается).
 */
const url = databaseUrl()
const describeDb = url ? describe : describe.skip
const T = testTables('qtest')

const execIncidents: ResolvedDataset = { ...incidents, table: T.incidents }
const execRegions: ResolvedDataset = { ...regions, table: T.regions }
const execArchive: ResolvedDataset = { ...archive, table: T.archive }
const execStaff: ResolvedDataset = { ...staff, table: T.staff }

function datasets(...overrides: ResolvedDataset[]): Partial<CompileContext> {
  const map = new Map<string, ResolvedDataset>(
    [execIncidents, execRegions, execArchive, execStaff].map((item) => [item.id, item]),
  )
  for (const item of overrides) map.set(item.id, item)
  return { datasets: map }
}

type Row = Record<string, unknown>

describeDb('выполнение на Postgres', () => {
  let db: postgres.Sql

  beforeAll(async () => {
    db = postgres(url as string, { max: 2, onnotice: () => {} })
    await db.unsafe(ddlSql(T))
    await db.unsafe(dataSql(T))
  })

  afterAll(async () => {
    await db?.unsafe(dropSql(T))
    await db?.end()
  })

  /** Как в API: роль kchs_query, только чтение, тайм-аут, путь поиска ds и extensions. */
  async function run(spec: QuerySpec, overrides: Partial<CompileContext> = {}) {
    const compiled = compileQuery(spec, ctx({ ...datasets(), ...overrides }))
    return db.begin('read only', async (tx) => {
      await tx.unsafe('SET LOCAL ROLE kchs_query')
      await tx.unsafe('SET LOCAL search_path = ds, extensions')
      await tx.unsafe(`SET LOCAL statement_timeout = ${compiled.timeoutMs}`)
      const rows = (await tx.unsafe(compiled.sql, compiled.params as never[])) as unknown as Row[]
      const counted = (await tx.unsafe(
        compiled.countSql,
        compiled.countParams as never[],
      )) as unknown as Row[]
      return { rows: [...rows], count: Number(counted[0]?.count), compiled }
    })
  }

  const where = (condition: FilterNode) => q(src(), [{ type: 'filter', where: condition }])
  const titles = (rows: Row[]) => rows.map((row) => row.title as string).sort()
  async function titlesOf(condition: FilterNode, overrides?: Partial<CompileContext>) {
    return titles((await run(where(condition), overrides)).rows)
  }

  it('строки датасета без удалённых, режим таблицы, GeoJSON', async () => {
    const { rows, count, compiled } = await run(q(src()), { rowMeta: true })
    expect(rows).toHaveLength(10)
    expect(count).toBe(10)
    expect(Object.keys(rows[0] as Row).slice(0, 3)).toEqual(['_id', '_ver', 'title'])
    expect(compiled.fields[0]).toMatchObject({ name: '_id', semantic: 'system' })
    const first = rows.find((row) => row.title === 'Пожар на складе') as Row
    expect(first.geom).toEqual({ type: 'Point', coordinates: [68.78, 38.56] })
    expect(first.response).toBe(90)
    expect(first.tags).toEqual(['urgent', 'night'])
    expect(first.meta).toEqual({ level: 2 })
    expect(titles(rows)).not.toContain('Удалено')
  })

  it('предел строк: на одну больше, подсчёт — полный', async () => {
    const { rows, count } = await run(q(src()), { maxRows: 3 })
    expect(rows).toHaveLength(4)
    expect(count).toBe(10)
  })

  it('текст: равно, не равно (с пустыми)', async () => {
    expect(await titlesOf({ field: 'title', op: 'eq', value: 'Паводок' })).toEqual(['Паводок'])
    expect(await titlesOf({ field: 'kind', op: 'neq', value: 'fire' })).toEqual(
      ['ДТП', 'Наводнение', 'Оползень', 'Паводок', 'Прочее'].sort(),
    )
  })

  it('текст: содержит без учёта регистра, спецсимволы экранированы', async () => {
    expect(await titlesOf({ field: 'title', op: 'contains', value: 'пожар' })).toHaveLength(5)
    expect(await titlesOf({ field: 'title', op: 'contains', value: '50%_' })).toEqual([
      'Пожар 50%_off',
    ])
    expect(await titlesOf({ field: 'notes', op: 'not_contains', value: 'учения' })).toHaveLength(7)
  })

  it('текст: начало, конец, регулярное выражение, пустота', async () => {
    expect(await titlesOf({ field: 'code', op: 'starts_with', value: 'DU-' })).toHaveLength(5)
    expect(await titlesOf({ field: 'email', op: 'ends_with', value: '@gov.tj' })).toHaveLength(4)
    expect(await titlesOf({ field: 'code', op: 'regex', value: '^kh-\\d+$' })).toEqual(
      ['Оползень', 'Паводок', 'Пожар в лесу'].sort(),
    )
    expect(await titlesOf({ field: 'notes', op: 'is_empty' })).toHaveLength(6)
    expect(await titlesOf({ field: 'notes', op: 'not_empty' })).toHaveLength(4)
  })

  it('списки значений: in, not_in с пустыми', async () => {
    expect(await titlesOf({ field: 'kind', op: 'in', value: ['fire', 'flood'] })).toHaveLength(7)
    expect(await titlesOf({ field: 'kind', op: 'not_in', value: ['fire'] })).toHaveLength(5)
    expect(await titlesOf({ field: 'kind', op: 'in', value: [] })).toEqual([])
  })

  it('числа: между, сравнения, дробное значение для целого', async () => {
    expect(await titlesOf({ field: 'damage', op: 'between', value: [10000, 200000] })).toEqual(
      ['Наводнение', 'Паводок', 'Пожар в доме', 'Пожар на складе'].sort(),
    )
    expect(await titlesOf({ field: 'victims', op: 'gt', value: 0 })).toHaveLength(5)
    expect(await titlesOf({ field: 'victims', op: 'eq', value: 2.5 })).toEqual([])
    expect(await titlesOf({ field: 'victims', op: 'in', value: [0, 5] })).toHaveLength(5)
  })

  it('даты: между, до', async () => {
    expect(
      await titlesOf({ field: 'reported_on', op: 'between', value: ['2026-09-01', '2026-09-30'] }),
    ).toHaveLength(5)
    expect(await titlesOf({ field: 'reported_on', op: 'before', value: '2026-01-01' })).toEqual([
      'ДТП',
    ])
  })

  it('дата и время: день — местный (Asia/Dushanbe), не UTC', async () => {
    expect(await titlesOf({ field: 'occurred_at', op: 'eq', value: '2026-09-18' })).toEqual([
      'Пожар в доме',
    ])
    expect(await titlesOf({ field: 'occurred_at', op: 'eq', value: '2026-09-17' })).toEqual([
      'Пожар, учения',
    ])
    expect(
      await titlesOf({ field: 'occurred_at', op: 'eq', value: '2026-09-17' }, { timezone: 'UTC' }),
    ).toEqual(['Пожар в доме', 'Пожар, учения'])
  })

  it('относительные периоды от «сейчас» (18.09.2026 12:30 по Душанбе)', async () => {
    expect(
      await titlesOf({
        field: 'occurred_at',
        op: 'relative',
        value: { unit: 'day', from: -1, to: 0 },
      }),
    ).toEqual(['Пожар в доме', 'Пожар, учения'])
    expect(
      await titlesOf({
        field: 'occurred_at',
        op: 'relative',
        value: { unit: 'month', from: 0, to: 0 },
      }),
    ).toHaveLength(5)
    expect(
      await titlesOf({
        field: 'reported_on',
        op: 'relative',
        value: { unit: 'year', from: -1, to: -1 },
      }),
    ).toEqual(['ДТП'])
  })

  it('логическое, пользователь, подразделение', async () => {
    expect(await titlesOf({ field: 'is_confirmed', op: 'is_true' })).toHaveLength(4)
    expect(await titlesOf({ field: 'is_confirmed', op: 'is_false' })).toHaveLength(3)
    expect(await titlesOf({ field: 'assignee', op: 'is_me' })).toHaveLength(3)
    expect(await titlesOf({ field: 'assignee', op: 'is_my_subordinate' })).toHaveLength(5)
    expect(await titlesOf({ field: 'unit_id', op: 'in_my_unit' })).toHaveLength(8)
    expect(await titlesOf({ field: 'assignee', op: 'in_my_unit' })).toHaveLength(6)
    expect(await titlesOf({ field: '_created_by', op: 'is_me' })).toHaveLength(2)
  })

  it('территория с дочерними и без', async () => {
    expect(
      await titlesOf({
        field: 'territory_id',
        op: 'within',
        value: { id: TERR_DU, includeChildren: true },
      }),
    ).toHaveLength(6)
    expect(
      await titlesOf({
        field: 'territory_id',
        op: 'within',
        value: { id: TERR_DU, includeChildren: false },
      }),
    ).toEqual(['ДТП', 'Наводнение'])
  })

  it('территории: сводка по уровню и подписи — подстановкой, без чтения справочника ролью', async () => {
    // Регион районов Душанбе — сам Душанбе; Хатлон — регион себе
    const region = { [TERR_DU]: TERR_DU, [TERR_DU_1]: TERR_DU, [TERR_DU_2]: TERR_DU }
    const names = { [TERR_DU]: 'Душанбе', [TERR_KH]: 'Хатлон' }
    const references = (request: ReferenceRequest): ReferenceMap | undefined => {
      if (request.kind === 'territory_level' && request.key === 'id') {
        return { values: { ...region, [TERR_KH]: TERR_KH }, version: 't1' }
      }
      if (request.kind === 'territory_name') return { values: names, version: 't1:ru' }
      return undefined
    }
    const { rows } = await run(
      q(src(), [
        {
          type: 'compute',
          fields: [
            { name: 'region', expr: "territory_level(territory_id, 'region')" },
            { name: 'region_name', expr: 'territory_name(region)' },
          ],
        },
        {
          type: 'aggregate',
          groupBy: [{ field: 'region' }, { field: 'region_name' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
        { type: 'sort', by: [{ field: 'region_name', dir: 'asc' }] },
      ]),
      { references },
    )
    // count — bigint строкой; у одной строки территории нет
    expect(rows).toEqual([
      { region: TERR_DU, region_name: 'Душанбе', n: '6' },
      { region: TERR_KH, region_name: 'Хатлон', n: '3' },
      { region: null, region_name: null, n: '1' },
    ])
  })

  it('геометрия: пересечение, внутри, в радиусе, пустота', async () => {
    const polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [68.6, 38.4],
          [69.0, 38.4],
          [69.0, 38.7],
          [68.6, 38.7],
          [68.6, 38.4],
        ],
      ],
    }
    expect(await titlesOf({ field: 'geom', op: 'intersects', value: polygon })).toHaveLength(4)
    expect(await titlesOf({ field: 'geom', op: 'within', value: polygon })).toHaveLength(4)
    expect(
      await titlesOf({
        field: 'geom',
        op: 'dwithin',
        value: { lon: 68.78, lat: 38.56, distance: 5000 },
      }),
    ).toEqual(['Пожар в доме', 'Пожар на складе'])
    expect(await titlesOf({ field: 'geom', op: 'is_empty' })).toEqual(
      ['ДТП', 'Наводнение', 'Прочее'].sort(),
    )
  })

  it('множественный выбор, время, JSON, длительность, отрицание', async () => {
    expect(await titlesOf({ field: 'tags', op: 'in', value: ['night'] })).toHaveLength(3)
    expect(await titlesOf({ field: 'tags', op: 'not_in', value: ['test'] })).toHaveLength(8)
    expect(await titlesOf({ field: 'tags', op: 'contains', value: 'urgent' })).toHaveLength(3)
    expect(await titlesOf({ field: 'tags', op: 'is_empty' })).toHaveLength(4)
    expect(
      await titlesOf({ field: 'start_time', op: 'between', value: ['08:00', '18:30'] }),
    ).toHaveLength(5)
    expect(await titlesOf({ field: 'meta', op: 'eq', value: { level: 2 } })).toEqual([
      'Оползень',
      'Пожар на складе',
    ])
    expect(await titlesOf({ field: 'response', op: 'gt', value: 60 })).toHaveLength(4)
    expect(await titlesOf({ not: { field: 'kind', op: 'eq', value: 'fire' } })).toHaveLength(5)
  })

  it('параметры: заданный, пропущенный, группа с пропущенным', async () => {
    const params = { kind: { type: 'text' as const } }
    const spec = q(
      src(),
      [
        {
          type: 'filter',
          where: {
            and: [
              { field: 'kind', op: 'eq', value: '@param:kind' },
              {
                or: [
                  { field: 'victims', op: 'gt', value: 0 },
                  { field: 'title', op: 'eq', value: '@param:kind' },
                ],
              },
            ],
          },
        },
      ],
      params,
    )
    expect(titles((await run(spec, { params: { kind: 'flood' } })).rows)).toEqual(['Наводнение'])
    expect((await run(spec)).rows).toHaveLength(10)
  })

  it('сводка: группы, меры, условные меры, first/last', async () => {
    const { rows } = await run(
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind' }],
          measures: [
            { alias: 'n', agg: 'count' },
            { alias: 'total', agg: 'sum', field: 'damage' },
            { alias: 'victims', agg: 'max', field: 'victims' },
            { alias: 'med', agg: 'median', field: 'damage' },
            { alias: 'confirmed', agg: 'count', filter: { field: 'is_confirmed', op: 'is_true' } },
            { alias: 'first_title', agg: 'first', field: 'title' },
            { alias: 'last_title', agg: 'last', field: 'title' },
            { alias: 'titles', agg: 'string_agg', field: 'code' },
            { alias: 'share', agg: 'expr', expr: 'round(sum(damage) / count(), 1)' },
          ],
        },
        { type: 'sort', by: [{ field: 'kind', dir: 'asc', nulls: 'last' }] },
      ]),
    )
    expect(rows.map((row) => row.kind)).toEqual(['accident', 'fire', 'flood', 'landslide', null])
    const fire = rows[1] as Row
    expect(Number(fire.n)).toBe(5)
    expect(Number(fire.total)).toBe(471000.5)
    expect(Number(fire.med)).toBe(20000)
    expect(Number(fire.confirmed)).toBe(3)
    expect(fire.first_title).toBe('Пожар на складе')
    expect(fire.last_title).toBe('Пожар в лесу')
    expect(fire.titles).toBe('DU-001, DU-003, DU-007, KH-009, X-5')
    expect(fire.share).toBe(94200.1)
    expect(Number((rows[2] as Row).total)).toBe(170000)
  })

  it('сводка по местным дням и месяцам', async () => {
    const { rows } = await run(
      q(src(), [
        { type: 'filter', where: { field: 'occurred_at', op: 'not_empty' } },
        {
          type: 'aggregate',
          groupBy: [{ field: 'occurred_at', bucket: 'day', alias: 'day' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
        { type: 'filter', where: { field: 'day', op: 'gte', value: '2026-09-17' } },
        { type: 'sort', by: [{ field: 'day', dir: 'asc' }] },
      ]),
    )
    expect(
      rows.map((row) => [(row.day as Date).toISOString().slice(0, 10), Number(row.n)]),
    ).toEqual([
      ['2026-09-17', 1],
      ['2026-09-18', 1],
    ])
    const months = await run(
      q(src(), [
        {
          type: 'aggregate',
          groupBy: [{ field: 'occurred_at', bucket: 'month', alias: 'month' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
        { type: 'sort', by: [{ field: 'month', dir: 'desc', nulls: 'last' }] },
        { type: 'limit', limit: 2, offset: 0 },
      ]),
    )
    expect(months.rows.map((row) => Number(row.n))).toEqual([5, 1])
  })

  it('окно поверх сводки: lag, нарастающий итог, ранг', async () => {
    const { rows } = await run(
      q(src(), [
        { type: 'filter', where: { field: 'kind', op: 'not_empty' } },
        {
          type: 'aggregate',
          groupBy: [{ field: 'kind' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
        {
          type: 'window',
          fields: [
            { alias: 'prev', fn: 'lag', field: 'n', partitionBy: [], orderBy: ['kind'] },
            { alias: 'cum', fn: 'running_sum', field: 'n', partitionBy: [], orderBy: ['kind'] },
            { alias: 'place', fn: 'dense_rank', partitionBy: [], orderBy: ['n desc'] },
          ],
        },
        { type: 'sort', by: [{ field: 'kind', dir: 'asc' }] },
      ]),
    )
    expect(
      rows.map((row) => [
        row.kind,
        Number(row.n),
        row.prev === null ? null : Number(row.prev),
        Number(row.cum),
        Number(row.place),
      ]),
    ).toEqual([
      ['accident', 1, null, 1, 3],
      ['fire', 5, 1, 6, 1],
      ['flood', 2, 5, 8, 2],
      ['landslide', 1, 2, 9, 3],
    ])
  })

  it('соединение с политиками источника и мера-выражение', async () => {
    const { rows } = await run(
      q(src('inc'), [
        {
          type: 'join',
          source: { kind: 'dataset', id: IDS.regions, alias: 'reg' },
          on: [{ left: 'inc.territory_id', right: 'reg.territory_id' }],
          kind: 'inner',
        },
        {
          type: 'aggregate',
          groupBy: [{ field: 'reg.name', alias: 'region' }],
          measures: [
            { alias: 'incidents', agg: 'count' },
            {
              alias: 'per_100k',
              agg: 'expr',
              expr: 'round(count() / max(reg.population) * 100000, 2)',
            },
          ],
        },
        { type: 'sort', by: [{ field: 'region', dir: 'asc' }] },
      ]),
    )
    expect(rows.map((row) => [row.region, Number(row.incidents), row.per_100k])).toEqual([
      ['Душанбе', 2, 0.2],
      ['Сино', 2, 0.5],
      ['Хатлон', 3, 0.1],
      ['Шохмансур', 2, 0.67],
    ])
    const restricted = await run(
      q(src('inc'), [
        {
          type: 'join',
          source: { kind: 'dataset', id: IDS.regions, alias: 'reg' },
          on: [{ left: 'inc.territory_id', right: 'reg.territory_id' }],
          kind: 'left',
        },
        { type: 'filter', where: { field: 'reg.name', op: 'not_empty' } },
      ]),
      datasets({
        ...execRegions,
        rowPolicy: { kind: 'filter', where: { field: 'territory_id', op: 'eq', value: TERR_KH } },
      }),
    )
    expect(titles(restricted.rows)).toEqual(['Оползень', 'Паводок', 'Пожар в лесу'])
  })

  it('политика строк: мои территории, выражение, «ничего»', async () => {
    const mine = await run(q(src()), {
      ...datasets({
        ...execIncidents,
        rowPolicy: {
          kind: 'filter',
          where: { field: 'territory_id', op: 'within', value: '@my_territories' },
        },
      }),
      user: {
        id: USER_ID,
        unitIds: [],
        territoryIds: [TERR_KH],
        subordinateIds: [],
        attributes: {},
      },
    })
    expect(titles(mine.rows)).toEqual(['Оползень', 'Паводок', 'Пожар в лесу'])
    expect(mine.count).toBe(3)
    const combined = await run(where({ field: 'kind', op: 'eq', value: 'fire' }), {
      ...datasets({
        ...execIncidents,
        rowPolicy: { kind: 'expr', expr: "victims > 1 or kind = 'fire' and damage > 100000" },
      }),
    })
    expect(titles(combined.rows)).toEqual(['Пожар в лесу', 'Пожар на складе'])
    const none = await run(q(src()), datasets({ ...execIncidents, rowPolicy: { kind: 'none' } }))
    expect(none.rows).toEqual([])
    expect(none.count).toBe(0)
  })

  it('политика столбцов: скрытые не видны, маски сохраняют тип, фильтр — по маске', async () => {
    const hidden = await run(
      q(src()),
      datasets({ ...execIncidents, columnPolicy: { hide: ['damage', 'geom'], mask: [] } }),
    )
    expect(Object.keys(hidden.rows[0] as Row)).not.toContain('damage')
    const masked = datasets({
      ...execStaff,
      columnPolicy: {
        hide: [],
        mask: ['name', 'salary', 'phone', 'email', 'hired_on', 'unit_id', 'passport'],
      },
    })
    const { rows } = await run(
      q({ kind: 'dataset', id: IDS.staff }, [
        { type: 'sort', by: [{ field: 'passport', dir: 'desc' }] },
      ]),
      masked,
    )
    expect(
      rows.map((row) => ({
        ...row,
        salary: Number(row.salary),
        hired_on: (row.hired_on as Date).toISOString().slice(0, 10),
      })),
    ).toEqual([
      {
        name: '***',
        salary: 120000,
        phone: '*** 456',
        email: '***@gov.tj',
        hired_on: '2019-01-01',
        unit_id: null,
        passport: '***4567',
      },
      {
        name: '***',
        salary: 0,
        phone: '***',
        email: '***@mail.tj',
        hired_on: '2021-01-01',
        unit_id: null,
        passport: '***',
      },
    ])
    const byMask = await run(
      q({ kind: 'dataset', id: IDS.staff }, [
        { type: 'filter', where: { field: 'salary', op: 'eq', value: 120000 } },
      ]),
      masked,
    )
    expect(byMask.rows).toHaveLength(1)
    const byOriginal = await run(
      q({ kind: 'dataset', id: IDS.staff }, [
        { type: 'filter', where: { field: 'salary', op: 'eq', value: 123456.78 } },
      ]),
      masked,
    )
    expect(byOriginal.rows).toHaveLength(0)
  })

  it('маски чисел, дат и длительности на происшествиях', async () => {
    const { rows } = await run(
      where({ field: 'title', op: 'eq', value: 'Пожар на складе' }),
      datasets({
        ...execIncidents,
        columnPolicy: {
          hide: [],
          mask: ['damage', 'occurred_at', 'response', 'ratio', 'geom', 'tags', 'meta'],
        },
      }),
    )
    const row = rows[0] as Row
    expect(Number(row.damage)).toBe(150000)
    expect((row.occurred_at as Date).toISOString()).toBe('2025-12-31T19:00:00.000Z')
    expect(row.response).toBe(90)
    expect(row.ratio).toBe(0.5)
    expect(row.geom).toBeNull()
    expect(row.tags).toBeNull()
    expect(row.meta).toBeNull()
  })

  it('объединение, развёртка, выборка', async () => {
    const union = await run(
      q(src(), [
        { type: 'select', fields: ['title', 'kind', 'damage'] },
        { type: 'union', source: { kind: 'dataset', id: IDS.archive }, mode: 'all' },
      ]),
    )
    expect(union.rows).toHaveLength(12)
    expect(union.count).toBe(12)
    const tags = await run(
      q(src(), [
        { type: 'unnest', field: 'tags' },
        {
          type: 'aggregate',
          groupBy: [{ field: 'tags', alias: 'tag' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
        { type: 'sort', by: [{ field: 'tag', dir: 'asc', nulls: 'last' }] },
      ]),
    )
    expect(tags.rows.map((row) => [row.tag, Number(row.n)])).toEqual([
      ['night', 3],
      ['test', 2],
      ['urgent', 3],
      [null, 4],
    ])
    expect((await run(q(src(), [{ type: 'sample', n: 3 }]))).rows).toHaveLength(3)
    expect((await run(q(src(), [{ type: 'sample', fraction: 1 }]))).rows).toHaveLength(10)
  })

  it('вычисления: безопасные приведения, даты в поясе, строки', async () => {
    const { rows } = await run(
      q(src(), [
        { type: 'filter', where: { field: 'title', op: 'in', value: ['Пожар в доме', 'ДТП'] } },
        {
          type: 'compute',
          fields: [
            { name: 'as_date', expr: 'date(code)' },
            { name: 'local', expr: "format_date(occurred_at, 'YYYY-MM-DD HH24:MI')" },
            { name: 'days', expr: "date_diff(reported_on, date('2026-12-31'), 'day')" },
            { name: 'label', expr: "upper(kind) || ' / ' || coalesce(phone, '—')" },
            { name: 'per_victim', expr: 'safe_div(damage, victims)' },
            {
              name: 'bucket',
              expr: "case when victims > 2 then 'many' when victims > 0 then 'few' else 'none' end",
            },
          ],
        },
        { type: 'sort', by: [{ field: 'title', dir: 'asc' }] },
        {
          type: 'select',
          fields: ['title', 'as_date', 'local', 'days', 'label', 'per_victim', 'bucket'],
        },
      ]),
    )
    expect(rows).toEqual([
      {
        title: 'ДТП',
        as_date: null,
        local: '2025-12-31 23:59',
        days: 365,
        label: 'ACCIDENT / —',
        per_victim: null,
        bucket: 'many',
      },
      {
        title: 'Пожар в доме',
        as_date: null,
        local: '2026-09-18 00:30',
        days: 104,
        label: 'FIRE / 12',
        per_victim: 20000,
        bucket: 'few',
      },
    ])
  })

  it('сохранённый запрос как источник и соединение с ним', async () => {
    const totals = q(src(), [
      {
        type: 'aggregate',
        groupBy: [{ field: 'kind' }],
        measures: [{ alias: 'total', agg: 'count' }],
      },
    ])
    const { rows } = await run(
      q({ kind: 'query', id: IDS.savedTotals, alias: 't' }, [
        { type: 'filter', where: { field: 'total', op: 'gt', value: 1 } },
        { type: 'sort', by: [{ field: 'total', dir: 'desc' }] },
      ]),
      { queries: new Map([[IDS.savedTotals, totals]]) },
    )
    expect(rows.map((row) => [row.kind, Number(row.total)])).toEqual([
      ['fire', 5],
      ['flood', 2],
    ])
  })

  it('встроенные строки в соединении', async () => {
    const { rows } = await run(
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
          kind: 'inner',
        },
        {
          type: 'aggregate',
          groupBy: [{ field: 'label' }],
          measures: [{ alias: 'n', agg: 'count' }],
        },
        { type: 'sort', by: [{ field: 'n', dir: 'desc' }] },
      ]),
    )
    expect(rows.map((row) => [row.label, Number(row.n)])).toEqual([
      ['Пожар', 5],
      ['Паводок', 2],
    ])
  })

  it('роль kchs_query не читает таблицы вне ds', async () => {
    await db.unsafe('CREATE TABLE IF NOT EXISTS public.qtest_secret (x int)')
    try {
      await expect(
        db.begin('read only', async (tx) => {
          await tx.unsafe('SET LOCAL ROLE kchs_query')
          return tx.unsafe('SELECT count(*) FROM public.qtest_secret')
        }),
      ).rejects.toThrow('permission denied')
    } finally {
      await db.unsafe('DROP TABLE IF EXISTS public.qtest_secret')
    }
  })
})
