# Контракт: QuerySpec и язык выражений

## QuerySpec v1

```json
{
  "version": 1,
  "source": {"kind": "dataset", "id": "01J...", "alias": "inc"},
  "steps": [
    {"type": "filter", "where": {"and": [
      {"field": "inc.occurred_at", "op": "relative", "value": {"unit": "month", "from": -12, "to": 0}},
      {"field": "inc.territory_id", "op": "within", "value": "@param:territory"}
    ]}},
    {"type": "join", "source": {"kind": "dataset", "id": "01J...reg", "alias": "reg"},
     "on": [{"left": "inc.territory_id", "right": "reg.id"}], "kind": "left"},
    {"type": "compute", "fields": [
      {"name": "per_100k", "expr": "count() / reg.population * 100000", "type": "number"}
    ]},
    {"type": "aggregate",
     "groupBy": [{"field": "inc.occurred_at", "bucket": "month", "alias": "month"}, {"field": "reg.name", "alias": "region"}],
     "measures": [
       {"alias": "incidents", "agg": "count"},
       {"alias": "damage", "agg": "sum", "field": "inc.damage"},
       {"alias": "per_100k", "agg": "expr", "expr": "count() / max(reg.population) * 100000"}
     ]},
    {"type": "window", "fields": [{"alias": "incidents_prev", "fn": "lag", "field": "incidents", "partitionBy": ["region"], "orderBy": ["month"]}]},
    {"type": "sort", "by": [{"field": "month", "dir": "asc"}, {"field": "incidents", "dir": "desc"}]},
    {"type": "limit", "limit": 5000, "offset": 0}
  ],
  "params": {"territory": {"type": "territory", "default": "@my_territories", "label": {"ru": "Территория"}}},
  "options": {"timeoutMs": 30000, "cache": true, "approxCount": true}
}
```

### Источники
`{"kind": "dataset", "id"}`, `{"kind": "query", "id"}` (сохранённый запрос как подзапрос), `{"kind": "system", "name": "tasks|instructions|documents|meetings|events|territories"}` (системные датасеты; `territories` — справочник территорий с границами, ADR-0069, и населением, ADR-0077; `instructions` — поручения с состоянием контроля исполнения, ADR-0082), `{"kind": "inline", "rows": [...]}` (небольшие константы), `{"kind": "sql", "sql": "..."}` (только для режима SQL и внутри доверенных объектов).

### Шаги
| type | Поля |
|---|---|
| `filter` | `where` (формат фильтра) |
| `join` | `source`, `on[]`, `kind: inner|left|right|full`, `relationId?` (использовать объявленную связь) |
| `compute` | `fields[{name, expr, type}]` |
| `aggregate` | `groupBy[{field, bucket?: year|quarter|month|week|day|hour, alias}]`, `measures[{alias, agg: count|count_distinct|sum|avg|min|max|median|p90|p95|first|last|expr|string_agg, field?, expr?, filter?}]` |
| `window` | `fields[{alias, fn: lag|lead|running_sum|rank|dense_rank|row_number|moving_avg, field, partitionBy, orderBy, n?}]` |
| `sort` | `by[{field, dir, nulls?}]` |
| `limit` | `limit`, `offset` |
| `select` | `fields[]` (сузить/переименовать) |
| `pivot` | `rows[]`, `columns`, `measure` (ограниченно; иначе клиент) |
| `union` | `source`, `mode: all|distinct` |
| `spatial` | `op: buffer|intersects|within|dwithin|nearest|centroid|area|length|assign_territory|spatial_join|grid|hexgrid|dissolve|clip`, `params`, `target?` (датасет/запрос/территории/геометрия; слой — позже) — см. «Шаг spatial» |
| `unnest` | `field` (массивы) |
| `sample` | `n` или `fraction` (для предпросмотров) |

### Шаг spatial

Метрические величины считаются по `geography` в WGS 84: расстояния и размеры — метры, площадь — км², длина — км. Поле геометрии — `params.field` или единственное поле геометрии; числа можно задать параметром `@param:имя`. Неизвестный параметр операции — ошибка с путём (ADR-0069).

| op | params | цель | результат |
|---|---|---|---|
| `buffer` | `distance` (м) или `distanceField` (числовое поле, м) | — | геометрия заменяется зоной вокруг неё |
| `centroid` | `inside?` — точка на поверхности | — | геометрия заменяется точкой |
| `area`, `length` | `as?` (`area_km2`, `length_km`) | — | + поле, км² или км |
| `intersects`, `within` | `negate?` | нужна | отбор строк по отношению к цели |
| `dwithin` | `distance` (м), `negate?` | нужна | отбор строк в радиусе от цели |
| `nearest` | `limit?` (1–100), `maxDistance?` (м), `fields?` (поля цели), `as?` (`distance_m`) | нужна | + поля ближайших объектов цели, расстояние, `nearest_rank` при `limit > 1`; для цели-геометрии — только расстояние |
| `assign_territory` | `level`, `as?` (`<уровень>_id`) | — | + поле-территория уровня, покрывающая объект |
| `spatial_join` | `predicate?` (`intersects|contains|within|dwithin`), `distance?` (м, для `dwithin`), `measures?` | датасет, запрос или территории | + меры по связанным объектам цели |
| `grid`, `hexgrid` | `size` (м, от 10), `measures?` | — | непустые ячейки: `cell` (`i:j`), граница, меры |
| `dissolve` | `by?` (поля), `measures?` | — | группы: поля `by`, объединённая геометрия, меры |
| `clip` | — | нужна | часть геометрии внутри цели той же размерности |

`measures` — `[{alias, agg: count|count_distinct|sum|avg|min|max, field?}]`, по умолчанию — `[{"alias": "count", "agg": "count"}]`. Имя добавляемого поля по умолчанию при совпадении с полем данных получает номер (`area_km2_2`); явное `as` совпадать с полем не может.

Цель (`target`): `{"kind": "dataset"|"query", "id", "alias"?, "field"?, "filter"?}` — с политиками смотрящего, как источник соединения (`filter` — в формате фильтра над полями цели); `{"kind": "system", "name"}`; `{"kind": "territory", "id"|"ids"|"level"}` — справочник территорий с границами; `{"kind": "geometry", "geometry"}` или геометрия GeoJSON без обёртки.

```json
{"type": "spatial", "op": "spatial_join",
 "params": {"measures": [{"alias": "incidents", "agg": "count"}, {"alias": "damage", "agg": "sum", "field": "inc.damage"}]},
 "target": {"kind": "dataset", "id": "01J...inc", "alias": "inc", "filter": {"field": "kind", "op": "eq", "value": "fire"}}}
```

### Правила компиляции
- Ссылки на поля — `alias.field` или `field` (уникальное); физические имена подставляет компилятор.
- Политики строк/столбцов применяются к каждому источнику-датасету до шагов.
- `aggregate` без `groupBy` — одна строка. После `aggregate` доступны только алиасы результата.
- `spatial` компилируется в PostGIS; геометрии в результате отдаются как GeoJSON (или WKB-hex по опции).
- Компилятор проверяет типы выражений и возвращает ошибки с путём в спецификации.
- Результат: `{"fields": [{"name","type","semantic","format"}], "rows": [[...]], "rowCount", "approx", "truncated", "durationMs", "cached", "sql"?}` (`sql` — только для пользователей со способностью `data.sql`).

## Язык выражений

Синтаксис: инфиксный, регистронезависимые функции, строки в `'…'`, поля как идентификаторы (`damage`, `reg.population`, `"поле с пробелами"`), параметры `@param:name`, макросы `@me`, `@today`.

Операторы: `+ - * / %`, `= != < <= > >=`, `and or not`, `in (…)`, `like`, `is null`, `?:`-условие через `if(cond, a, b)`, конкатенация `||`.

Функции (минимальный набор v1): **числа** `abs, round(x, n), floor, ceil, coalesce, nullif, greatest, least, safe_div(a,b)`; **строки** `lower, upper, trim, length, substr, replace, concat, split_part, regex_match, regex_extract, starts_with, contains`; **даты** `now, today, date(x), date_trunc(unit, x), date_add(x, n, unit), date_diff(a, b, unit), year, quarter, month, week, day, dow, hour, format_date(x, fmt), working_days_between(a, b), add_working_days(x, n)`; **условия** `if, case(when…then…, else)`; **агрегаты** (только в `measures`/`expr` внутри aggregate) `count, count_distinct, sum, avg, min, max, median, percentile(x, p), string_agg(x, sep)`; **окно** — через шаг `window`; **гео** `st_distance(a, b)` (м), `st_within(a, b)`, `st_intersects`, `st_area` (км²), `st_length` (км), `st_buffer(g, m)`, `st_centroid`, `st_x`, `st_y`, `st_point(lon, lat)`; **справочники** `lookup_label(field)`, `territory_level(field, level)` (родитель уровня: `country|region|district|jamoat|settlement`), `territory_name(field)` — аргумент территориальных функций: поле-территория или код территории текстом (ADR-0057); **пользователь** `user_attr('territory_codes')`.

Типизация: числовые/строковые/логические/дата/геометрия/массив; неявные приведения только число→строка в `concat`. Ошибки — позиция, ожидаемый тип, подсказка.

Тот же язык — в вычисляемых полях, политиках строк (без агрегатов), показателях, условиях автоматизации (над объектом события: `object.fields.amount > 100000 && actor.unit == 'legal'`), шаблонах отчётов (`{{ round(metric('incidents', period), 0) }}`).
