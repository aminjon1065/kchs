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
`{"kind": "dataset", "id"}`, `{"kind": "query", "id"}` (сохранённый запрос как подзапрос), `{"kind": "system", "name": "tasks|documents|meetings|events"}` (системные датасеты), `{"kind": "inline", "rows": [...]}` (небольшие константы), `{"kind": "sql", "sql": "..."}` (только для режима SQL и внутри доверенных объектов).

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
| `spatial` | `op: buffer|intersects|within|dwithin|nearest|centroid|area|length|assign_territory|spatial_join|grid|hexgrid|dissolve|clip`, `params`, `target?` (датасет/слой/геометрия) |
| `unnest` | `field` (массивы) |
| `sample` | `n` или `fraction` (для предпросмотров) |

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

Функции (минимальный набор v1): **числа** `abs, round(x, n), floor, ceil, coalesce, nullif, greatest, least, safe_div(a,b)`; **строки** `lower, upper, trim, length, substr, replace, concat, split_part, regex_match, regex_extract, starts_with, contains`; **даты** `now, today, date(x), date_trunc(unit, x), date_add(x, n, unit), date_diff(a, b, unit), year, quarter, month, week, day, dow, hour, format_date(x, fmt), working_days_between(a, b), add_working_days(x, n)`; **условия** `if, case(when…then…, else)`; **агрегаты** (только в `measures`/`expr` внутри aggregate) `count, count_distinct, sum, avg, min, max, median, percentile(x, p), string_agg(x, sep)`; **окно** — через шаг `window`; **гео** `st_distance(a, b)` (м), `st_within(a, b)`, `st_intersects`, `st_area` (км²), `st_length` (км), `st_buffer(g, m)`, `st_centroid`, `st_x`, `st_y`, `st_point(lon, lat)`; **справочники** `lookup_label(field)`, `territory_level(field, level)` (родитель уровня), `territory_name(field)`; **пользователь** `user_attr('territory_codes')`.

Типизация: числовые/строковые/логические/дата/геометрия/массив; неявные приведения только число→строка в `concat`. Ошибки — позиция, ожидаемый тип, подсказка.

Тот же язык — в вычисляемых полях, политиках строк (без агрегатов), показателях, условиях автоматизации (над объектом события: `object.fields.amount > 100000 && actor.unit == 'legal'`), шаблонах отчётов (`{{ round(metric('incidents', period), 0) }}`).
