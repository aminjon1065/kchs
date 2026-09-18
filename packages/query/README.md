# @kchs/query

Язык выражений и компилятор QuerySpec → SQL (P1-E04 S01–S03;
`docs/contracts/query-spec.md`, `docs/02-architecture/06-analytics-engine.md` §5).
Один компилятор обслуживает таблицу датасета, исследование, графики, показатели,
экспорт и API. Пакет чистый: без базы и сети, зависит только от `@kchs/contracts`.
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
`sql` — ошибка: сырой SQL идёт через SQL-лабораторию (P1-E04 S04).

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
  набор пропускается. Таблицы `ds.t_qtest_*` создаются и удаляются тестом.
