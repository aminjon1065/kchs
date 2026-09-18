import { describe, expect, it } from 'vitest'
import {
  compileRawSql,
  QueryCompileError,
  type RawSqlContext,
  rawSqlErrorPosition,
  rawSqlTables,
  type SqlDataset,
} from '../src/index.js'
import { FUNCTION_GROUPS, isAllowedFunction, isDeniedFunction } from '../src/sql/allowlist.js'
import {
  extractPlaceholders,
  readIdentifierChain,
  SourcePositions,
  truncateIdent,
} from '../src/sql/text.js'
import { IDS, TERR_KH, USER_ID } from './fixtures.js'
import {
  renderSql,
  sqlArchive,
  sqlCtx,
  sqlIncidents,
  sqlRegions,
  sqlStaff,
  withSqlDatasets,
} from './sql-fixtures.js'

const compile = (sql: string, overrides: Partial<RawSqlContext> = {}) =>
  compileRawSql(sql, sqlCtx(overrides))

async function compileError(
  sql: string,
  overrides: Partial<RawSqlContext> = {},
): Promise<QueryCompileError> {
  try {
    await compile(sql, overrides)
  } catch (error) {
    expect(error).toBeInstanceOf(QueryCompileError)
    return error as QueryCompileError
  }
  throw new Error(`Запрос должен быть отклонён: ${sql}`)
}

/** Сотрудники со скрытыми паспортом и окладом — для атак на политику столбцов. */
const guardedStaff: SqlDataset = {
  ...sqlStaff,
  columnPolicy: { hide: ['passport', 'salary'], mask: ['phone'] },
}
const guarded = withSqlDatasets(sqlCtx().datasets, guardedStaff)

/**
 * «Атакующие» запросы (КП P1-E04 S04): каждый отклоняется при компиляции с
 * понятной причиной и позицией — до базы они не доходят.
 */
const ATTACKS: Array<[sql: string, message: string]> = [
  // pg_sleep в любом виде и месте
  ['SELECT pg_sleep(10)', 'Функция «pg_sleep» запрещена'],
  ['SELECT pg_catalog.pg_sleep(10)', 'Функция «pg_catalog.pg_sleep» запрещена'],
  ['SELECT "pg_sleep"(1)', 'Функция «pg_sleep» запрещена'],
  ['SELECT PG_SLEEP(1)', 'Функция «pg_sleep» запрещена'],
  ['SELECT "PG_SLEEP"(1)', 'Функция «PG_SLEEP» запрещена'],
  ['SELECT U&"pg\\005fsleep"(1)', 'Функция «pg_sleep» запрещена'],
  ['SELECT * FROM pg_sleep(5)', 'Функция «pg_sleep» запрещена'],
  ["SELECT pg_sleep_for('5 minutes')", 'Функция «pg_sleep_for» запрещена'],
  ["SELECT pg_sleep_until(now() + interval '1 hour')", 'Функция «pg_sleep_until» запрещена'],
  ['SELECT 1 FROM "Происшествия" WHERE pg_sleep(1) IS NULL', 'Функция «pg_sleep» запрещена'],
  [
    'SELECT count(*) FILTER (WHERE pg_sleep(1) IS NULL) FROM "Происшествия"',
    'Функция «pg_sleep» запрещена',
  ],
  ['SELECT (SELECT pg_sleep(1))', 'Функция «pg_sleep» запрещена'],
  ['SELECT 1 FROM "Происшествия" ORDER BY pg_sleep(1)', 'Функция «pg_sleep» запрещена'],
  ['SELECT row_number() OVER (ORDER BY pg_sleep(1)) FROM "Происшествия"', 'запрещена'],
  ['VALUES (pg_sleep(1))', 'Функция «pg_sleep» запрещена'],
  [
    'WITH RECURSIVE r AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM r, LATERAL pg_sleep(1) s) SELECT * FROM r',
    'Функция «pg_sleep» запрещена',
  ],
  // Несколько операторов, запись, DDL, служебные команды
  ['SELECT 1; SELECT 2', 'Разрешён только один оператор'],
  ['SELECT 1; DROP TABLE ds.t_incidents', 'Разрешён только один оператор'],
  ['DROP TABLE ds.t_incidents', 'Изменение структуры базы запрещено'],
  ['CREATE TABLE copy AS SELECT * FROM "Происшествия"', 'Изменение структуры базы запрещено'],
  ['DELETE FROM "Происшествия"', 'Изменение данных запрещено (DELETE)'],
  ['INSERT INTO "Происшествия" (title) VALUES (\'x\')', 'Изменение данных запрещено (INSERT)'],
  ['UPDATE "Происшествия" SET title = \'x\'', 'Изменение данных запрещено (UPDATE)'],
  ['TRUNCATE "Происшествия"', 'Изменение данных запрещено (TRUNCATE)'],
  [
    'WITH d AS (DELETE FROM "Происшествия" RETURNING *) SELECT * FROM d',
    'Изменение данных запрещено (DELETE)',
  ],
  ['SELECT * INTO copy FROM "Происшествия"', 'SELECT INTO запрещён'],
  ['SELECT * FROM "Происшествия" FOR UPDATE', 'Блокировки строк'],
  ['SELECT * FROM "Происшествия" FOR SHARE SKIP LOCKED', 'Блокировки строк'],
  ["COPY (SELECT 1) TO '/tmp/x'", 'COPY запрещён'],
  ["COPY ds.t_incidents FROM PROGRAM 'id'", 'COPY запрещён'],
  ['DO $$ BEGIN PERFORM pg_sleep(1); END $$', 'Анонимные блоки кода (DO) запрещены'],
  ['CALL cleanup()', 'Вызов процедур (CALL) запрещён'],
  ['SET statement_timeout = 0', 'Изменение настроек сеанса'],
  ['SET ROLE kchs_app', 'Изменение настроек сеанса'],
  ['EXPLAIN ANALYZE SELECT * FROM "Происшествия"', 'EXPLAIN запрещён'],
  ['LOCK TABLE ds.t_incidents', 'Блокировка таблиц (LOCK) запрещена'],
  ['GRANT SELECT ON ALL TABLES IN SCHEMA ds TO PUBLIC', 'Выдача и отзыв прав'],
  ['PREPARE p AS SELECT 1', 'Подготовленные операторы'],
  ['BEGIN', 'Управление транзакциями запрещено'],
  // Системные каталоги, схемы и физические таблицы
  ['SELECT * FROM pg_catalog.pg_authid', 'Обращение к схеме «pg_catalog» запрещено'],
  ['SELECT * FROM information_schema.tables', 'Обращение к схеме «information_schema» запрещено'],
  ['SELECT * FROM ds.t_incidents', 'Обращение к схеме «ds» запрещено'],
  ['SELECT * FROM public.users', 'Обращение к схеме «public» запрещено'],
  ['SELECT * FROM pg_shadow', 'Нет датасета «pg_shadow»'],
  ['SELECT * FROM pg_stat_activity', 'Нет датасета «pg_stat_activity»'],
  ['SELECT * FROM t_incidents', 'Нет датасета «t_incidents»'],
  ['TABLE pg_authid', 'Вместо «TABLE имя» напишите «SELECT * FROM имя»'],
  ['SELECT (SELECT count(*) FROM pg_class)', 'Нет датасета «pg_class»'],
  [
    'SELECT * FROM "Происшествия" p JOIN pg_catalog.pg_roles r ON true',
    'Обращение к схеме «pg_catalog» запрещено',
  ],
  ['SELECT * FROM "Происшествия" TABLESAMPLE SYSTEM (10)', 'TABLESAMPLE не поддерживается'],
  // CTE не открывает обход: имя CTE не выходит из своей области, тело проверяется
  [
    'WITH "Происшествия" AS (SELECT * FROM pg_class) SELECT * FROM "Происшествия"',
    'Нет датасета «pg_class»',
  ],
  [
    'SELECT * FROM (WITH t_incidents AS (SELECT 1) SELECT 1) s, t_incidents',
    'Нет датасета «t_incidents»',
  ],
  ['SELECT * FROM "Происшествия" LIMIT (SELECT count(*) FROM pg_class)', 'Нет датасета «pg_class»'],
  [
    'SELECT "pg_catalog".pg_class FROM "Происшествия" AS "pg_catalog"',
    'Нет поля «pg_catalog.pg_class»',
  ],
  ['SELECT p.lower(title) FROM "Происшествия" p', 'функции других схем запрещены'],
  [
    'SELECT * FROM jsonb_to_record(\'{"a": 1}\') AS r(a int, b regclass)',
    'Приведение к типу «regclass» запрещено',
  ],
  // Опасные и служебные функции
  ["SELECT current_setting('is_superuser')", 'Функция «current_setting» запрещена'],
  ["SELECT set_config('statement_timeout', '0', false)", 'Функция «set_config» запрещена'],
  ["SELECT dblink('host=evil', 'select 1')", 'Функция «dblink» запрещена'],
  ["SELECT lo_import('/etc/passwd')", 'Функция «lo_import» запрещена'],
  ["SELECT pg_read_file('/etc/passwd')", 'Функция «pg_read_file» запрещена'],
  ["SELECT pg_ls_dir('.')", 'Функция «pg_ls_dir» запрещена'],
  ['SELECT pg_stat_get_backend_pid(1)', 'Функция «pg_stat_get_backend_pid» запрещена'],
  ['SELECT txid_current()', 'Функция «txid_current» запрещена'],
  ['SELECT pg_advisory_lock(42)', 'Функция «pg_advisory_lock» запрещена'],
  ['SELECT pg_terminate_backend(1)', 'Функция «pg_terminate_backend» запрещена'],
  ['SELECT pg_cancel_backend(1)', 'Функция «pg_cancel_backend» запрещена'],
  ["SELECT nextval('seq')", 'Функция «nextval» запрещена'],
  ["SELECT setval('seq', 1)", 'Функция «setval» запрещена'],
  ["SELECT query_to_xml('select 1', true, true, '')", 'Функция «query_to_xml» запрещена'],
  ["SELECT ts_stat('select 1')", 'Функция «ts_stat» запрещена'],
  ['SELECT version()', 'Функция «version» запрещена'],
  ["SELECT to_regclass('ds.t_incidents')", 'Функция «to_regclass» запрещена'],
  ["SELECT has_table_privilege('ds.t_incidents', 'select')", 'запрещена'],
  [
    "SELECT st_estimatedextent('ds', 't_incidents', 'c_11')",
    'Функция «st_estimatedextent» запрещена',
  ],
  ["SELECT public.lower('x')", 'функции других схем запрещены'],
  ['SELECT evil_function()', 'Функция «evil_function» недоступна в SQL-лаборатории'],
  // Приведения к reg*-типам и прочим служебным типам
  ["SELECT 'ds.t_incidents'::regclass", 'Приведение к типу «regclass» запрещено'],
  ["SELECT 'pg_sleep'::regproc::oid", 'Приведение к типу «regproc» запрещено'],
  ["SELECT CAST('ds' AS regnamespace)", 'Приведение к типу «regnamespace» запрещено'],
  ['SELECT NULL::pg_catalog.pg_class', 'Приведение к типу «pg_class» запрещено'],
  ["SELECT '<a/>'::xml", 'Приведение к типу «xml» запрещено'],
  // Служебные значения, XML, операторы со схемой, позиционные параметры
  ['SELECT current_user', 'Системная функция «CURRENT_USER» недоступна'],
  ['SELECT session_user', 'Системная функция «SESSION_USER» недоступна'],
  ["SELECT xmlparse(document '<a/>')", 'XML в запросах не поддерживается'],
  ['SELECT 1 OPERATOR(pg_catalog.+) 1', 'OPERATOR(схема.оператор) не поддерживается'],
  ['SELECT * FROM "Происшествия" WHERE title = $1', 'Параметры записываются как {{имя}}'],
  // Скрытые политикой и служебные столбцы
  ['SELECT "Паспорт" FROM "Сотрудники"', 'Нет доступа к полю «passport»'],
  ['SELECT s.salary FROM "Сотрудники" s', 'Нет доступа к полю «salary»'],
  ['SELECT count(*) FROM "Сотрудники" WHERE "Оклад" > 100000', 'Нет доступа к полю «salary»'],
  [
    'SELECT (SELECT max(passport) FROM "Сотрудники") FROM "Происшествия"',
    'Нет доступа к полю «passport»',
  ],
  [
    'WITH x AS (SELECT * FROM "Сотрудники") SELECT "Паспорт" FROM x',
    'Нет доступа к полю «passport»',
  ],
  ['SELECT * FROM "Происшествия" WHERE _deleted_at IS NOT NULL', 'Нет поля «_deleted_at»'],
  ['SELECT xmin, ctid FROM "Происшествия"', 'Нет поля «xmin»'],
  ['SELECT "Происшествия".tableoid FROM "Происшествия"', 'Нет поля «Происшествия.tableoid»'],
]

describe('сырой SQL: атакующие запросы отклоняются', () => {
  it('атак не меньше 30', () => {
    expect(ATTACKS.length).toBeGreaterThanOrEqual(30)
  })

  it.each(ATTACKS)('%s', async (sql, message) => {
    const error = await compileError(sql, guarded)
    const issue = error.issues[0]
    expect(issue?.message).toContain(message)
    expect(issue?.path).toEqual(['sql'])
    expect(issue?.position).toBeTypeOf('number')
  })

  it('чёрный список обязательных функций и белый список не пересекаются', () => {
    for (const name of [
      'pg_sleep',
      'pg_sleep_for',
      'pg_sleep_until',
      'set_config',
      'current_setting',
      'dblink',
      'dblink_exec',
      'lo_import',
      'lo_export',
      'pg_read_file',
      'pg_read_binary_file',
      'pg_ls_dir',
      'pg_stat_file',
      'pg_stat_get_activity',
      'txid_current',
      'pg_advisory_lock',
      'pg_advisory_xact_lock',
      'pg_terminate_backend',
      'pg_cancel_backend',
      'nextval',
      'setval',
      'query_to_xml',
      'table_to_xml',
    ]) {
      expect(isDeniedFunction(name), name).toBe(true)
      expect(isAllowedFunction(name), name).toBe(false)
    }
    for (const name of Object.values(FUNCTION_GROUPS).flat()) {
      expect(isDeniedFunction(name), name).toBe(false)
    }
  })
})

describe('сырой SQL: эталоны переписывания', () => {
  const golden: Array<[title: string, sql: string, overrides?: Partial<RawSqlContext>]> = [
    [
      'подпись поля и название датасета (пример из бэклога)',
      'SELECT "Район", count(*) FROM "Происшествия" GROUP BY 1',
    ],
    [
      'ключи и подписи, имя таблицы без кавычек, алиас',
      'SELECT p.title, p."Ущерб" FROM Происшествия p WHERE p."Вид" = \'fire\' ORDER BY p._id',
    ],
    [
      'соединение датасетов и параметр с объявленным типом',
      `SELECT r."Название региона" AS регион, sum(p."Ущерб") AS ущерб
FROM "Происшествия" p JOIN "Регионы" r ON r."Район" = p."Район"
WHERE p."Дата" >= {{с}}
GROUP BY 1
ORDER BY 2 DESC`,
      { paramDefs: { с: { type: 'date', required: true } }, params: { с: '2026-01-01' } },
    ],
    [
      'CTE и оконная функция: имена CTE — служебные',
      `WITH по_видам AS (SELECT "Вид", count(*) AS n FROM "Происшествия" GROUP BY 1)
SELECT "Вид", n, rank() OVER (ORDER BY n DESC) FROM по_видам`,
    ],
    [
      'рекурсивный CTE',
      'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT i FROM n',
    ],
    [
      'объединение двух датасетов',
      `SELECT "Название", "Ущерб" FROM "Происшествия"
UNION ALL
SELECT "Название", "Ущерб" FROM "Архив происшествий"
ORDER BY 2 DESC`,
    ],
    [
      'EXISTS и IN с подзапросами к датасетам',
      `SELECT "Название" FROM "Происшествия" p
WHERE EXISTS (SELECT 1 FROM "Регионы" r WHERE r."Район" = p."Район" AND r."Население" > 500000)
  AND p."Вид" IN (SELECT "Вид" FROM "Архив происшествий")`,
    ],
    [
      'LATERAL и unnest списка',
      'SELECT p."Название", метка FROM "Происшествия" p, LATERAL unnest(p."Метки") AS метка',
    ],
    [
      'политики строк и маски — внутри подзапроса',
      'SELECT "ФИО", "Оклад", "Телефон" FROM "Сотрудники" WHERE "Подразделение" = {{unit}}',
      {
        ...withSqlDatasets(sqlCtx().datasets, {
          ...sqlStaff,
          rowPolicy: { kind: 'filter', where: { field: 'unit_id', op: 'in_my_unit' } },
          columnPolicy: { hide: ['passport'], mask: ['salary', 'phone'] },
        }),
        params: { unit: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' },
      },
    ],
    [
      'JSON и PostGIS',
      `SELECT "Сведения"->>'level' AS уровень, ST_AsGeoJSON("Место") AS место
FROM "Происшествия"
WHERE ST_DWithin("Место"::geography, ST_SetSRID(ST_MakePoint(68.78, 38.56), 4326)::geography, 1000)`,
    ],
    [
      'VALUES и левое соединение',
      `SELECT v.kind, v.label, count(p._id) AS n
FROM (VALUES ('fire', 'Пожар'), ('flood', 'Паводок')) AS v(kind, label)
LEFT JOIN "Происшествия" p ON p."Вид" = v.kind
GROUP BY 1, 2`,
    ],
    [
      'список-параметр и повтор параметра',
      `SELECT count(*) FROM "Происшествия"
WHERE "Вид" = ANY({{виды}}) AND ("Пострадавшие" >= {{минимум}} OR {{минимум}} IS NULL)`,
      {
        paramDefs: {
          виды: { type: 'list', required: false },
          минимум: { type: 'number', required: false },
        },
        params: { виды: ['fire', 'flood'] },
      },
    ],
    [
      'DISTINCT и ORDER BY по имени результата',
      'SELECT DISTINCT "Вид" FROM "Происшествия" ORDER BY "Вид"',
    ],
    [
      'регистр и подписи на других языках',
      'select название, "Title", "Damage" from происшествия where "Ном" is not null',
    ],
    ['звёздочка: только видимые поля', 'SELECT * FROM "Регионы"'],
    [
      'подзапрос-значение, FILTER и WITHIN GROUP',
      `SELECT count(*) FILTER (WHERE "Подтверждено") AS подтверждено,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY "Ущерб") AS медиана,
  (SELECT max("Ущерб") FROM "Архив происшествий") AS рекорд
FROM "Происшествия"`,
    ],
    [
      'ROLLUP и самосоединение',
      `SELECT a."Вид", b."Район", count(*)
FROM "Происшествия" a JOIN "Происшествия" b ON a."Код" = b."Код"
GROUP BY ROLLUP (a."Вид", b."Район")`,
    ],
    [
      'политика-выражение и строки в кавычках не трогаются',
      `SELECT "Название" FROM "Происшествия"
WHERE "Заметки" <> '{{не параметр}}' -- {{и это}}
  AND "Код" <> $$"Район"$$`,
      withSqlDatasets(sqlCtx().datasets, {
        ...sqlIncidents,
        rowPolicy: { kind: 'expr', expr: "territory_id in (@my_territories) or kind = 'fire'" },
      }),
    ],
  ]

  it.each(golden)('%s', async (_title, sql, overrides) => {
    expect(renderSql(await compile(sql, overrides))).toMatchSnapshot()
  })

  it('каждый параметр упомянут в SQL, значения пользователя в текст не попадают', async () => {
    const compiled = await compile(
      'SELECT * FROM "Происшествия" WHERE "Название" = {{t}} OR "Код" = {{t}} OR "Заметки" = {{n}}',
      { params: { t: "'; DROP TABLE ds.t_incidents; --", n: 'x' } },
    )
    compiled.params.forEach((_, index) => {
      expect(compiled.sql).toContain(`$${index + 1}`)
    })
    expect(compiled.params).toEqual(["'; DROP TABLE ds.t_incidents; --", 'x'])
    expect(compiled.sql).not.toContain('DROP TABLE')
    expect(compiled.countSql).toContain('SELECT count(*) AS "count" FROM (')
    expect(compiled.countParams).toEqual(compiled.params)
  })
})

describe('сырой SQL: столбцы результата, кэш, режимы', () => {
  it('поля результата: подписи сохраняют имя, описание — из схемы', async () => {
    const compiled = await compile(
      'SELECT "Вид", title AS название, count(*) AS n, "Ущерб"::int FROM "Происшествия" GROUP BY 1, 2, 4',
    )
    expect(compiled.fields).toEqual([
      { name: 'Вид', field: expect.objectContaining({ name: 'Вид', type: 'select' }) },
      { name: 'название', field: expect.objectContaining({ name: 'название', type: 'text' }) },
      { name: 'n', field: null },
      // Выражение от переписанной подписи получает имя ключа (как назовёт Postgres)
      { name: 'damage', field: null },
    ])
  })

  it('подписи работают и через звёздочку CTE и подзапросов; точные имена важнее', async () => {
    const cte = await compile(
      'WITH x AS (SELECT * FROM "Происшествия") SELECT x."Вид", "Район" FROM x',
    )
    expect(cte.sql).toContain(
      'SELECT x."kind" AS "Вид", "territory_id" AS "Район" FROM "__kchs_cte_0" AS "x"',
    )
    expect(cte.fields?.map((field) => field.field?.type)).toEqual(['select', 'territory'])
    const exact = await compile(
      'SELECT "Вид" FROM (SELECT *, \'свой\' AS "Вид" FROM "Происшествия") s',
    )
    expect(exact.sql).toContain('SELECT "Вид" FROM (SELECT *')
  })

  it('карта участков: позиция в итоговом SQL → позиция в тексте пользователя', async () => {
    const sql = 'SELECT "Вид", count(*) FROM "Происшествия" WHERE "Ущерб" > {{min}} GROUP BY 1'
    const compiled = await compile(sql, { params: { min: 1 } })
    // Позиции Postgres — с 1, в символах итогового SQL
    const at = (fragment: string) => compiled.sql.indexOf(fragment) + 1
    expect(rawSqlErrorPosition(compiled, at('count(*)'))).toBe(sql.indexOf('count(*)'))
    expect(rawSqlErrorPosition(compiled, at('GROUP BY'))).toBe(sql.indexOf('GROUP BY'))
    // Подстановки — на начало заменённого имени, параметра, таблицы
    expect(rawSqlErrorPosition(compiled, at('"kind"'))).toBe(sql.indexOf('"Вид"'))
    expect(rawSqlErrorPosition(compiled, at('($1)'))).toBe(sql.indexOf('{{min}}'))
    expect(rawSqlErrorPosition(compiled, at('"ds"."t_incidents"'))).toBe(
      sql.indexOf('"Происшествия"'),
    )
    // Обёртка — вне текста пользователя
    expect(rawSqlErrorPosition(compiled, 1)).toBeNull()
  })

  it('звёздочка над подзапросом неизвестной формы — поля после выполнения', async () => {
    const compiled = await compile('SELECT * FROM generate_series(1, 3) AS g')
    expect(compiled.fields).toBeNull()
  })

  it('ключ кэша: версии и политики датасетов, момент — если есть now()', async () => {
    const plain = await compile('SELECT count(*) FROM "Происшествия"')
    expect(plain.cacheKeyParts.datasets).toEqual([
      expect.objectContaining({ id: IDS.incidents, version: 7 }),
    ])
    expect(plain.cacheKeyParts.time).toBeNull()
    expect(plain.cacheable).toBe(true)
    expect(plain.datasets).toEqual([IDS.incidents])
    const timed = await compile('SELECT count(*) FROM "Происшествия" WHERE "Дата" > now()')
    expect(timed.cacheKeyParts.time).toBe('2026-09-18T07:30')
    const random = await compile('SELECT random()')
    expect(random.cacheable).toBe(false)
    const policy = await compile(
      'SELECT count(*) FROM "Происшествия"',
      withSqlDatasets(sqlCtx().datasets, { ...sqlIncidents, rowPolicy: { kind: 'none' } }),
    )
    expect(policy.cacheKeyParts.datasets[0]?.policy).not.toBe(
      plain.cacheKeyParts.datasets[0]?.policy,
    )
  })

  it('предел строк: LIMIT на одну больше; без предела — без LIMIT', async () => {
    expect((await compile('SELECT 1', { maxRows: 10 })).sql).toMatch(/LIMIT 11$/)
    expect((await compile('SELECT 1', { maxRows: null })).sql).not.toContain('LIMIT')
    expect((await compile('SELECT 1', { defaultTimeoutMs: 5000 })).timeoutMs).toBe(5000)
  })

  it('системные столбцы — только упомянутые', async () => {
    const plain = await compile('SELECT * FROM "Регионы"')
    expect(plain.sql).not.toContain('"_id"')
    const withId = await compile('SELECT *, _ver FROM "Регионы" ORDER BY _id')
    expect(withId.sql).toContain('SELECT "_id", "_ver", "c_1" AS "territory_id"')
  })

  it('датасет без доступа в контексте — как несуществующий', async () => {
    const error = await compileError('SELECT * FROM "Сотрудники"', {
      datasets: [sqlIncidents, sqlRegions, sqlArchive],
    })
    expect(error.issues[0]?.message).toBe('Нет датасета «Сотрудники» или нет доступа к нему')
  })
})

describe('сырой SQL: понятные ошибки с позицией', () => {
  it('синтаксис: позиция в символах строки (кириллица)', async () => {
    const sql = 'SELECT "Район" FROM "Происшествия" WHER "Вид" = 1'
    const error = await compileError(sql)
    const issue = error.issues[0]
    expect(issue?.message).toBe('Синтаксическая ошибка рядом с «"Вид"»')
    expect(issue?.position).toBe(sql.indexOf('"Вид"'))
  })

  it('синтаксис: обрыв, незакрытые строки и имена', async () => {
    expect((await compileError('SELECT "Район" FROM')).issues[0]?.message).toBe(
      'Синтаксическая ошибка: запрос обрывается',
    )
    expect((await compileError("SELECT 'abc")).issues[0]?.message).toBe(
      'Не закрыта строка в одинарных кавычках',
    )
    expect((await compileError('SELECT "Район FROM x')).issues[0]?.message).toBe(
      'Не закрыто имя в двойных кавычках',
    )
  })

  it('неизвестные датасет и поле — с подсказкой', async () => {
    const table = await compileError('SELECT * FROM "Происшествие"')
    expect(table.issues[0]).toMatchObject({
      message: 'Нет датасета «Происшествие» или нет доступа к нему',
      hint: 'Возможно, имелось в виду: "Происшествия"',
      position: 14,
    })
    const field = await compileError('SELECT "Районн" FROM "Происшествия"')
    expect(field.issues[0]).toMatchObject({
      message: 'Нет поля «Районн»',
      hint: expect.stringContaining('Район'),
      position: 7,
    })
  })

  it('неоднозначное поле, вычисляемое поле, одинаковые подписи', async () => {
    const ambiguous = await compileError(
      'SELECT "Название" FROM "Происшествия" p, "Архив происшествий" a',
    )
    expect(ambiguous.issues[0]).toMatchObject({
      message: 'Поле «Название» неоднозначно',
      hint: 'Укажите таблицу: p.Название или a.Название',
    })
    expect((await compileError('SELECT "Оценка" FROM "Происшествия"')).issues[0]?.message).toBe(
      'Поле «score_formula» вычисляемое — в запросах к данным оно пока недоступно',
    )
    const twins = withSqlDatasets(sqlCtx().datasets, {
      ...sqlRegions,
      fields: sqlRegions.fields.map((field) =>
        field.key === 'population' ? { ...field, label: { ru: 'Район' } } : field,
      ),
    })
    expect((await compileError('SELECT "Район" FROM "Регионы"', twins)).issues[0]).toMatchObject({
      message: 'Подпись «Район» у нескольких полей',
      hint: 'Укажите ключ поля: territory_id, population',
    })
  })

  it('параметры: обязательный, неизвестный, запись и имя', async () => {
    const sql = 'SELECT * FROM "Происшествия" WHERE "Вид" = {{вид}}'
    const required = await compileError(sql, {
      paramDefs: { вид: { type: 'text', required: true } },
    })
    expect(required.issues[0]).toMatchObject({
      message: 'Не задан обязательный параметр «вид»',
      position: sql.indexOf('{{'),
    })
    expect((await compileError('SELECT {{нет}}')).issues[0]?.message).toBe(
      'Неизвестный параметр «нет»',
    )
    expect((await compileError('SELECT {{1a}}')).issues[0]?.message).toBe(
      'Параметр записывается как {{имя}}',
    )
    expect((await compileError('SELECT x{{a}}', { params: { a: 1 } })).issues[0]?.message).toBe(
      'Параметр {{a}} не распознан',
    )
  })

  it('пустой запрос, ONLY, USING с подписью, алиас со столбцами', async () => {
    expect((await compileError('  -- только комментарий')).issues[0]?.message).toBe(
      'Пустой запрос: напишите SELECT',
    )
    expect((await compileError('SELECT * FROM ONLY "Происшествия"')).issues[0]?.message).toBe(
      'ONLY не поддерживается',
    )
    expect(
      (await compileError('SELECT * FROM "Происшествия" JOIN "Регионы" USING ("Район")')).issues[0]
        ?.message,
    ).toBe('В USING укажите ключ поля «territory_id», а не подпись «Район»')
    expect((await compileError('SELECT * FROM "Регионы" AS r(a, b)')).issues[0]?.message).toBe(
      'Переименование столбцов датасета в алиасе не поддерживается',
    )
  })

  it('имя таблицы в форме U&"…" не переписывается — просим обычные кавычки', async () => {
    const error = await compileError('SELECT * FROM U&"\\0420\\0435\\0433\\0438\\043e\\043d\\044b"')
    expect(error.issues[0]).toMatchObject({
      message: 'Не удалось прочитать имя таблицы: используйте обычные двойные кавычки',
      position: 14,
    })
  })

  it('недопустимые символы и длина', async () => {
    expect(
      (await compileError(`SELECT 1${String.fromCharCode(0)}; DROP TABLE x`)).issues[0],
    ).toMatchObject({
      message: 'Недопустимый символ в запросе',
      position: 8,
    })
    expect((await compileError(`SELECT ${'1 + '.repeat(30_000)}1`)).issues[0]?.message).toBe(
      'Запрос длиннее 100 000 символов',
    )
  })

  it('слишком глубокая вложенность — понятная ошибка, разборщик остаётся рабочим', async () => {
    expect((await compileError(`SELECT ${'1+'.repeat(20_000)}1`)).issues[0]?.message).toBe(
      'Запрос слишком сложный: уменьшите вложенность выражений и подзапросов',
    )
    expect(
      (await compileError(`SELECT ${'('.repeat(10_000)}1${')'.repeat(10_000)}`)).issues[0]?.message,
    ).toBe('Запрос слишком сложный: уменьшите вложенность выражений и подзапросов')
    expect((await compile('SELECT 1')).sql).toContain('SELECT 1')
  })

  it('разбор параметров линеен: длинные последовательности $ и { не тормозят', async () => {
    const started = performance.now()
    await compileError(`SELECT ${'$ '.repeat(45_000)}`)
    await compileError(`SELECT 1 ${'{ '.repeat(45_000)}`)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe('сырой SQL: имена таблиц для загрузки датасетов', () => {
  it('таблицы без CTE — в порядке появления', async () => {
    expect(
      await rawSqlTables(
        'WITH x AS (SELECT * FROM "Происшествия") SELECT * FROM x, Регионы r JOIN "Сотрудники" s ON true',
      ),
    ).toEqual(['Происшествия', 'Регионы', 'Сотрудники'])
  })

  it('запрос проверяется и при сборе имён', async () => {
    await expect(rawSqlTables('SELECT pg_sleep(1) FROM x')).rejects.toThrow(
      'Функция «pg_sleep» запрещена',
    )
  })
})

describe('сырой SQL: лексические помощники', () => {
  it('параметры вне строк, имён и комментариев; длина текста сохраняется', () => {
    const sql = `SELECT {{a}}, '{{b}}', "{{c}}", E'\\'{{d}}', $x$ {{e}} $x$ -- {{f}}
/* {{g}} /* {{h}} */ */ {{ i }}`
    const { text, placeholders } = extractPlaceholders(sql)
    expect(placeholders.map((item) => item.name)).toEqual(['a', 'i'])
    expect(text).toHaveLength(sql.length)
    expect(text).toBe(sql.replace('{{a}}', '$1   ').replace('{{ i }}', '$2     '))
  })

  it('позиции разборщика: байты UTF-8 и кодовые точки → индексы строки', () => {
    const text = 'SELECT "Район", 😀 FROM x'
    const positions = new SourcePositions(text)
    expect(positions.fromByte(Buffer.byteLength('SELECT "Район", '))).toBe(16)
    expect(positions.fromByte(Buffer.byteLength('SELECT "Район", 😀 '))).toBe(19)
    expect(positions.fromCodePoint(18)).toBe(19)
  })

  it('длинные имена усекаются как в Postgres (63 байта)', async () => {
    const name = 'Сведения о чрезвычайных ситуациях природного характера'
    expect(Buffer.byteLength(truncateIdent(name))).toBeLessThanOrEqual(63)
    const long = withSqlDatasets(sqlCtx().datasets, { ...sqlRegions, name })
    const compiled = await compile(`SELECT count(*) FROM "${name}"`, long)
    expect(compiled.datasets).toEqual([IDS.regions])
  })

  it('цепочка имён с комментариями и пробелами', () => {
    expect(readIdentifierChain('p /* x */ . "Район"', 0, 2)?.map((part) => part.value)).toEqual([
      'p',
      'Район',
    ])
  })
})

describe('сырой SQL: контекст пользователя в политиках', () => {
  it('макросы политики — значения пользователя, а не текст', async () => {
    const compiled = await compile(
      'SELECT count(*) FROM "Происшествия"',
      withSqlDatasets(sqlCtx().datasets, {
        ...sqlIncidents,
        rowPolicy: {
          kind: 'filter',
          where: {
            or: [
              { field: 'assignee', op: 'is_me' },
              { field: 'territory_id', op: 'eq', value: TERR_KH },
            ],
          },
        },
      }),
    )
    expect(compiled.params).toEqual([USER_ID, TERR_KH])
    expect(compiled.cacheKeyParts.user).toEqual({ id: USER_ID })
  })
})
