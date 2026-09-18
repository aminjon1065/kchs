# @kchs/query

Язык выражений, компилятор QuerySpec → SQL (P1-E04 S01–S03;
`docs/contracts/query-spec.md`, `docs/02-architecture/06-analytics-engine.md` §5)
и сырой SQL SQL-лаборатории (P1-E04 S04, §6 — раздел «Сырой SQL» ниже).
Один компилятор обслуживает таблицу датасета, исследование, графики, показатели,
экспорт и API. Пакет чистый: без базы и сети, зависит от `@kchs/contracts` и
разборщика Postgres `libpg-query` (только для сырого SQL).
Вызывающий (модуль `data` API) загружает датасеты с политиками текущего
пользователя, компилирует спецификацию и выполняет SQL под ролью `kchs_query`.

## Как вызывать

```ts
import { cacheKeyText, collectSources, compileQuery, QueryCompileError } from '@kchs/query'

// 1. Какие источники загрузить (датасеты, сохранённые запросы, системные)
const { datasets, queries, system, sql: needsSqlLab } = collectSources(spec, savedQueries)

// 2. Компиляция: датасеты уже с политиками пользователя (ResolvedDataset)
const compiled = compileQuery(spec, {
  datasets,               // Map<id, ResolvedDataset>
  queries: savedQueries,  // Map<id, QuerySpec> — источники kind: 'query'
  user: { id, unitIds, territoryIds, subordinateIds, attributes, unitMemberIds },
  params,                 // значения @param:<name>
  now: new Date(),
  territoryDescendants,   // id → [id, ...потомки] для within с includeChildren
  rowMeta: true,          // таблица датасета: _id и _ver в результате
})

// 3. Выполнение: роль kchs_query, только чтение, тайм-аут
await sql.begin('read only', async (tx) => {
  await tx.unsafe('SET LOCAL ROLE kchs_query')
  await tx.unsafe(`SET LOCAL statement_timeout = ${compiled.timeoutMs}`)
  const rows = await tx.unsafe(compiled.sql, compiled.params)
  const truncated = compiled.maxRows !== null && rows.length > compiled.maxRows
  const [{ count }] = await tx.unsafe(compiled.countSql, compiled.countParams)
})

// 4. Кэш результата: sha256(cacheKeyText(compiled.cacheKeyParts))
```

Ошибки спецификации — `QueryCompileError` со списком `issues: QueryIssue[]`
(`path` в спецификации, `message`, для выражений — `position` и `hint`); их
API отдаёт как 400/422. Любое другое исключение — ошибка программиста (неверное
физическое имя столбца или таблицы в `ResolvedDataset`, отрицательный `maxRows`).

## Публичный API

| Экспорт | Сигнатура |
|---|---|
| `compileQuery` | `(spec: QuerySpec, ctx: CompileContext) => CompiledQuery` |
| `collectSources` | `(spec: QuerySpec, queries?: ReadonlyMap<string, QuerySpec>) => CollectedSources` |
| `cacheKeyText` | `(parts: CacheKeyParts) => string` — канонический JSON для хэша |
| `checkExpression` | `(source: string, input: ExpressionCheck) => ExpressionCheckResult` — проверка выражения без SQL (вычисляемые поля, политики, показатели) |
| `parseExpression` | `(source: string) => Expr` |
| `compileExpression`, `compileCondition` | `(source: string, env: ExprEnv) => CompiledExpr` — выражение в SQL в своём окружении |
| `QueryCompileError`, `ExpressionError` | ошибки компиляции и выражения |
| `compileRawSql` | `(sql: string, ctx: RawSqlContext) => Promise<CompiledRawSql>` — сырой SQL лаборатории |
| `rawSqlTables` | `(sql: string) => Promise<string[]>` — имена таблиц запроса (кроме CTE) для загрузки датасетов |
| `rawSqlErrorPosition` | `(compiled: CompiledRawSql, position: number) => number \| null` — позиция ошибки Postgres → место в тексте пользователя |
| `postgresDialect`, `Dialect`, `ParamBinder` | диалект (DuckDB — фаза 5) и параметры `$n` |
| `DEFAULT_MAX_ROWS` (50 000), `DEFAULT_TIMEOUT_MS` (30 000), `DEFAULT_TIMEZONE` (`Asia/Dushanbe`) | значения по умолчанию |

`CompiledQuery`: `sql`, `params`, `fields: QueryResultField[]`, `countSql`,
`countParams`, `maxRows`, `timeoutMs`, `cacheKeyParts`. Основной запрос
ограничен `LIMIT maxRows + 1` (строк больше `maxRows` — результат обрезан);
`countSql` считает строки спецификации без завершающих `sort`, `limit`,
`select`, `compute`, `window`.

## Источники и политики доступа

Каждый источник-датасет (основной, соединения, объединения, внутри сохранённых
запросов) — отдельный CTE с политиками пользователя (03-access-model.md):

```sql
"q0" AS (
  SELECT "_id", "_ver", …, "c_1" AS "title", <маска>(c_3) AS "damage", …
  FROM "ds"."t_…"
  WHERE "_deleted_at" IS NULL AND <политика строк>
  OFFSET 0
)
```

- **Политика строк** — `{kind: 'all' | 'none'}`, `{kind: 'filter', where: FilterNode}`
  (формат общего фильтра; несколько политик вызывающий объединяет через `or`)
  или `{kind: 'expr', expr}` (язык выражений; атрибуты — `user_attr('…')` и
  макросы). В политике доступны и скрытые поля; параметры запроса — нет.
- **Барьер оптимизатора** `OFFSET 0` у подзапроса с политикой: условия
  пользователя не опускаются ниже политики и не вычисляются на чужих строках
  (иначе ошибка в выражении на скрытой строке раскрыла бы её значение).
  Цена — условия пользователя не используют индексы под политикой; для
  `all`/`none` барьера нет.
- **Скрытые поля** не выбираются; ссылка на них — ошибка «Нет доступа к полю».
  Вычисляемые поля схемы (`formula`, `lookup`, `rollup`) пока недоступны.
- **Маски** сохраняют тип значения, поэтому фильтр, сортировка и сводка работают
  по маске, а не по исходным данным:

| Тип поля | Маска |
|---|---|
| `identifier`, `phone` | `***` + последние 4 символа (если в значении ≥ 8 символов, иначе `***`) |
| `email` | `***@домен` |
| `text`, `long_text`, `select`, `url` | `***` |
| `integer`, `decimal`, `money`, `number`, `percent`, `duration` | округление до 2 значащих цифр (123 456 → 120 000); NaN/∞ → пусто |
| `date`, `datetime` | начало года (в поясе запроса) |
| остальные (`boolean`, `time`, ссылки, `geometry`, `json`, `multi_select`) | пусто |

Другие источники: `inline` — `VALUES` с параметрами (типы по значениям),
`query` — сохранённый запрос подзапросом (вложенность ≤ 4, циклы — ошибка),
`system` — `ctx.systemDatasets` (представления, подготовленные вызывающим),
`sql` — ошибка: сырой SQL компилирует `compileRawSql` (раздел «Сырой SQL»).

## Типы значений

`number`, `text`, `boolean`, `date`, `datetime`, `time`, `uuid` (пользователь,
подразделение, территория, объект, файл), `geometry`, `json`, `text[]`
(множественный выбор). **Длительность** в запросах — число минут: столбец
`interval` читается как `extract(epoch …) / 60`. Неявные приведения только
безопасные: пусто → любой тип, дата → дата и время (полночь в поясе запроса),
строка → ссылка (`pg_input_is_valid`, неверная — пусто), строковый литерал рядом
с датой/временем/ссылкой — в их тип с проверкой формата при компиляции.

## Фильтры

Операторы по типам — contracts/field-types.md (с запасом: `lt…gte` и для дат,
`in` для дат и времени). Семантика:

- `neq`, `not_in`, `not_contains` и `not` включают строки с пустым значением
  (`IS DISTINCT FROM`, `(x IS NULL OR NOT …)`, `(…) IS NOT TRUE`); `eq null` —
  `IS NULL`; `in [..., null]` — ещё и пустые.
- `contains`, `starts_with`, `ends_with` — `ILIKE` без учёта регистра, `%`, `_`,
  `\` в значении экранируются; `regex` — `~*`, не длиннее 500 символов.
- `is_empty` для текста — пусто или `''`, для списка — пусто или `{}`, для
  геометрии — пусто или `ST_IsEmpty`.
- Дата и время: значение-дата означает **местный день** в поясе запроса
  (`ctx.timezone`, по умолчанию `Asia/Dushanbe`): `eq '2026-09-18'` —
  `[00:00, 24:00)` местного дня, `before` — раньше его начала, `after` — с
  начала следующего; время без смещения — местное, с `Z`/`+05:00` — момент.
- `relative {unit, from, to}` — от начала единицы `from` до конца единицы `to`
  относительно `ctx.now` в поясе запроса (неделя — с понедельника).
- `within` для территории — список идентификаторов с потомками из
  `ctx.territoryDescendants` (без функции — ошибка; `includeChildren: false` —
  без потомков); для геометрии — `ST_Within` с GeoJSON. `intersects` —
  `ST_Intersects`, `dwithin {geometry | lon, lat, distance}` — метры по географии.
- `is_me`, `is_my_subordinate`, `in_my_unit` (поле-подразделение — подразделения
  пользователя, поле-пользователь — `user.unitMemberIds`).
- Макросы `@me`, `@my_unit`, `@my_units`, `@my_territories`, `@today`, `@now`;
  `@my_unit` у сотрудника без подразделения ничему не равен.
- `@param:<name>` — значение из `ctx.params`, иначе `default` параметра (может
  быть макросом). Не заданный необязательный параметр **снимает условие**
  (группа `or` с таким условием снимается целиком, её параметры откатываются);
  обязательный — ошибка.

## Язык выражений

Pratt-парсер (`src/expr`), типизация по схеме, ошибки с позицией и подсказкой.
Операторы `+ - * / %` (деление вещественное, на ноль — пусто), `= != <> == < <= > >=`,
`and or not && !`, `in (…)`, `like`, `is [not] null`, `||`; `case(when … then …, else …)`
и `case when … end`. Функции v1: числа (`abs round floor ceil coalesce nullif
greatest least safe_div`), строки (`lower upper trim length substr replace concat
split_part regex_match regex_extract starts_with contains`), даты (`now today date
date_trunc date_add date_diff year quarter month week day dow hour format_date`),
`if`, гео (`st_distance` м, `st_within st_intersects st_area` км² `st_length` км
`st_buffer` м `st_centroid st_x st_y st_point`), `user_attr('ключ')`; агрегаты
только в мерах сводки (`count count_distinct sum avg min max median
percentile(x, p) string_agg`), оконные — только шагом `window`.

Ошибки времени выполнения, которые раскрыли бы данные или ломали запрос,
заменены пустым значением: `date(строка)`, строка → ссылка, `substr` с
отрицательной длиной, `split_part(…, 0)`, деление на ноль.

## Шаги

`filter`, `compute` (поля шага видят предыдущие поля того же шага), `aggregate`
(интервалы дат — местные; меры `count … string_agg`, `p90`, `p95`, `first`/`last`
по текущей сортировке или порядку добавления `_id`, `expr`, условные меры
`FILTER (WHERE …)`), `window` (`orderBy: ['поле desc']`), `sort`, `limit`,
`select` (скрытые системные поля и поля сортировки сохраняются), `join` (все
виды; одинаковые имена в результате — `alias.поле`), `union` (по именам;
недостающие поля — пусто), `sample`, `unnest` (строки с пустым списком
остаются с пустым значением). `spatial` и `pivot` — ошибка «не поддерживается в
фазе 1»; `relationId` соединения пока не используется (условие — `on`).

## Результат

`fields[]` — имя, тип поля, семантика, подпись, формат (из схемы датасета или
выведенные). Геометрия отдаётся GeoJSON (`ST_AsGeoJSON(…)::json`). В режиме
`rowMeta` без сводки первыми идут `_id` и `_ver`. Драйвер `postgres` отдаёт
`bigint` и `numeric` строками, `date` — объектом `Date` (полночь UTC): API
приводит значения по типу поля результата.

## Ключ кэша

`cacheKeyParts`: нормализованная спецификация (канонический JSON), версии и
политики всех датасетов-источников, спецификации сохранённых запросов,
использованные значения параметров и пользователя, момент до минуты (если
запрос зависит от «сейчас»), пояс, предел строк, режим. Новая версия датасета
или другая политика — другой ключ (инвалидация по версии, P1-E04 S03).

## Сырой SQL (SQL-лаборатория)

`06-analytics-engine.md` §6, `17-security.md` §4. Пользователь пишет обычный
SELECT по «человеческим» именам — названиям датасетов и подписям полей:

```sql
SELECT "Район", count(*) FROM "Происшествия" WHERE "Дата" >= {{с}} GROUP BY 1
```

Компилятор разбирает текст настоящим разборщиком Postgres, проверяет каждый узел
дерева по белым спискам и переписывает запрос: имя датасета → подзапрос с
политиками пользователя (тот же `datasetRelation`, что у QuerySpec: политика
строк с барьером `OFFSET 0`, маски, без скрытых полей и удалённых строк),
подписи → ключи, `{{параметр}}` → `$n`. До базы доходит только переписанный
запрос; любой отказ — `QueryCompileError` с `path: ['sql']`, понятным
сообщением, `position` (индекс строки запроса) и подсказкой.

### Как вызывать

```ts
import { compileRawSql, rawSqlErrorPosition, rawSqlTables } from '@kchs/query'

// 1. Какие таблицы упомянуты (без CTE) — загрузить только эти датасеты с политиками
const names = await rawSqlTables(sql)              // ['Происшествия', 'регионы']
// 2. Компиляция: датасеты, доступные пользователю, с именами таблиц
const compiled = await compileRawSql(sql, {
  datasets,        // SqlDataset[]: ResolvedDataset + name (+ aliases)
  user, now, timezone, territoryDescendants, maxRows, defaultTimeoutMs,
  params,          // значения {{…}}
  paramDefs,       // объявления из QuerySpec.params: тип, default (в т. ч. макрос), required
})
// 3. Выполнение — как у QuerySpec, плюс пояс сеанса
await sql.begin('read only', async (tx) => {
  await tx.unsafe('SET LOCAL ROLE kchs_query')    // или пул роли kchs_query
  await tx`SELECT set_config('statement_timeout', ${String(compiled.timeoutMs)}, true)`
  await tx`SELECT set_config('TimeZone', ${compiled.timezone}, true)`
  const rows = await tx.unsafe(compiled.sql, compiled.params)
})
// 4. Ошибка Postgres при выполнении: error.position (с 1) → место в тексте пользователя
const at = rawSqlErrorPosition(compiled, Number(error.position))
```

`rawSqlTables` возвращает имена, как их видит Postgres (без кавычек — латиница в
нижнем регистре), и уже проверяет запрос; сопоставление с датасетами —
в `compileRawSql` (выше — только чтобы не грузить политики всех датасетов).

`CompiledRawSql`: `sql` (запрос в обёртке `SELECT * FROM (…) AS "__kchs_sql"
LIMIT maxRows + 1`), `params`, `countSql`/`countParams`, `maxRows`, `timeoutMs`,
`timezone`, `datasets` (идентификаторы), `cacheKeyParts` (как у QuerySpec: текст
запроса, объявления и использованные значения параметров, версии и политики
датасетов, пользователь, минута — если есть `now()`/`CURRENT_DATE`),
`cacheable` (false при `random()`, `gen_random_uuid()`), `sourceMap` и `fields`:
столбцы по порядку — имя (как назовёт Postgres) и описание поля датасета, если
столбец — прямая ссылка на поле (в том числе через CTE и подзапросы); `null` —
состав известен только после выполнения (звёздочка над функцией, USING).

### Разборщик

npm-пакет [`libpg-query`](https://github.com/constructive-io/libpg-query-node)
`^17.7.4` (dist-tag `pg17`, libpg_query 17-6.1.0): грамматика Postgres 17 —
та же, что у образа базы (`kchs/postgres:17-3.5`), поэтому разборщик и сервер
видят запрос одинаково. Сборка — только WASM: работает в Node 22 без сборки
нативного кода и без node-gyp. Модуль загружается динамическим `import()` при
первом сыром SQL (при импорте он компилирует WASM, остальным путям API не нужен).
Для бандла API (`apps/api/scripts/build.mjs`) пакет должен оставаться внешним —
`libpg-query.wasm` ищется рядом с модулем в `node_modules`: при подключении SQL-
лаборатории добавить `libpg-query` в зависимости `apps/api`.

### Имена

- **Таблица** — название датасета (`SqlDataset.name`) или его `aliases`: сначала
  точное совпадение, затем без учёта регистра. Правила Postgres: имя без кавычек —
  латиница в нижнем регистре, кириллица как есть (`FROM Происшествия` работает);
  с пробелами и знаками — в двойных кавычках; длиннее 63 байт — усекается, как
  разборщиком. Схемы (`ds.`, `public.`, `pg_catalog.`…) запрещены. Датасет без
  доступа неотличим от несуществующего.
- **Поле** — ключ (`damage`) или подпись на любом языке (`"Ущерб"`, `"Damage"`):
  ключ, затем системный столбец, затем подпись точно, затем без учёта регистра.
  Подпись заменяется ключом; голое поле в списке выборки сохраняет имя
  (`"damage" AS "Ущерб"`), в выражениях имя столбца — по ключу (правило Postgres).
  Подписи работают и через `SELECT *` в CTE и подзапросах (там столбцы — ключи).
  Одна подпись у нескольких полей — ошибка с перечнем ключей.
- `SELECT *` — видимые поля; системные `_id`, `_ver`, `_created_at`,
  `_updated_at`, `_created_by`, `_updated_by` — в подзапросе, только если
  упомянуты. `_deleted_at`, `_import_id`, `xmin`, `ctid`, `tableoid` недоступны.
- Скрытое поле (по ключу или подписи, в том числе через CTE) — «Нет доступа к
  полю»; вычисляемое (`formula`, `lookup`, `rollup`) — пока недоступно;
  маскированное — только через маску (фильтр и сортировка — по маске).
- **Имена CTE** переименовываются в служебные `__kchs_cte_N` (со ссылками
  `"__kchs_cte_0" AS "имя"`): каждая ссылка на таблицу переписывается — на
  датасет или на служебное имя. Ошибись разбор областей видимости — Postgres не
  найдёт служебное имя, но не прочитает таблицу мимо политик.

### Параметры

`{{имя}}` (буквы, цифры, `_`; пробелы внутри скобок допустимы) вне строк,
комментариев и имён в кавычках → `$n`; значения только параметрами, повтор имени —
тот же `$n`. Объявленный в `paramDefs` тип — приведение (`($1::date)`), `list` —
массив (`WHERE "Вид" = ANY({{виды}})`), `default` может быть макросом
(`@my_territories`). Без объявления тип выводит Postgres по месту (сравнение с
полем, `LIMIT`), списки — по элементам (`text[]`, `uuid[]`, `double precision[]`).
Незаданный необязательный — `NULL` (условие не снимается, в отличие от
QuerySpec: пишите `{{x}} IS NULL OR …`), обязательный — ошибка. Позиционные
`$1` в тексте запрещены.

### Правила

- Один оператор; только `SELECT` — с `WITH` (и `RECURSIVE`), `UNION`/`INTERSECT`/
  `EXCEPT`, подзапросами, `LATERAL`, `VALUES`, оконными функциями, `GROUPING
  SETS`/`ROLLUP`/`CUBE`, `DISTINCT ON`, `FILTER`, `WITHIN GROUP`, `FETCH`.
- Отказ с причиной: `INSERT`/`UPDATE`/`DELETE`/`MERGE` (и в `WITH`), DDL,
  `TRUNCATE`, `COPY`, `DO`, `CALL`, `SET`/`RESET`/`SHOW`, `EXPLAIN`, `LOCK`,
  `GRANT`/`REVOKE`, транзакции, `PREPARE`/`EXECUTE`, курсоры, `LISTEN`/`NOTIFY`,
  `VACUUM`; `SELECT INTO`, `FOR UPDATE`/`SHARE`, `TABLE имя`, `ONLY`,
  `TABLESAMPLE`, XML, SQL/JSON-конструкции (`JSON_TABLE`, `JSON_VALUE`…),
  `SEARCH`/`CYCLE`, `OPERATOR(схема.оп)`, служебные `CURRENT_USER`,
  `SESSION_USER`, `CURRENT_SCHEMA` и т. п. (время — `CURRENT_DATE`… — можно).
- Каждый узел дерева и каждое его поле — из белого списка (`NODE_FIELDS` в
  `src/sql/analyze.ts`): неизвестная конструкция новой версии разборщика —
  отказ, а не пропуск.
- **Функции** — белый список (`src/sql/allowlist.ts`): агрегаты, оконные,
  математика, строки (с `unaccent`, `pg_trgm`, полнотекстовым поиском), даты,
  чтение и сборка JSON, массивы и `generate_series`, PostGIS для чтения и анализа.
  Имя сравнивается точно (встроенные — в нижнем регистре), схема — только
  `pg_catalog`. Чёрный список (без учёта регистра) даёт причину «запрещена»:
  `pg_*` (`pg_sleep*`, `pg_read_*`, `pg_ls_*`, `pg_stat_*`, `pg_advisory*`,
  `pg_terminate_backend`, `pg_cancel_backend`…), `set_config`, `current_setting`,
  `dblink*`, `lo_*`, `txid*`, `nextval`/`setval`/`currval`/`lastval`, всё с `xml`
  (`query_to_xml`…), `ts_stat`, `ts_rewrite`, `has_*`, `to_reg*`, `version`,
  `postgis_*`, `st_estimatedextent` и др.
- **Типы в приведениях** — белый список: числа, строки, `bool`, даты и время,
  `interval`, `uuid`, `json`/`jsonb`/`jsonpath`, `bytea`, `bit`, `tsvector`/
  `tsquery`, `geometry`/`geography`/`box2d`/`box3d` (с массивами). Запрещены
  `reg*` (`'pg_sleep'::regproc`, `'…'::regclass` — поиск по каталогу), `xml`,
  `oid`, составные типы таблиц.
- **Защита в глубину**: переписанный запрос разбирается снова — один SELECT,
  таблицы только `ds.t_…` датасетов запроса и служебные CTE, номера параметров в
  пределах значений; иначе исключение (ошибка программиста), запрос не
  выполняется. Недопустимые символы (NUL, одиночные суррогаты) и текст длиннее
  100 000 символов отклоняются до разбора; слишком глубокая вложенность —
  понятная ошибка.

### Ограничения

- Память выражений ограничивают только `statement_timeout` и ресурсы сервера:
  `lpad(x, 1e9)`, `string_agg` по `generate_series` и т. п. могут занять до ~1 ГБ
  на значение. Барьера для политик `all`/`none` нет — как у QuerySpec.
- Геометрия в результате — как вернёт драйвер (EWKB hex); для GeoJSON —
  `ST_AsGeoJSON(…)::json`.
- USING по подписи — ошибка (у имён USING нет позиций для замены), пишите ключ;
  переименование столбцов датасета в алиасе (`AS p(a, b)`) не поддерживается.
- Пояс запроса — сеанса: вызывающий ставит `TimeZone` (`compiled.timezone`),
  иначе даты считаются в поясе базы.

## Тесты

```bash
pnpm --filter @kchs/query test                  # выражения, эталоны SQL, ошибки
KCHS_TEST_SLOT=8 pnpm --filter @kchs/query test # и выполнение на Postgres
```

- `test/expr.test.ts` — лексер, парсер, типы, SQL и ошибки выражений.
- `test/golden.test.ts` — эталоны «спецификация → SQL + параметры» в
  `test/__snapshots__`; каждый параметр упомянут в SQL, строки пользователя в
  текст SQL не попадают.
- `test/errors.test.ts`, `test/compile.test.ts` — ошибки с путями, источники,
  поля результата, подсчёт, ключ кэша, `checkExpression`.
- `test/execute.test.ts` — выполнение на Postgres/PostGIS под `kchs_query`:
  фильтры всех типов, пояс, сводки, окна, соединения, политики строк и
  столбцов. Нужна база с ролями из `infra/compose/postgres/init`: строка
  подключения роли `kchs_app` в `KCHS_QUERY_TEST_DATABASE_URL` или
  `KCHS_TEST_SLOT=N` (база `kchs_test_N` по `DATABASE_URL` из окружения или
  корневого `.env`; создаётся `bash apps/api/scripts/test-slot.sh N`). Без них
  набор пропускается. Таблицы `ds.t_qtest_*` создаются и удаляются тестом
  (схема и данные — `test/db.ts`).
- `test/raw-sql.test.ts` — сырой SQL без базы: «атакующие» запросы (больше 30,
  каждый — отказ с ожидаемым сообщением и позицией), эталоны переписывания в
  `test/__snapshots__`, поля результата, ключ кэша, параметры, ошибки с позицией,
  карта участков, лексические помощники.
- `test/raw-sql-execute.test.ts` — сырой SQL на Postgres под `kchs_query`
  (таблицы `ds.t_rawsql_*`): имена и подписи, политика строк при любых формах
  обращения (CTE, самосоединение, UNION, подзапрос, барьер `OFFSET 0`), маски и
  скрытые поля (в том числе в `row_to_json` строки), параметры, пояс, предел
  строк, позиции ошибок Postgres; `pg_sleep` во всех формах до базы не доходит, а
  тяжёлый разрешённый запрос обрывает `statement_timeout`.
