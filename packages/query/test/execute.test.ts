import { readFileSync } from 'node:fs'
import type { FilterNode, QuerySpec } from '@kchs/contracts'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CompileContext, compileQuery, type ResolvedDataset } from '../src/index.js'
import {
  archive,
  ctx,
  IDS,
  incidents,
  q,
  regions,
  SUB_1,
  SUB_2,
  src,
  staff,
  TERR_DU,
  TERR_DU_1,
  TERR_DU_2,
  TERR_KH,
  UNIT_A,
  UNIT_B,
  USER_ID,
} from './fixtures.js'

/**
 * Выполнение скомпилированного SQL на настоящем Postgres (PostGIS) под ролью
 * `kchs_query` в транзакции только для чтения. Нужна база с ролями и схемами
 * из infra/compose/postgres/init. Строка подключения роли kchs_app —
 * `KCHS_QUERY_TEST_DATABASE_URL`, либо `KCHS_TEST_SLOT=N`: база `kchs_test_N`
 * по `DATABASE_URL` (из окружения или корневого .env). Без них набор пропускается.
 */
const url = databaseUrl()
const describeDb = url ? describe : describe.skip

function databaseUrl(): string | undefined {
  if (process.env.KCHS_QUERY_TEST_DATABASE_URL) return process.env.KCHS_QUERY_TEST_DATABASE_URL
  const slot = process.env.KCHS_TEST_SLOT
  if (!slot) return undefined
  if (!/^([1-9]|1[0-4])$/.test(slot)) throw new Error('KCHS_TEST_SLOT: целое число 1…14')
  return (process.env.DATABASE_URL ?? rootDatabaseUrl())?.replace(
    /\/kchs(\?|$)/,
    `/kchs_test_${slot}$1`,
  )
}

function rootDatabaseUrl(): string | undefined {
  try {
    const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
    return /^DATABASE_URL=["']?([^"'\n]+?)["']?$/m.exec(env)?.[1]
  } catch {
    return undefined
  }
}

const T = {
  incidents: 'ds.t_qtest_incidents',
  regions: 'ds.t_qtest_regions',
  archive: 'ds.t_qtest_archive',
  staff: 'ds.t_qtest_staff',
}

const SYSTEM = `_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  _ver integer NOT NULL DEFAULT 1,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  _deleted_at timestamptz,
  _import_id uuid`

const DDL = `
DROP TABLE IF EXISTS ${T.incidents}, ${T.regions}, ${T.archive}, ${T.staff};
CREATE TABLE ${T.incidents} (${SYSTEM},
  c_1 text, c_2 text, c_3 numeric(18, 2), c_4 bigint, c_5 timestamptz, c_6 date, c_7 uuid,
  c_8 uuid, c_9 uuid, c_10 text[], c_11 extensions.geometry(Geometry, 4326), c_12 boolean,
  c_13 interval, c_14 double precision, c_15 text, c_16 time, c_17 jsonb,
  c_19 double precision, c_20 text, c_21 text, c_22 text);
CREATE TABLE ${T.regions} (${SYSTEM}, c_1 uuid, c_2 text, c_3 bigint);
CREATE TABLE ${T.archive} (${SYSTEM}, c_1 text, c_2 text, c_3 numeric(18, 2), c_4 timestamptz, c_5 date);
CREATE TABLE ${T.staff} (${SYSTEM},
  c_1 text, c_2 numeric(18, 2), c_3 text, c_4 text, c_5 date, c_6 uuid, c_7 text);
`

const point = (lon: number, lat: number) =>
  `extensions.ST_SetSRID(extensions.ST_MakePoint(${lon}, ${lat}), 4326)`

/** Происшествия: время — местное Душанбе (+05); строка 3 — 18 сентября по местному, 17-го по UTC. */
const DATA = `
INSERT INTO ${T.incidents} (_created_by, c_1, c_2, c_3, c_4, c_5, c_6, c_7, c_8, c_9, c_10, c_11, c_12,
  c_13, c_14, c_15, c_16, c_17, c_19, c_20, c_21, c_22) VALUES
('${USER_ID}', 'Пожар на складе', 'fire', 150000.50, 2, '2026-09-01 10:00+05', '2026-09-01', '${TERR_DU_1}',
  '${USER_ID}', '${UNIT_A}', '{urgent,night}', ${point(68.78, 38.56)}, true, '90 minutes', 0.5,
  '+992 900 123 456', '08:30', '{"level": 2}', 0.1, 'DU-001', 'a@gov.tj', 'учения не проводились'),
(NULL, 'Паводок', 'flood', 50000, 0, '2026-08-15 23:30+05', '2026-08-16', '${TERR_KH}',
  '${SUB_1}', '${UNIT_B}', '{urgent}', ${point(68.9, 37.9)}, false, '3 hours', 0.2,
  '+992 900 000 001', '23:30', '{"level": 1}', 0.2, 'KH-002', 'b@mail.tj', NULL),
(NULL, 'Пожар в доме', 'fire', 20000, 1, '2026-09-18 00:30+05', '2026-09-18', '${TERR_DU_2}',
  '${SUB_2}', '${UNIT_A}', '{}', ${point(68.8, 38.55)}, NULL, '45 minutes', NULL,
  '12', '12:00', NULL, 0.3, 'DU-003', 'c@gov.tj', 'Учения'),
(NULL, 'ДТП', 'accident', NULL, 3, '2025-12-31 23:59+05', '2025-12-31', '${TERR_DU}',
  NULL, NULL, NULL, NULL, true, NULL, 1.5, NULL, NULL, NULL, NULL, 'DU-004', NULL, ''),
('${USER_ID}', 'Пожар 50%_off', 'fire', 1000, 0, '2026-01-10 12:00+05', '2026-01-10', '${TERR_DU_1}',
  '${USER_ID}', '${UNIT_B}', '{night}', ${point(68.7, 38.6)}, true, '10 minutes', 0.9,
  NULL, '06:00', '{"level": 3}', 0.5, 'X-5', 'd@x.org', 'заметка'),
(NULL, 'Оползень', 'landslide', 750000, 5, '2026-09-10 08:00+05', '2026-09-10', '${TERR_KH}',
  '${SUB_1}', '${UNIT_B}', '{urgent,test}', ${point(69.5, 37.5)}, false, '2 hours', 0.05,
  '+992 111', '19:00', '{"level": 2}', 0.9, 'KH-006', 'e@gov.tj', NULL),
(NULL, 'Пожар, учения', 'fire', 0, 0, '2026-09-17 15:00+05', '2026-09-17', '${TERR_DU_2}',
  '${USER_ID}', '${UNIT_A}', '{test}', ${point(68.85, 38.58)}, true, '5 minutes', 0.3,
  NULL, '15:00', NULL, 0.0, 'DU-007', NULL, 'Учения по плану'),
(NULL, 'Наводнение', 'flood', 120000, 1, '2026-07-01 09:00+05', '2026-07-01', '${TERR_DU}',
  '${SUB_2}', '${UNIT_A}', '{}', NULL, NULL, '1 hour', 0.7, NULL, '09:00', '{"level": 1}', 0.4,
  'DU-008', 'f@gov.tj', NULL),
(NULL, 'Пожар в лесу', 'fire', 300000, 0, '2026-09-11 18:00+05', '2026-09-11', '${TERR_KH}',
  '${SUB_1}', '${UNIT_B}', '{night}', ${point(69.0, 37.8)}, false, '4 hours', 0.6, NULL, '18:00',
  NULL, 0.6, 'KH-009', NULL, NULL),
(NULL, 'Прочее', NULL, 10, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL);
INSERT INTO ${T.incidents} (_deleted_at, c_1, c_2, c_3) VALUES (now(), 'Удалено', 'fire', 999999);
INSERT INTO ${T.regions} (c_1, c_2, c_3) VALUES
  ('${TERR_DU}', 'Душанбе', 1000000), ('${TERR_DU_1}', 'Сино', 400000),
  ('${TERR_DU_2}', 'Шохмансур', 300000), ('${TERR_KH}', 'Хатлон', 3000000);
INSERT INTO ${T.archive} (c_1, c_2, c_3, c_4, c_5) VALUES
  ('Архивный пожар', 'fire', 5000, '2020-05-01 10:00+05', '2020-05-01'),
  ('Архивный паводок', 'flood', 7000, '2019-04-01 10:00+05', '2019-04-01');
INSERT INTO ${T.staff} (c_1, c_2, c_3, c_4, c_5, c_6, c_7) VALUES
  ('Иван Петров', 123456.78, '+992 900 123 456', 'ivan@gov.tj', '2019-03-15', '${UNIT_A}', 'A1234567'),
  ('Мария', 0, '12', 'maria@mail.tj', '2021-07-01', '${UNIT_B}', 'B12');
`

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
    await db.unsafe(DDL)
    await db.unsafe(DATA)
  })

  afterAll(async () => {
    await db?.unsafe(`DROP TABLE IF EXISTS ${T.incidents}, ${T.regions}, ${T.archive}, ${T.staff}`)
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
