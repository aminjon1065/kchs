import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compileRawSql,
  QueryCompileError,
  type RawSqlContext,
  rawSqlErrorPosition,
  type SqlDataset,
} from '../src/index.js'
import { databaseUrl, dataSql, ddlSql, dropSql, testTables } from './db.js'
import { TERR_KH, USER_ID } from './fixtures.js'
import { sqlArchive, sqlCtx, sqlIncidents, sqlRegions, sqlStaff } from './sql-fixtures.js'

/**
 * Сырой SQL на настоящем Postgres (PostGIS): переписанный запрос выполняется, как
 * в API, под ролью `kchs_query` в транзакции только для чтения с тайм-аутом и
 * поясом пользователя. Политики строк и маски действуют при любых формах
 * обращения к датасету; `pg_sleep` до базы не доходит (база — test/db.ts; без
 * неё набор пропускается).
 */
const url = databaseUrl()
const describeDb = url ? describe : describe.skip
const T = testTables('rawsql')

const execIncidents: SqlDataset = { ...sqlIncidents, table: T.incidents }
const execRegions: SqlDataset = { ...sqlRegions, table: T.regions }
const execArchive: SqlDataset = { ...sqlArchive, table: T.archive }
const execStaff: SqlDataset = { ...sqlStaff, table: T.staff }

/** Датасеты с физическими таблицами теста; `overrides` заменяют их по идентификатору. */
function datasets(...overrides: SqlDataset[]): Pick<RawSqlContext, 'datasets'> {
  const byId = new Map(
    [execIncidents, execRegions, execArchive, execStaff].map((item) => [item.id, item]),
  )
  for (const item of overrides) byId.set(item.id, item)
  return { datasets: [...byId.values()] }
}

type Row = Record<string, unknown>

describeDb('сырой SQL на Postgres', () => {
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

  /** Как в API: роль kchs_query, только чтение, тайм-аут и пояс сеанса. */
  async function run(sql: string, overrides: Partial<RawSqlContext> = {}) {
    const compiled = await compileRawSql(sql, sqlCtx({ ...datasets(), ...overrides }))
    return db.begin('read only', async (tx) => {
      await tx.unsafe('SET LOCAL ROLE kchs_query')
      await tx.unsafe('SET LOCAL search_path = ds, extensions')
      await tx.unsafe(`SET LOCAL statement_timeout = ${compiled.timeoutMs}`)
      await tx.unsafe('SELECT set_config($1, $2, true)', ['TimeZone', compiled.timezone])
      const rows = (await tx.unsafe(compiled.sql, compiled.params as never[])) as unknown as Row[]
      const counted = (await tx.unsafe(
        compiled.countSql,
        compiled.countParams as never[],
      )) as unknown as Row[]
      return { rows: [...rows], count: Number(counted[0]?.count), compiled }
    })
  }

  async function count(sql: string, overrides: Partial<RawSqlContext> = {}): Promise<number> {
    const { rows } = await run(sql, overrides)
    return Number(rows[0]?.n)
  }

  it('человеческие имена: название датасета и подписи полей', async () => {
    const { rows, compiled } = await run(
      'SELECT "Вид", count(*) AS n FROM "Происшествия" GROUP BY 1 ORDER BY n DESC, 1',
    )
    expect(rows.map((row) => [row.Вид, Number(row.n)])).toEqual([
      ['fire', 5],
      ['flood', 2],
      ['accident', 1],
      ['landslide', 1],
      [null, 1],
    ])
    expect(Object.keys(rows[0] as Row)).toEqual(['Вид', 'n'])
    expect(compiled.fields?.[0]?.field?.type).toBe('select')
    const keys = await run('SELECT title, "Ущерб" FROM Происшествия WHERE code = \'DU-001\'')
    expect(keys.rows).toEqual([{ title: 'Пожар на складе', Ущерб: '150000.50' }])
  })

  it('политика строк действует при любых формах обращения к датасету', async () => {
    const mine = {
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
    } satisfies Partial<RawSqlContext>
    expect(await count('SELECT count(*) AS n FROM "Происшествия"', mine)).toBe(3)
    expect(
      await count('WITH x AS (SELECT * FROM "Происшествия") SELECT count(*) AS n FROM x', mine),
    ).toBe(3)
    expect(
      await count('SELECT count(*) AS n FROM "Происшествия" a CROSS JOIN "Происшествия" b', mine),
    ).toBe(9)
    expect(
      await count(
        'SELECT count(*) AS n FROM (SELECT * FROM "Происшествия" UNION ALL SELECT * FROM "Происшествия") u',
        mine,
      ),
    ).toBe(6)
    expect(await count('SELECT (SELECT count(*) FROM "Происшествия") AS n', mine)).toBe(3)
    expect(
      await count('SELECT count(*) AS n FROM "Происшествия" WHERE "Ущерб" > 0 OR true', mine),
    ).toBe(3)
    // Барьер OFFSET 0: условие пользователя не вычисляется на чужих строках — деление
    // на ноль на скрытой строке «Пожар на складе» (150000.50) не случается
    expect(
      await count(
        'SELECT count(*) AS n FROM "Происшествия" WHERE 1 / ("Ущерб" - 150000.50) > -1',
        mine,
      ),
    ).toBe(3)
    const expr = await run(
      'SELECT "Название" FROM "Происшествия" ORDER BY 1',
      datasets({
        ...execIncidents,
        rowPolicy: { kind: 'expr', expr: "victims > 1 or kind = 'fire' and damage > 100000" },
      }),
    )
    expect(expr.rows.map((row) => row.Название)).toEqual([
      'ДТП',
      'Оползень',
      'Пожар в лесу',
      'Пожар на складе',
    ])
    expect(
      await count(
        'SELECT count(*) AS n FROM "Происшествия"',
        datasets({ ...execIncidents, rowPolicy: { kind: 'none' } }),
      ),
    ).toBe(0)
  })

  it('маски и скрытые поля: значения только через маску, скрытых нет даже в строке целиком', async () => {
    const guarded = datasets({
      ...execStaff,
      columnPolicy: { hide: ['passport'], mask: ['salary', 'phone', 'email', 'hired_on'] },
    })
    const { rows } = await run(
      'SELECT "ФИО", "Оклад", "Телефон", "Почта", "Дата найма" FROM "Сотрудники" ORDER BY "ФИО"',
      guarded,
    )
    expect(
      rows.map((row) => ({
        ...row,
        'Дата найма': (row['Дата найма'] as Date).toISOString().slice(0, 10),
      })),
    ).toEqual([
      {
        ФИО: 'Иван Петров',
        Оклад: '120000',
        Телефон: '*** 456',
        Почта: '***@gov.tj',
        'Дата найма': '2019-01-01',
      },
      {
        ФИО: 'Мария',
        Оклад: '0.00',
        Телефон: '***',
        Почта: '***@mail.tj',
        'Дата найма': '2021-01-01',
      },
    ])
    const star = await run('SELECT * FROM "Сотрудники"', guarded)
    expect(Object.keys(star.rows[0] as Row)).not.toContain('passport')
    const whole = await run(
      'SELECT row_to_json(s) AS j FROM "Сотрудники" s WHERE "ФИО" = \'Иван Петров\'',
      guarded,
    )
    const json = whole.rows[0]?.j as Record<string, unknown>
    expect(json).not.toHaveProperty('passport')
    expect(json.salary).toBe(120000)
    expect(
      await count('SELECT count(*) AS n FROM "Сотрудники" WHERE "Оклад" = 123456.78', guarded),
    ).toBe(0)
    expect(
      await count('SELECT count(*) AS n FROM "Сотрудники" WHERE "Оклад" = 120000', guarded),
    ).toBe(1)
    await expect(run('SELECT "Паспорт" FROM "Сотрудники"', guarded)).rejects.toThrow(
      'Нет доступа к полю «passport»',
    )
  })

  it('удалённые строки и служебные столбцы таблицы недоступны', async () => {
    expect(
      await count('SELECT count(*) AS n FROM "Происшествия" WHERE "Название" = \'Удалено\''),
    ).toBe(0)
    expect(await count('SELECT count(DISTINCT _id) AS n FROM "Происшествия"')).toBe(10)
    await expect(run('SELECT _deleted_at FROM "Происшествия"')).rejects.toThrow(
      'Нет поля «_deleted_at»',
    )
  })

  it('параметры: объявленные типы, списки, вывод типа по месту, строки — только значениями', async () => {
    const typed = await run(
      'SELECT "Название" FROM "Происшествия" WHERE "Вид" = {{вид}} AND "Дата" >= {{с}} ORDER BY 1',
      {
        paramDefs: {
          вид: { type: 'text', required: true },
          с: { type: 'date', required: true },
        },
        params: { вид: 'fire', с: '2026-09-01' },
      },
    )
    expect(typed.rows.map((row) => row.Название)).toEqual([
      'Пожар в доме',
      'Пожар в лесу',
      'Пожар на складе',
      'Пожар, учения',
    ])
    expect(
      await count('SELECT count(*) AS n FROM "Происшествия" WHERE "Вид" = ANY({{виды}})', {
        paramDefs: { виды: { type: 'list', required: true } },
        params: { виды: ['flood', 'landslide'] },
      }),
    ).toBe(3)
    // Без объявления тип параметра выводит Postgres: здесь — ссылка (uuid)
    expect(
      await count('SELECT count(*) AS n FROM "Происшествия" WHERE "Район" = {{район}}', {
        params: { район: TERR_KH },
      }),
    ).toBe(3)
    expect(
      await count('SELECT count(*) AS n FROM "Происшествия" WHERE "Название" = {{t}}', {
        params: { t: "' OR 1=1; DROP TABLE ds.t_rawsql_regions; --" },
      }),
    ).toBe(0)
    expect(await count('SELECT count(*) AS n FROM "Регионы"')).toBe(4)
  })

  it('соединения, окна, объединения, LATERAL, рекурсия, JSON и PostGIS', async () => {
    const joined = await run(
      `SELECT r."Название региона" AS регион, count(*) AS n
FROM "Происшествия" p JOIN "Регионы" r ON r."Район" = p."Район"
GROUP BY 1 ORDER BY 1`,
    )
    expect(joined.rows.map((row) => [row.регион, Number(row.n)])).toEqual([
      ['Душанбе', 2],
      ['Сино', 2],
      ['Хатлон', 3],
      ['Шохмансур', 2],
    ])
    const ranked = await run(
      `SELECT "Название", rank() OVER (PARTITION BY "Вид" ORDER BY "Ущерб" DESC NULLS LAST) AS место
FROM "Происшествия" WHERE "Вид" = 'flood' ORDER BY 2`,
    )
    expect(ranked.rows.map((row) => [row.Название, Number(row.место)])).toEqual([
      ['Наводнение', 1],
      ['Паводок', 2],
    ])
    expect(
      await count(
        'SELECT count(*) AS n FROM (SELECT "Название" FROM "Происшествия" UNION ALL SELECT "Название" FROM "Архив происшествий") u',
      ),
    ).toBe(12)
    const tags = await run(
      'SELECT метка, count(*) AS n FROM "Происшествия" p, LATERAL unnest(p."Метки") AS метка GROUP BY 1 ORDER BY 1',
    )
    expect(tags.rows.map((row) => [row.метка, Number(row.n)])).toEqual([
      ['night', 3],
      ['test', 2],
      ['urgent', 3],
    ])
    const recursive = await run(
      'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT sum(i) AS s FROM n',
    )
    expect(Number(recursive.rows[0]?.s)).toBe(15)
    const levels = await run(
      `SELECT "Сведения"->>'level' AS уровень, count(*) AS n FROM "Происшествия"
WHERE "Сведения" IS NOT NULL GROUP BY 1 ORDER BY 1`,
    )
    expect(levels.rows.map((row) => [row.уровень, Number(row.n)])).toEqual([
      ['1', 2],
      ['2', 2],
      ['3', 1],
    ])
    const near = await run(
      `SELECT "Название", ST_AsGeoJSON("Место")::json AS место FROM "Происшествия"
WHERE ST_DWithin("Место"::geography, ST_SetSRID(ST_MakePoint(68.78, 38.56), 4326)::geography, 5000)
ORDER BY ST_Distance("Место"::geography, ST_SetSRID(ST_MakePoint(68.78, 38.56), 4326)::geography)`,
    )
    expect(near.rows.map((row) => row.Название)).toEqual(['Пожар на складе', 'Пожар в доме'])
    expect(near.rows[0]?.место).toEqual({ type: 'Point', coordinates: [68.78, 38.56] })
  })

  it('пояс пользователя: даты и время — местные', async () => {
    const { rows } = await run(
      `SELECT to_char("Дата", 'YYYY-MM-DD HH24:MI') AS местное, date_trunc('day', "Дата")::date AS день
FROM "Происшествия" WHERE "Название" = 'Пожар в доме'`,
    )
    const row = rows[0] as Row
    expect(row.местное).toBe('2026-09-18 00:30')
    expect((row.день as Date).toISOString().slice(0, 10)).toBe('2026-09-18')
  })

  it('предел строк: на одну больше, подсчёт — полный', async () => {
    const { rows, count: total } = await run('SELECT * FROM "Происшествия" ORDER BY _id', {
      maxRows: 3,
    })
    expect(rows).toHaveLength(4)
    expect(total).toBe(10)
  })

  it('pg_sleep недостижим: запрос не доходит до базы, а тайм-аут страхует тяжёлые запросы', async () => {
    const variants = [
      'SELECT pg_sleep(30)',
      'SELECT pg_catalog.pg_sleep(30)',
      'SELECT "pg_sleep"(30)',
      'SELECT U&"pg\\005fsleep"(30)',
      'SELECT * FROM pg_sleep(30)',
      "SELECT pg_sleep_for('30 seconds')",
      "SELECT pg_sleep_until(now() + interval '30 seconds')",
      'SELECT count(*) FROM "Происшествия" WHERE pg_sleep(30) IS NULL',
      'SELECT (SELECT pg_sleep(30)) FROM "Происшествия"',
      'WITH s AS (SELECT pg_sleep(30)) SELECT * FROM s',
      'SELECT * FROM "Происшествия" WHERE \'pg_sleep\'::regproc IS NOT NULL',
      'DO $$ BEGIN PERFORM pg_sleep(30); END $$',
      "SELECT query_to_xml('SELECT pg_sleep(30)', true, true, '')",
      "SELECT ts_stat('SELECT pg_sleep(30)')",
    ]
    const started = performance.now()
    for (const sql of variants) {
      await expect(run(sql), sql).rejects.toBeInstanceOf(QueryCompileError)
    }
    // Все отказы — без обращения к базе: ни одного ожидания
    expect(performance.now() - started).toBeLessThan(5_000)

    // Тяжёлый, но разрешённый запрос обрывает statement_timeout роли запросов
    await expect(
      run('SELECT count(*) AS n FROM generate_series(1, 10000000000) AS g', {
        defaultTimeoutMs: 200,
      }),
    ).rejects.toMatchObject({ code: '57014' })
  })

  it('ошибка Postgres при выполнении указывает на место в тексте пользователя', async () => {
    const sql = 'SELECT "Название" + 1 AS x FROM "Происшествия"'
    const compiled = await compileRawSql(sql, sqlCtx(datasets()))
    const error = await db
      .begin('read only', async (tx) => {
        await tx.unsafe('SET LOCAL ROLE kchs_query')
        return tx.unsafe(compiled.sql, compiled.params as never[])
      })
      .then(
        () => null,
        (failure: { code?: string; position?: string }) => failure,
      )
    expect(error?.code).toBe('42883')
    expect(rawSqlErrorPosition(compiled, Number(error?.position))).toBe(sql.indexOf('+'))
  })

  it('переписанный запрос обращается только к таблицам своих датасетов', async () => {
    const { compiled } = await run(
      'SELECT count(*) AS n FROM "Происшествия" p JOIN "Регионы" r ON r."Район" = p."Район"',
    )
    const tables = [...compiled.sql.matchAll(/FROM "(\w+)"\."(\w+)"/g)].map(
      (match) => `${match[1]}.${match[2]}`,
    )
    expect(tables.sort()).toEqual([T.incidents, T.regions].sort())
  })
})
